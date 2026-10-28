import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComparison } from './compare.ts';
import { PANEL_IDS } from './config.ts';
import { type PanelRun, stateAt } from './engine.ts';
import { SCENARIO_IDS, scenario } from './scenarios.ts';
import { panelSeries, sampleAt } from './series.ts';

for (const id of SCENARIO_IDS) {
  test(`${id}: each over-time sample matches the replayed state when its iteration starts`, () => {
    const built = buildComparison(scenario(id).config);
    if (!built.ok) throw new Error(`${id} failed validation`);
    for (const panel of PANEL_IDS) {
      const run: PanelRun = built.value.panels[panel];
      const series = panelSeries(run);
      assert.equal(series.startUs.length, run.iterations.length);
      let sawWaiting = false;
      run.events.forEach((e, k) => {
        if (e.kind !== 'iterationStarted') return;
        const i = e.iteration;
        const s = stateAt(run, k + 1);
        const waiting = s.requests.filter(r => r.phase === 'waiting').length;
        sawWaiting ||= waiting > 0;
        assert.deepEqual(
          [series.startUs[i], series.endUs[i], series.allocated[i], series.reserved[i], series.entries[i], series.waiting[i], series.active[i]],
          [run.iterations[i]!.startUs, run.iterations[i]!.endUs, s.allocatedBlocks, s.reservedBlocks, run.iterations[i]!.entries.length, waiting, s.activeCount],
          `panel ${panel} iteration ${i}`,
        );
      });
      if (id === 'burst') assert.ok(sawWaiting, 'burst queues requests');
    }
  });
}

test('a time inside an iteration reads that iteration, and an idle gap reads none', () => {
  const built = buildComparison(scenario('edge-cases').config);
  if (!built.ok) throw new Error('edge-cases failed validation');
  const series = panelSeries(built.value.panels.A);
  const last = series.startUs.length - 1;
  assert.equal(sampleAt(series, series.startUs[0]! - 1), null);
  assert.equal(sampleAt(series, series.startUs[0]!), 0);
  assert.equal(sampleAt(series, series.endUs[0]! - 1), 0);
  assert.equal(sampleAt(series, series.endUs[last]!), null);
  const gap = Array.from(series.startUs).findIndex((t, i) => i > 0 && t > series.endUs[i - 1]!);
  assert.ok(gap > 0, 'edge-cases has an idle gap');
  assert.equal(sampleAt(series, series.endUs[gap - 1]!), null);
});
