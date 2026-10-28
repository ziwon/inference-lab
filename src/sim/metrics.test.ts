import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PanelRun, stateAt } from './engine.ts';
import { distribution, summarize } from './metrics.ts';
import { build, fixture, r } from './test-fixtures.ts';
import { nearestRank } from './units.ts';

const cmp = build(fixture({ trace: [r('a', 0, 4, 3), r('b', 0.5, 2, 1)] }));
const slo = cmp.config.slo;
const run = cmp.panels.A;
const at = (p: PanelRun, timeUs: number) => stateAt(p, p.events.filter(e => e.timeUs <= timeUs).length);

test('per-request latencies come from event timestamps', () => {
  assert.deepEqual(run.histories.map(h => h.tokenTimesUs), [[1000, 2000, 3000], [2000]]);
  const s = summarize(run, run.final, slo);
  assert.deepEqual([s.ttft.n, s.ttft.mean, s.ttft.p50, s.ttft.p90, s.ttft.max], [2, 1250, 1000, 1500, 1500]);
  assert.deepEqual([s.e2e.n, s.e2e.p50, s.e2e.max], [2, 1500, 3000]);
  assert.deepEqual([s.queueDelay.n, s.queueDelay.max], [2, 500]);
  assert.deepEqual([s.itl.n, s.itl.mean], [2, 1000]);
});

test('TPOT is (last - first) / (G - 1) and N/A for one-token outputs', () => {
  const s = summarize(run, run.final, slo);
  assert.deepEqual([s.tpot.n, s.tpot.p50], [1, 1000]);
});

test('throughput uses the first-arrival-to-horizon interval', () => {
  const s = summarize(run, run.final, slo);
  assert.deepEqual(s.interval, { startUs: 0, endUs: 3000 });
  assert.ok(Math.abs(s.completedPerSec! - 2 / 0.003) < 1e-9);
  assert.ok(Math.abs(s.outputTokensPerSec! - 4 / 0.003) < 1e-9);
});

test('SLO attainment counts every arrived request in the denominator', () => {
  const s = summarize(run, run.final, slo);
  assert.deepEqual(s.slo, { met: 1, counted: 2, attainment: 0.5, notMet: 1 });
  assert.ok(Math.abs(s.sloMetPerSec! - 1 / 0.003) < 1e-9);
});

test('empty samples and zero-length intervals are N/A, not zero', () => {
  const s = summarize(run, at(run, 0), slo);
  assert.deepEqual(s.ttft, { n: 0, mean: null, p50: null, p90: null, p99: null, max: null });
  assert.equal(s.completedPerSec, null);
  assert.equal(s.outputTokensPerSec, null);
  assert.equal(s.slo.attainment, null);
  assert.deepEqual(distribution([]).p99, null);
});

test('metrics at a mid-run horizon count unfinished and waiting requests separately', () => {
  const s = summarize(run, at(run, 2000), slo);
  assert.deepEqual(s.counts, { total: 2, pending: 0, waiting: 0, active: 1, completed: 1, infeasible: 0 });
  assert.deepEqual(s.slo, { met: 0, counted: 1, attainment: 0, notMet: 1 }, 'mid-run SLO covers finished requests only: b finished with TTFT 1.5 ms over the 1.2 ms target');
  const early = summarize(run, at(run, 400), slo);
  assert.deepEqual([early.counts.active, early.counts.pending], [1, 1]);
  const infeasible = build(fixture({ trace: [r('huge', 0, 40, 10), r('ok', 0, 4, 2)], blocks: 10 })).panels.A;
  const f = summarize(infeasible, infeasible.final, slo);
  assert.deepEqual([f.counts.infeasible, f.counts.completed, f.slo.counted], [1, 1, 2]);
});

test('nearest-rank quantiles', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.deepEqual([nearestRank(sorted, 50), nearestRank(sorted, 90), nearestRank(sorted, 99), nearestRank(sorted, 100)], [50, 90, 100, 100]);
  assert.equal(nearestRank([7], 1), 7);
});
