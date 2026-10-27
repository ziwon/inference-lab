import assert from 'node:assert/strict';
import { test } from 'node:test';
import { panelApplied, seekStep } from './compare.ts';
import { PANEL_IDS } from './config.ts';
import { stateAt } from './engine.ts';
import { currentIteration, iterationWaiters, waitReason } from './inspect.ts';
import { requestMetrics } from './metrics.ts';
import { SCENARIO_IDS, scenario } from './scenarios.ts';
import { build } from './test-fixtures.ts';

const everyCursor = function* () {
  for (const id of SCENARIO_IDS) {
    const cmp = build(scenario(id).config);
    for (let k = 0; k <= cmp.steps.timeUs.length; k++) {
      const at = seekStep(cmp, k);
      for (const panel of PANEL_IDS) {
        const run = cmp.panels[panel];
        yield { where: `${id} step ${k} panel ${panel}`, cmp, run, state: stateAt(run, panelApplied(cmp, at, panel)) };
      }
    }
  }
};

test('request metrics at every cursor agree with the replayed request state', () => {
  for (const { where, cmp, run, state } of everyCursor()) {
    cmp.trace.forEach((item, i) => {
      const r = state.requests[i]!;
      const m = requestMetrics(run.histories[i]!, item.outputTokens, r, state.iterationsStarted, cmp.config.slo);
      assert.equal(m.emittedTokens, r.generatedTokens, `${where} ${item.id} tokens`);
      assert.equal(m.ttftUs !== null, r.generatedTokens > 0, `${where} ${item.id} ttft`);
      assert.equal(m.e2eUs !== null, r.phase === 'completed', `${where} ${item.id} e2e`);
    });
  }
});

test('wait reasons at every cursor quote the replayed memory and slot counts', () => {
  for (const { where, run, state } of everyCursor()) {
    state.requests.forEach((r, i) => {
      if (r.phase !== 'waiting' || run.infeasible[i]) return;
      const w = waitReason(run, state, i);
      if (w.code === 'reservationDoesNotFit') assert.equal(w.unreservedBlocks, run.memory.totalBlocks - state.reservedBlocks, where);
      if (w.code === 'activeLimitReached') assert.equal(w.active, state.activeCount, where);
      if (w.code === 'queuedBehind') assert.equal(state.requests[w.head]!.phase, 'waiting', where);
    });
  }
});

test('an iteration lists only requests that have arrived at the cursor as arriving during it', () => {
  for (const { where, run, state } of everyCursor()) {
    const it = currentIteration(run, state);
    if (!it) continue;
    for (const i of iterationWaiters(run, it, state).arrivedDuring) assert.notEqual(state.requests[i]!.phase, 'pending', where);
  }
});
