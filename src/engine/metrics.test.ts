import { describe, expect, it } from 'vitest';
import { distribution, percentile, ratePerSecond, requestMetrics, summarize } from './metrics';
import { simulatePanel } from './simulator';
import { testConfig } from './testUtils';

describe('metric helpers', () => {
  it('uses nearest-rank percentiles and N/A for empty samples', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 99)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(distribution([])).toEqual({ count: 0, mean: null, p50: null, p90: null, p99: null, max: null });
    expect(ratePerSecond(5, 0)).toBeNull();
    expect(ratePerSecond(5, null)).toBeNull();
    expect(ratePerSecond(5, 2000)).toBe(2.5);
  });
});

describe('hand-checkable trace', () => {
  // Cost: 10 ms overhead + 1 ms per token. A (P=20, G=3) arrives at 0, B (P=10, G=1) at 5.
  // Iteration 0 [0, 30):   prefill A (20)                 -> A token 1 at 30
  // Iteration 1 [30, 51):  decode A + prefill B (1 + 10)   -> A token 2, B token 1 (B done) at 51
  // Iteration 2 [51, 62):  decode A                        -> A token 3 at 62 (A done)
  const config = testConfig({ requests: [['A', 0, 20, 3], ['B', 5, 10, 1]] });
  const result = simulatePanel(config, 'B');

  it('matches the hand-computed schedule', () => {
    expect(result.iterations.map(it => [it.startMs, it.endMs])).toEqual([[0, 30], [30, 51], [51, 62]]);
  });

  it('computes queue delay, TTFT, ITL, TPOT, and E2E from event timestamps', () => {
    const [a, b] = requestMetrics(result, { ttftMs: 40, tpotMs: 20 });
    expect(a).toMatchObject({ status: 'completed', queueDelayMs: 0, ttftMs: 30, e2eMs: 62, itlsMs: [21, 11], maxItlMs: 21, tpotMs: 16, slo: 'met' });
    expect(b).toMatchObject({ status: 'completed', queueDelayMs: 25, ttftMs: 46, e2eMs: 46, itlsMs: [], maxItlMs: null, tpotMs: null, slo: 'missed-ttft' });
  });

  it('summarizes counts, throughput over the observation window, and SLO goodput', () => {
    const s = summarize(result, { ttftMs: 40, tpotMs: 20 });
    expect(s.counts.completed).toBe(2);
    expect(s.windowMs).toBe(62);
    expect(s.outputTokens).toBe(4);
    expect(s.outputTokensPerSecond).toBeCloseTo(4000 / 62);
    expect(s.requestsPerSecond).toBeCloseTo(2000 / 62);
    expect(s.ttft).toMatchObject({ count: 2, p50: 30, max: 46 });
    expect(s.tpot).toMatchObject({ count: 1, p50: 16 });
    expect(s.itl).toMatchObject({ count: 2, p50: 11, max: 21 });
    expect(s.slo).toMatchObject({ met: 1, missedTtft: 1, attainment: 0.5 });
    expect(s.slo.goodputTokensPerSecond).toBeCloseTo(3000 / 62);
    expect(s.busyMs).toBe(62);
  });

  it('reports partial progress as of a cursor without treating pending requests as failures', () => {
    const s = summarize(result, { ttftMs: 40, tpotMs: 20 }, 40);
    expect(s.counts).toMatchObject({ completed: 0, running: 2 });
    expect(s.slo).toMatchObject({ met: 0, pending: 2 });
    expect(s.ttft).toMatchObject({ count: 1, p50: 30 });
    expect(s.e2e.count).toBe(0);
    expect(s.e2e.p50).toBeNull();
    const before = summarize(result, { ttftMs: 40, tpotMs: 20 }, -1);
    expect(before.windowMs).toBeNull();
    expect(before.outputTokensPerSecond).toBeNull();
  });

  it('keeps infeasible requests in the denominator', () => {
    const blocked = testConfig({ blocks: 2, requests: [['BIG', 0, 100, 2], ['OK', 0, 10, 2]] });
    const s = summarize(simulatePanel(blocked, 'B'), { ttftMs: 1000, tpotMs: 1000 });
    expect(s.counts).toMatchObject({ infeasible: 1, completed: 1, total: 2 });
    expect(s.slo.attainment).toBe(0.5);
  });
});
