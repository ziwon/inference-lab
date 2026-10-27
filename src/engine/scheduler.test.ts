import { describe, expect, it } from 'vitest';
import { roundRobinOrder, selectBatch } from './policies';
import { createReplayer, eventMoments } from './replay';
import { digestEvents } from './serialization';
import { simulateBoth, simulatePanel } from './simulator';
import { testConfig } from './testUtils';
import type { SimResult } from './types';

function eventsOf(result: SimResult, type: string) {
  return result.events.filter(e => e.type === type);
}

describe('admission and reservation', () => {
  it('blocks the FIFO head on reservation capacity and still completes every feasible request', () => {
    // 10 blocks. Each request reserves ceil((48 + 33 - 1) / 16) = 5 blocks, so only two run at once.
    const config = testConfig({ blocks: 10, requests: [['R1', 0, 48, 33], ['R2', 0, 48, 33], ['R3', 0, 48, 33], ['R4', 1, 16, 2]] });
    for (const panel of ['A', 'B'] as const) {
      const result = simulatePanel(config, panel, { checkInvariants: true });
      expect(result.status).toBe('completed');
      expect(eventsOf(result, 'complete')).toHaveLength(4);
      const blocked = result.events.find(e => e.type === 'admission-blocked');
      expect(blocked).toMatchObject({ req: 2, reason: 'kv-reservation', neededBlocks: 5, freeBlocks: 0 });
      // R4 (small) waits behind R3 even though it would fit: head-of-line blocking.
      const it = result.iterations.find(i => i.decisions.some(d => d.req === 3 && d.code === 'queue-head-of-line'));
      expect(it).toBeDefined();
      expect(result.peakReservedBlocks).toBeLessThanOrEqual(10);
    }
  });

  it('marks a request infeasible when it cannot fit an empty pool and unblocks the queue', () => {
    const config = testConfig({ blocks: 4, requests: [['BIG', 0, 100, 10], ['OK', 0, 20, 5]] });
    const result = simulatePanel(config, 'B', { checkInvariants: true });
    expect(result.status).toBe('completed');
    expect(result.events.find(e => e.type === 'infeasible')).toMatchObject({ req: 0, neededBlocks: 7, totalBlocks: 4 });
    expect(eventsOf(result, 'complete')).toEqual([expect.objectContaining({ req: 1 })]);
    expect(eventsOf(result, 'release')).toHaveLength(1);
  });

  it('respects the active-sequence limit at admission', () => {
    const config = testConfig({ scheduler: { maxActiveSequences: 2 }, requests: [['R1', 0, 10, 5], ['R2', 0, 10, 5], ['R3', 0, 10, 5]] });
    const result = simulatePanel(config, 'A', { checkInvariants: true });
    expect(result.events.find(e => e.type === 'admission-blocked')).toMatchObject({ req: 2, reason: 'sequence-limit', active: 2, limit: 2 });
    for (const it of result.iterations) expect(it.sequencesScheduled).toBeLessThanOrEqual(2);
    expect(result.status).toBe('completed');
  });
});

describe('budgets', () => {
  it('accepts a whole prompt exactly equal to the token budget and rejects one token more', () => {
    const exact = testConfig({ scheduler: { tokenBudget: 64 }, requests: [['R', 0, 64, 2]] });
    expect(simulatePanel(exact, 'A').status).toBe('completed');
    expect(simulatePanel(exact, 'A').iterations[0].tokensScheduled).toBe(64);
    const over = testConfig({ scheduler: { tokenBudget: 63 }, requests: [['R', 0, 64, 2]] });
    const result = simulatePanel(over, 'A');
    expect(result.status).toBe('invalid');
    expect(result.statusReason).toMatch(/Incompatible A\/B configuration/);
    // The chunked panel is unaffected: it splits the prompt.
    expect(simulatePanel(over, 'B').status).toBe('completed');
  });

  it('fills the token budget exactly with decodes plus a chunk', () => {
    // Two requests decode while a third prefills: budget 10 = 2 decodes + 8-token chunk.
    const config = testConfig({ scheduler: { tokenBudget: 10, maxPrefillChunk: 512 }, requests: [['D1', 0, 4, 20], ['D2', 0, 4, 20], ['P', 30, 40, 2]] });
    const result = simulatePanel(config, 'B', { checkInvariants: true });
    const mixed = result.iterations.find(it => it.items.some(i => i.req === 2));
    expect(mixed?.tokensScheduled).toBe(10);
    expect(mixed?.items.find(i => i.req === 2)).toMatchObject({ tokens: 8, limitedBy: 'token-budget' });
    for (const it of result.iterations) expect(it.tokensScheduled).toBeLessThanOrEqual(10);
  });

  it('defers a whole prompt that does not fit and lets decodes use the remaining budget', () => {
    const config = testConfig({ scheduler: { tokenBudget: 60 }, requests: [['D', 0, 4, 30], ['P1', 15, 40, 2], ['P2', 15, 50, 2]] });
    const result = simulatePanel(config, 'A', { checkInvariants: true });
    const it = result.iterations.find(i => i.items.some(x => x.req === 1));
    expect(it?.decisions.find(d => d.req === 2)).toMatchObject({ code: 'defer-token-budget', tokens: 50, available: 20 });
    expect(it?.items.some(x => x.req === 0 && x.kind === 'decode')).toBe(true);
    for (const i of result.iterations) expect(i.tokensScheduled).toBeLessThanOrEqual(60);
  });

  it('serves decodes round-robin by admission order when the budget cannot cover them', () => {
    const config = testConfig({ scheduler: { tokenBudget: 2, maxActiveSequences: 3 }, requests: [['R1', 0, 1, 6], ['R2', 0, 1, 6], ['R3', 0, 1, 6]] });
    const A = simulatePanel(config, 'A', { checkInvariants: true });
    const decodeOrder = (r: SimResult) => r.iterations.map(it => it.items.filter(i => i.kind === 'decode').map(i => i.req)).filter(x => x.length > 0).slice(0, 4);
    expect(decodeOrder(A)).toEqual([[0], [1, 2], [0, 1], [2, 0]]);
    // Both policies use the same rotation rule.
    const views = [0, 1, 2].map(req => ({ req, admitSeq: req, promptTokens: 1, prefilledTokens: 1, cachedTokens: 1, generatedTokens: 1, outputTokens: 6 }));
    expect(roundRobinOrder(views, -1).map(v => v.req)).toEqual([0, 1, 2]);
    expect(roundRobinOrder(views, 0).map(v => v.req)).toEqual([1, 2, 0]);
    expect(roundRobinOrder(views, 2).map(v => v.req)).toEqual([0, 1, 2]);
    const pa = selectBatch('whole-prefill', views, { tokenBudget: 2, maxActiveSequences: 3, maxPrefillChunk: 8 }, 1);
    const pb = selectBatch('chunked-prefill', views, { tokenBudget: 2, maxActiveSequences: 3, maxPrefillChunk: 8 }, 1);
    expect(pa.items.map(i => i.req)).toEqual([2, 0]);
    expect(pb.items.map(i => i.req)).toEqual([2, 0]);
    expect(pa.rrCursor).toBe(0);
  });

  it('never completes prefill and decodes the same request in one iteration', () => {
    const config = testConfig({ requests: [['R', 0, 10, 5]] });
    for (const panel of ['A', 'B'] as const) {
      const result = simulatePanel(config, panel);
      for (const it of result.iterations) expect(new Set(it.items.map(i => i.req)).size).toBe(it.items.length);
      expect(result.iterations[0].items).toHaveLength(1);
      expect(result.iterations[0].items[0].kind).toBe('prefill');
      expect(result.iterations[1].items[0].kind).toBe('decode');
    }
  });
});

describe('arrivals and ordering', () => {
  it('orders simultaneous arrivals by trace position and admits FIFO', () => {
    const config = testConfig({ requests: [['first', 5, 10, 2], ['second', 5, 10, 2], ['third', 5, 10, 2]] });
    const result = simulatePanel(config, 'A');
    expect(eventsOf(result, 'arrival').map(e => ('req' in e ? e.req : -1))).toEqual([0, 1, 2]);
    expect(eventsOf(result, 'admit').map(e => ('req' in e ? e.req : -1))).toEqual([0, 1, 2]);
    expect(result.events[0]).toMatchObject({ type: 'idle', t: 0, untilMs: 5 });
  });

  it('makes requests arriving during an iteration wait for the next boundary', () => {
    // First iteration: 10 + 100 = 110 ms. LATE arrives at 50 ms.
    const config = testConfig({ requests: [['R', 0, 100, 3], ['LATE', 50, 10, 2]] });
    const result = simulatePanel(config, 'B');
    const first = result.iterations[0];
    expect(first.endMs).toBe(110);
    expect(first.items.map(i => i.req)).toEqual([0]);
    const arrival = result.events.find(e => e.type === 'arrival' && e.req === 1)!;
    const admit = result.events.find(e => e.type === 'admit' && e.req === 1)!;
    expect(arrival.t).toBe(50);
    expect(admit.t).toBe(110);
    expect(result.iterations[1].items.map(i => i.req)).toContain(1);
  });

  it('keeps events causal and time-ordered', () => {
    const config = testConfig({ blocks: 12, requests: [['R1', 0, 40, 20], ['R2', 3, 90, 9], ['R3', 7, 15, 1], ['R4', 120, 30, 12]], scheduler: { tokenBudget: 128, maxPrefillChunk: 32 } });
    for (const panel of ['A', 'B'] as const) {
      const result = simulatePanel(config, panel, { checkInvariants: true });
      for (let i = 1; i < result.events.length; i++) expect(result.events[i].t).toBeGreaterThanOrEqual(result.events[i - 1].t);
      const order = ['arrival', 'admit', 'complete', 'release'];
      result.trace.forEach((_, req) => {
        const seq = result.events.filter(e => 'req' in e && e.req === req && order.includes(e.type));
        expect(seq.map(e => e.type)).toEqual(order);
        const times = seq.map(e => e.t);
        expect([...times].sort((a, b) => a - b)).toEqual(times);
      });
      result.iterations.forEach((it, i) => {
        expect(it.endMs).toBeGreaterThan(it.startMs);
        if (i > 0) expect(it.startMs).toBeGreaterThanOrEqual(result.iterations[i - 1].endMs);
      });
      expect(result.events[result.events.length - 1]).toMatchObject({ type: 'finished', status: 'completed' });
    }
  });
});

describe('determinism and replay', () => {
  const config = testConfig({ blocks: 20, requests: [['R1', 0, 60, 25], ['R2', 2, 120, 8], ['R3', 2, 30, 1], ['R4', 40, 70, 30], ['R5', 41, 10, 3]], scheduler: { tokenBudget: 128, maxPrefillChunk: 48 } });

  it('produces identical event logs for identical inputs', () => {
    const first = simulateBoth(config);
    const second = simulateBoth(structuredClone(config));
    expect(digestEvents(first.A.events)).toBe(digestEvents(second.A.events));
    expect(digestEvents(first.B.events)).toBe(digestEvents(second.B.events));
    expect(first.B.events).toEqual(second.B.events);
  });

  it('steps backward and forward to the same snapshots', () => {
    const result = simulatePanel(config, 'B');
    const replay = createReplayer(result, 16);
    const moments = eventMoments(result);
    const forward = moments.map(t => replay.snapshotAt(t));
    const backward = [...moments].reverse().map(t => replay.snapshotAt(t)).reverse();
    expect(backward).toEqual(forward);
    for (const snap of forward) {
      expect(snap.allocatedBlocks).toBeLessThanOrEqual(snap.reservedBlocks);
      expect(snap.reservedBlocks).toBeLessThanOrEqual(result.memory!.totalBlocks);
      expect(snap.allocatedBlocks).toBeGreaterThanOrEqual(0);
      for (const r of snap.requests) {
        if (r.phase !== 'complete') expect(r.allocatedBlocks).toBeLessThanOrEqual(r.reservedBlocks);
        expect(r.cachedTokens).toBeLessThanOrEqual(result.trace[r.req].promptTokens + result.trace[r.req].outputTokens - 1);
      }
    }
    const final = replay.snapshotAt(Infinity);
    expect(final.allocatedBlocks).toBe(0);
    expect(final.reservedBlocks).toBe(0);
    expect(final.requests.every(r => r.phase === 'complete')).toBe(true);
  });

  it('shows the iteration in flight with its allocation but uncommitted positions', () => {
    const result = simulatePanel(config, 'A');
    const replay = createReplayer(result, 16);
    const it = result.iterations[0];
    const mid = replay.snapshotAt((it.startMs + it.endMs) / 2);
    expect(mid.runningIteration).toBe(0);
    const item = it.items[0];
    expect(mid.requests[item.req].inFlightTokens).toBe(item.tokens);
    expect(mid.requests[item.req].cachedTokens).toBe(0);
    expect(mid.requests[item.req].allocatedBlocks).toBe(item.newBlocks.length);
  });
});
