import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TOTAL_KV_BLOCKS, buildComparison, seekStep, seekTime, panelApplied } from './compare.ts';
import type { PolicyId } from './config.ts';
import { MAX_RECORDS, stateAt } from './engine.ts';
import { auditRun } from './invariants.ts';
import { SCENARIO_IDS, scenario } from './scenarios.ts';
import { exportRun } from './serialize.ts';
import { build, fixture, r, run } from './test-fixtures.ts';
import { mulberry32 } from './trace.ts';

const label = (p: ReturnType<typeof run>) =>
  p.events.map(e => `${e.kind}${'request' in e ? ` ${p.trace[e.request]!.id}` : ''}${'iteration' in e ? ` ${e.iteration}` : ''} @${e.timeUs}`);

test('simultaneous arrivals keep trace order; arrivals during an iteration wait for the next one', () => {
  const p = run({ trace: [r('x', 0, 2, 2), r('y', 0, 2, 2), r('mid', 0.5, 2, 1), r('edge', 1, 2, 1)] });
  assert.deepEqual(label(p).slice(0, 12), [
    'arrived x @0',
    'arrived y @0',
    'admitted x @0',
    'admitted y @0',
    'iterationStarted 0 @0',
    'arrived mid @500',
    'iterationCompleted 0 @1000',
    'arrived edge @1000',
    'admitted mid @1000',
    'admitted edge @1000',
    'iterationStarted 1 @1000',
    'iterationCompleted 1 @2000',
  ]);
  assert.deepEqual(p.iterations[0]!.entries.map(e => e.request), [0, 1]);
  assert.ok(p.iterations[1]!.entries.some(e => e.request === 2));
});

test('an idle engine advances to the next arrival', () => {
  const p = run({ trace: [r('a', 0, 2, 1), r('b', 50, 2, 1)] });
  assert.equal(p.iterations[1]!.startUs, 50_000);
  assert.equal(p.outcome.code, 'drained');
});

test('completed requests release in admission order before arrivals at the same instant', () => {
  const p = run({ trace: [r('a', 0, 2, 1), r('b', 0, 2, 1), r('c', 1, 2, 1)] });
  assert.deepEqual(label(p).slice(5, 9), ['iterationCompleted 0 @1000', 'released a @1000', 'released b @1000', 'arrived c @1000']);
});

test('events are causal: time never decreases and lifecycle steps happen in order', () => {
  const cmp = build(scenario('burst').config);
  for (const p of [cmp.panels.A, cmp.panels.B]) {
    p.events.forEach((e, i) => assert.ok(i === 0 || e.timeUs >= p.events[i - 1]!.timeUs));
    p.histories.forEach(h => {
      if (h.infeasible) return;
      const chain = [h.arrivalUs, h.admittedUs!, h.firstExecUs!, h.tokenTimesUs[0]!, h.tokenTimesUs.at(-1)!, h.releasedUs!];
      chain.forEach((t, i) => assert.ok(i === 0 || t >= chain[i - 1]!, `chain ${chain}`));
    });
    for (const it of p.iterations) for (const e of it.entries) assert.ok(p.histories[e.request]!.admittedUs! <= it.startUs);
  }
});

test('identical configuration and seed reproduce identical results', () => {
  for (const id of SCENARIO_IDS) {
    const a = JSON.stringify(exportRun(build(scenario(id).config)));
    const b = JSON.stringify(exportRun(build(scenario(id).config)));
    assert.equal(a, b, id);
  }
  const c = scenario('kv-pressure').config;
  const other = build({ ...c, seed: c.seed + 1 });
  assert.notDeepEqual(other.requests, build(c).requests);
});

test('backward and forward stepping revisit identical states that match a fresh replay', () => {
  const cmp = build(scenario('long-prefill').config);
  const total = cmp.steps.timeUs.length;
  const forward: string[] = [];
  for (let k = 0; k <= total; k++) {
    const at = seekStep(cmp, k);
    forward.push(JSON.stringify([stateAt(cmp.panels.A, panelApplied(cmp, at, 'A')), stateAt(cmp.panels.B, panelApplied(cmp, at, 'B'))]));
  }
  for (let k = total; k >= 0; k--) {
    const at = seekStep(cmp, k);
    const back = JSON.stringify([stateAt(cmp.panels.A, panelApplied(cmp, at, 'A')), stateAt(cmp.panels.B, panelApplied(cmp, at, 'B'))]);
    assert.equal(back, forward[k], `step ${k}`);
  }
  assert.deepEqual(stateAt(cmp.panels.A, cmp.panels.A.events.length), cmp.panels.A.final);
});

test('panels stay synchronized by simulated time', () => {
  const cmp = build(scenario('long-prefill').config);
  const at = seekTime(cmp, 300_000);
  for (const panel of ['A', 'B'] as const) {
    const p = cmp.panels[panel];
    const applied = panelApplied(cmp, at, panel);
    assert.ok(p.events.slice(0, applied).every(e => e.timeUs <= 300_000));
    assert.ok(p.events.slice(applied).every(e => e.timeUs > 300_000));
  }
});

test('the long-prefill preset admits the long request in both panels while short requests decode', () => {
  const cmp = build(scenario('long-prefill').config);
  for (const panel of ['A', 'B'] as const) {
    const p = cmp.panels[panel];
    const long = p.trace.findIndex(t => t.id === 'Long');
    const decision = p.iterations.find(it => it.admitted.includes(long))!;
    assert.equal(decision.startUs - p.trace[long]!.arrivalUs < 10_000, true, 'admitted at the first decision after arrival');
    assert.ok(decision.entries.some(e => e.kind === 'decode'), 'short requests are decoding');
  }
});

test('the long-prefill preset shows the chunking tradeoff from the model, not a forced win', () => {
  const cmp = build(scenario('long-prefill').config);
  const ttft = (panel: 'A' | 'B', id: string) => {
    const p = cmp.panels[panel];
    const i = p.trace.findIndex(t => t.id === id);
    return p.histories[i]!.tokenTimesUs[0]! - p.trace[i]!.arrivalUs;
  };
  const maxGap = (panel: 'A' | 'B') =>
    Math.max(...cmp.panels[panel].histories.flatMap(h => h.tokenTimesUs.slice(1).map((t, i) => t - h.tokenTimesUs[i]!)));
  assert.ok(ttft('B', 'Long') > ttft('A', 'Long'), 'chunking delays the long request');
  assert.ok(ttft('B', 'R8') < ttft('A', 'R8'), 'chunking helps the request behind it');
  assert.ok(maxGap('B') < maxGap('A') / 4, 'chunking bounds the decode stall');
});

test('seeded random traces drain with no invariant violations under both policies', () => {
  const rng = mulberry32(2024);
  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + rng.int({ min: 0, max: 14 });
    const trace = Array.from({ length: n }, (_, i) => r(`t${i}`, rng.int({ min: 0, max: 8 }) / 2, rng.int({ min: 1, max: 30 }), rng.int({ min: 1, max: 12 })));
    const policy: PolicyId = trial % 2 === 0 ? 'whole-prefill' : 'chunked-prefill';
    const config = fixture({
      trace,
      policy,
      blocks: rng.int({ min: 6, max: 30 }),
      blockSize: rng.int({ min: 1, max: 8 }),
      scheduler: { maxActiveSequences: rng.int({ min: 1, max: 6 }), maxBatchTokens: rng.int({ min: 30, max: 48 }), maxPrefillChunkTokens: rng.int({ min: 1, max: 16 }) },
    });
    const built = buildComparison(config);
    assert.ok(built.ok, JSON.stringify(!built.ok && built.error));
    const p = built.value.panels.A;
    assert.deepEqual(auditRun(p), [], `trial ${trial}`);
    assert.equal(p.outcome.code, 'drained', `trial ${trial}`);
    p.final.requests.forEach((s, i) => {
      assert.ok(s.phase === 'completed' || s.phase === 'infeasible');
      if (s.phase === 'completed') assert.equal(p.histories[i]!.tokenTimesUs.length, p.trace[i]!.outputTokens);
    });
  }
});

test('every preset drains under both panels with clean audits', () => {
  for (const id of SCENARIO_IDS) {
    const cmp = build(scenario(id).config);
    for (const panel of ['A', 'B'] as const) {
      assert.equal(cmp.panels[panel].outcome.code, 'drained', `${id} ${panel}`);
      assert.deepEqual(auditRun(cmp.panels[panel]), [], `${id} ${panel}`);
    }
  }
});

test('a run that would record more than MAX_RECORDS batch entries stops early as truncated and stays consistent', () => {
  const trace = Array.from({ length: 128 }, (_, i) => r(`r${i}`, 0, 4000, 1));
  const p = run({ trace, blocks: 200_000, scheduler: { maxPrefillChunkTokens: 1 } });
  assert.deepEqual(p.outcome, { code: 'truncated', limit: 'records', max: MAX_RECORDS });
  const recorded = p.iterations.reduce((s, it) => s + it.entries.length + it.skipped.length, 0);
  assert.ok(recorded <= MAX_RECORDS, `recorded ${recorded}`);
  assert.deepEqual(p.events.at(-1), { kind: 'runEnded', timeUs: p.endUs, outcome: p.outcome });
  assert.equal(p.final.executing, null, 'no iteration is left half-applied');
});

test('a trace whose KV blocks exceed MAX_TOTAL_KV_BLOCKS fails validation instead of building', () => {
  const config = fixture({ trace: Array.from({ length: 9 }, (_, i) => r(`r${i}`, i, 262_143, 1)), blockSize: 1, blocks: 300_000, scheduler: { maxBatchTokens: 262_144 } });
  config.architecture.maxContextTokens = 262_144;
  const built = buildComparison(config);
  assert.ok(!built.ok);
  assert.deepEqual(built.error.map(i => [i.code, i.params?.max]), [['tooManyKvBlocks', MAX_TOTAL_KV_BLOCKS]]);
});
