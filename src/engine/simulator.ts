import { AllocatorError, BlockAllocator } from './allocator';
import { effectiveScheduler, LIMITS, validateConfig, validatePanel, validateTrace } from './config';
import { iterationCost } from './cost';
import { memoryModel } from './memory';
import { selectBatch, type ActiveRequestView } from './policies';
import { blocksFor, reservationBlocks } from './tokens';
import { buildTrace } from './workload';
import type { BlockedReason, Decision, IterationRecord, PanelId, SimConfig, SimEvent, SimResult, TraceRequest } from './types';

// Deterministic discrete-event simulation of one logical GPU serving a request trace.
//
// Ordering at a single timestamp t (an iteration boundary):
//   1. iteration-end for the iteration finishing at t (token emissions in batch order)
//   2. complete + release for requests that emitted their last token (batch order)
//   3. arrivals at exactly t (trace order)
//   4. admission (FIFO; infeasible heads are removed)
//   5. iteration-start for the next batch
// Arrivals strictly inside an iteration join the queue at their own timestamp but are only
// eligible for admission at the next boundary. Admitted work never interrupts a running iteration.

const MAX_LISTED_QUEUED = 64;

interface ReqState {
  P: number;
  G: number;
  admitSeq: number;
  prefilled: number;
  cached: number;
  generated: number;
  reserved: number;
}

export interface SimulateOptions {
  /** Run allocator invariant checks after every iteration (tests). */
  checkInvariants?: boolean;
}

export function simulatePanel(config: SimConfig, panel: PanelId, options: SimulateOptions = {}): SimResult {
  const trace = buildTrace(config);
  return simulateTrace(config, panel, trace, options);
}

export function simulateTrace(config: SimConfig, panel: PanelId, trace: TraceRequest[], options: SimulateOptions = {}): SimResult {
  const policy = config.panels[panel].policy;
  const scheduler = effectiveScheduler(config, panel);
  const issues = [...validateConfig(config), ...validateTrace(trace, config.architecture.maxContextLength)];
  if (issues.length === 0) issues.push(...validatePanel(config, panel, trace));
  const base: SimResult = {
    panel, policy, scheduler, status: 'invalid', statusReason: issues[0]?.message ?? '', issues, trace,
    memory: null, events: [], iterations: [], blockIds: trace.map(() => []), endMs: 0, peakAllocatedBlocks: 0, peakReservedBlocks: 0,
  };
  if (issues.length > 0) return base;

  const memory = memoryModel(config.architecture, config.precision, config.memory);
  const B = config.memory.blockSizeTokens;
  const allocator = new BlockAllocator(memory.totalBlocks);
  const events: SimEvent[] = [];
  const iterations: IterationRecord[] = [];
  const state: ReqState[] = trace.map(r => ({ P: r.promptTokens, G: r.outputTokens, admitSeq: -1, prefilled: 0, cached: 0, generated: 0, reserved: 0 }));
  const waiting: number[] = [];
  const active: number[] = [];
  let nextArrival = 0;
  let admitCounter = 0;
  let rrCursor = -1;
  let t = 0;
  let lastBlocked: { req: number; reason: BlockedReason } | null = null;
  let peakAllocated = 0;
  let peakReserved = 0;
  const blockIdsOf: number[][] = trace.map(() => []);

  const finish = (status: 'completed' | 'blocked', reason: string): SimResult => {
    events.push({ t, type: 'finished', status, reason });
    return { ...base, status, statusReason: reason, issues: [], memory, events, iterations, blockIds: blockIdsOf, endMs: t, peakAllocatedBlocks: peakAllocated, peakReservedBlocks: peakReserved };
  };

  const arriveUntil = (limit: number, inclusive: boolean) => {
    while (nextArrival < trace.length && (inclusive ? trace[nextArrival].arrivalMs <= limit : trace[nextArrival].arrivalMs < limit)) {
      events.push({ t: trace[nextArrival].arrivalMs, type: 'arrival', req: nextArrival });
      waiting.push(nextArrival);
      nextArrival++;
    }
  };

  const admit = () => {
    while (waiting.length > 0) {
      const head = waiting[0];
      const s = state[head];
      const need = reservationBlocks(s.P, s.G, B);
      if (need > allocator.totalBlocks) {
        events.push({ t, type: 'infeasible', req: head, neededBlocks: need, totalBlocks: allocator.totalBlocks });
        waiting.shift();
        lastBlocked = null;
        continue;
      }
      let reason: BlockedReason | null = null;
      if (active.length >= scheduler.maxActiveSequences) reason = 'sequence-limit';
      else if (!allocator.canReserve(need)) reason = 'kv-reservation';
      if (reason) {
        if (!lastBlocked || lastBlocked.req !== head || lastBlocked.reason !== reason) {
          events.push({ t, type: 'admission-blocked', req: head, reason, neededBlocks: need, freeBlocks: allocator.unreserved, active: active.length, limit: scheduler.maxActiveSequences });
          lastBlocked = { req: head, reason };
        }
        return;
      }
      allocator.reserve(head, need);
      s.reserved = need;
      s.admitSeq = admitCounter++;
      active.push(head);
      waiting.shift();
      lastBlocked = null;
      peakReserved = Math.max(peakReserved, allocator.reserved);
      events.push({ t, type: 'admit', req: head, reservedBlocks: need, poolReserved: allocator.reserved });
    }
  };

  const queuedDecisions = (): { decisions: Decision[]; omitted: number } => {
    const decisions: Decision[] = [];
    if (waiting.length === 0) return { decisions, omitted: 0 };
    const head = waiting[0];
    const hs = state[head];
    const need = reservationBlocks(hs.P, hs.G, B);
    const headCode = active.length >= scheduler.maxActiveSequences ? 'queue-sequence-limit' : 'queue-kv-reservation';
    decisions.push({ req: head, code: headCode, neededBlocks: need, available: headCode === 'queue-sequence-limit' ? scheduler.maxActiveSequences - active.length : allocator.unreserved });
    for (let i = 1; i < waiting.length && i < MAX_LISTED_QUEUED; i++) {
      const r = waiting[i];
      decisions.push({ req: r, code: 'queue-head-of-line', neededBlocks: reservationBlocks(state[r].P, state[r].G, B), available: allocator.unreserved, blockedBy: head });
    }
    return { decisions, omitted: Math.max(0, waiting.length - MAX_LISTED_QUEUED) };
  };

  try {
    for (;;) {
      arriveUntil(t, true);
      admit();

      const views: ActiveRequestView[] = active.map(req => {
        const s = state[req];
        return { req, admitSeq: s.admitSeq, promptTokens: s.P, prefilledTokens: s.prefilled, cachedTokens: s.cached, generatedTokens: s.generated, outputTokens: s.G };
      });
      const selection = selectBatch(policy, views, scheduler, rrCursor);

      if (selection.items.length === 0) {
        if (active.length > 0) return finish('blocked', 'The scheduler could not make progress with the active requests.');
        if (waiting.length > 0) return finish('blocked', 'Requests are waiting but none can be admitted to an empty engine.');
        if (nextArrival < trace.length) {
          const until = trace[nextArrival].arrivalMs;
          events.push({ t, type: 'idle', untilMs: until });
          t = until;
          continue;
        }
        return finish('completed', 'All feasible requests completed.');
      }
      if (iterations.length >= LIMITS.maxIterations) {
        return finish('blocked', `Stopped after ${LIMITS.maxIterations} iterations to keep the browser responsive.`);
      }
      rrCursor = selection.rrCursor;

      // Confirm KV allocations for every selected item before committing the iteration.
      const items = selection.items.map(item => {
        const s = state[item.req];
        const needed = blocksFor(s.cached + item.tokens, B) - blockIdsOf[item.req].length;
        const newBlocks = needed > 0 ? allocator.allocate(item.req, needed) : [];
        blockIdsOf[item.req].push(...newBlocks);
        return { ...item, newBlocks };
      });
      const cost = iterationCost(items, config.cost);
      if (!(cost.totalMs > 0) || !Number.isFinite(cost.totalMs)) {
        return finish('blocked', 'The cost model produced a non-positive iteration duration.');
      }
      const queued = queuedDecisions();
      const prefillTokens = items.filter(i => i.kind === 'prefill').reduce((sum, i) => sum + i.tokens, 0);
      const decodeTokens = items.filter(i => i.kind === 'decode').length;
      const end = t + cost.totalMs;
      const record: IterationRecord = {
        index: iterations.length,
        startMs: t,
        endMs: end,
        items,
        decisions: [...selection.decisions, ...queued.decisions],
        omittedQueued: queued.omitted,
        tokenBudget: scheduler.tokenBudget,
        tokensScheduled: prefillTokens + decodeTokens,
        sequenceLimit: scheduler.maxActiveSequences,
        sequencesScheduled: items.length,
        prefillTokens,
        decodeTokens,
        cost,
        allocatedBlocks: allocator.allocated,
        reservedBlocks: allocator.reserved,
        cachedTokensAtEnd: 0,
      };
      iterations.push(record);
      peakAllocated = Math.max(peakAllocated, allocator.allocated);
      events.push({ t, type: 'iteration-start', iteration: record });

      // Requests arriving while the iteration runs queue up but wait for the next boundary.
      arriveUntil(end, false);
      t = end;

      const emitted: { req: number; token: number }[] = [];
      const completed: number[] = [];
      for (const item of items) {
        const s = state[item.req];
        s.cached += item.tokens;
        if (item.kind === 'prefill') {
          s.prefilled += item.tokens;
          if (s.prefilled === s.P) { s.generated = 1; emitted.push({ req: item.req, token: 1 }); }
        } else {
          s.generated += 1;
          emitted.push({ req: item.req, token: s.generated });
        }
        if (s.generated === s.G) completed.push(item.req);
      }
      record.cachedTokensAtEnd = active.reduce((sum, req) => sum + state[req].cached, 0);
      events.push({ t, type: 'iteration-end', index: record.index, emitted });
      for (const req of completed) events.push({ t, type: 'complete', req });
      for (const req of completed) {
        const released = allocator.release(req);
        active.splice(active.indexOf(req), 1);
        events.push({ t, type: 'release', req, blocks: released.blocks, reservedBlocks: released.reservedBlocks });
      }
      if (options.checkInvariants) allocator.checkInvariants();
    }
  } catch (error) {
    if (error instanceof AllocatorError) return finish('blocked', `Allocator invariant violated: ${error.message}`);
    throw error;
  }
}

export interface PanelResults { A: SimResult; B: SimResult }

export function simulateBoth(config: SimConfig, options: SimulateOptions = {}): PanelResults {
  const trace = buildTrace(config);
  return { A: simulateTrace(config, 'A', trace, options), B: simulateTrace(config, 'B', trace, options) };
}
