import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stateAt } from './engine.ts';
import { r, run } from './test-fixtures.ts';

const stateAfter = (p: ReturnType<typeof run>, kind: string, iteration: number) => {
  const i = p.events.findIndex(e => e.kind === kind && 'iteration' in e && e.iteration === iteration);
  return stateAt(p, i + 1);
};

test('G = 1 completes after prefill with P KV positions and no decode', () => {
  const p = run({ trace: [r('one', 0, 5, 1)] });
  const end = stateAfter(p, 'iterationCompleted', 0);
  assert.deepEqual(
    { phase: end.requests[0]!.phase, cached: end.requests[0]!.cachedTokens, generated: end.requests[0]!.generatedTokens },
    { phase: 'finished', cached: 5, generated: 1 },
  );
  assert.equal(p.iterations.length, 1);
  assert.deepEqual(p.histories[0]!.decodeIterations, []);
  assert.deepEqual(p.histories[0]!.tokenTimesUs, [1000]);
  assert.equal(p.events.at(-2)!.kind, 'released');
});

test('a request reaches exactly P + G - 1 populated KV positions before release', () => {
  const p = run({ trace: [r('a', 0, 4, 3)] });
  const last = p.iterations.length - 1;
  const s = stateAfter(p, 'iterationCompleted', last).requests[0]!;
  assert.deepEqual({ cached: s.cachedTokens, generated: s.generatedTokens, phase: s.phase }, { cached: 6, generated: 3, phase: 'finished' });
  assert.equal(stateAt(p, p.events.length).requests[0]!.phase, 'completed');
});

test('each decode consumes the previous token: KV lags emitted tokens by one', () => {
  const p = run({ trace: [r('a', 0, 4, 4)] });
  const rows = p.iterations.map(it => {
    const s = stateAfter(p, 'iterationCompleted', it.index).requests[0]!;
    return [s.cachedTokens, s.generatedTokens];
  });
  assert.deepEqual(rows, [[4, 1], [5, 2], [6, 3], [7, 4]]);
});

test('chunked prefill emits nothing before the final chunk and continues from the cached prefix', () => {
  const p = run({ trace: [r('a', 0, 10, 2)], scheduler: { maxPrefillChunkTokens: 4 } });
  const prefills = p.histories[0]!.prefills.map(c => [c.cachedBefore, c.tokens, c.final]);
  assert.deepEqual(prefills, [[0, 4, false], [4, 4, false], [8, 2, true]]);
  assert.equal(stateAfter(p, 'iterationCompleted', 1).requests[0]!.generatedTokens, 0);
  assert.equal(stateAfter(p, 'iterationCompleted', 2).requests[0]!.generatedTokens, 1);
  assert.equal(p.histories[0]!.tokenTimesUs[0], p.iterations[2]!.endUs);
});

test('a request cannot finish prefill and decode in the same iteration', () => {
  const p = run({ trace: [r('a', 0, 3, 3)] });
  for (const it of p.iterations) assert.ok(it.entries.length <= 1);
  assert.deepEqual(p.iterations.map(it => it.entries[0]!.kind), ['prefill', 'decode', 'decode']);
});
