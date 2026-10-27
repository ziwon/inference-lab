import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComparison } from './compare.ts';
import { fixture, r, run } from './test-fixtures.ts';

const ids = (p: ReturnType<typeof run>, it: number) => p.iterations[it]!.entries.map(e => `${p.trace[e.request]!.id}:${e.kind}:${e.tokens}`);

test('a whole prompt that exactly fills the token budget is valid', () => {
  const p = run({ trace: [r('a', 0, 8, 2)], policy: 'whole-prefill', scheduler: { maxBatchTokens: 8 } });
  assert.equal(p.iterations[0]!.prefillTokens, 8);
  assert.equal(p.iterations[0]!.remainingTokens, 0);
});

test('a chunk budget exactly filled by decodes and a chunk is valid', () => {
  const p = run({ trace: [r('a', 0, 2, 4), r('b', 0, 2, 4), r('c', 1, 20, 2)], scheduler: { maxBatchTokens: 6, maxPrefillChunkTokens: 8 } });
  const it = p.iterations.find(i => i.entries.some(e => p.trace[e.request]!.id === 'c'))!;
  assert.deepEqual(it.entries.map(e => [p.trace[e.request]!.id, e.kind, e.tokens]), [['a', 'decode', 1], ['b', 'decode', 1], ['c', 'prefill', 4]]);
  assert.equal(it.remainingTokens, 0);
  assert.deepEqual(it.entries[2]!.reason, { code: 'prefillChunk', limitedBy: 'tokenBudget' });
});

test('the active-sequence limit admits exactly up to the limit', () => {
  const p = run({ trace: [r('a', 0, 2, 2), r('b', 0, 2, 2), r('c', 0, 2, 2)], scheduler: { maxActiveSequences: 2 } });
  assert.deepEqual(p.iterations[0]!.admitted, [0, 1]);
  assert.deepEqual(p.iterations[0]!.blocked, { request: 2, reason: { code: 'activeLimitReached', active: 2, limit: 2 } });
});

test('Policy A rejects a prompt larger than its full budget; Policy B accepts it', () => {
  const config = fixture({ trace: [r('big', 0, 9, 2)], scheduler: { maxBatchTokens: 8 }, panels: { A: { policy: 'whole-prefill', overrides: {} } } });
  const built = buildComparison(config);
  assert.equal(built.ok, false);
  assert.deepEqual(!built.ok && built.error, [
    { path: 'panels.A', code: 'promptExceedsWholePrefillBudget', params: { panel: 'A', id: 'big', promptTokens: 9, budget: 8 } },
  ]);
  const onlyB = buildComparison({ ...config, panels: { A: { policy: 'chunked-prefill', overrides: {} }, B: { policy: 'chunked-prefill', overrides: {} } } });
  assert.equal(onlyB.ok, true);
});

test('Policy A defers a prompt that does not fit, keeps FIFO order, and still runs decodes', () => {
  const p = run({ trace: [r('a', 0, 4, 4), r('b', 0.5, 6, 2), r('c', 0.5, 3, 2)], policy: 'whole-prefill', scheduler: { maxBatchTokens: 8 } });
  assert.deepEqual(ids(p, 1), ['b:prefill:6', 'a:decode:1']);
  assert.deepEqual(p.iterations[1]!.skipped, [{ request: 2, kind: 'prefill', reason: { code: 'wholePromptDoesNotFit', promptTokens: 3, remainingTokens: 2 } }]);
  assert.deepEqual(ids(p, 2), ['c:prefill:3', 'a:decode:1', 'b:decode:1']);
});

test('Policy A never splits a prompt', () => {
  const p = run({ trace: [r('a', 0, 30, 2), r('b', 0, 30, 2)], policy: 'whole-prefill', scheduler: { maxBatchTokens: 40, maxPrefillChunkTokens: 4 } });
  for (const h of p.histories) assert.equal(h.prefills.length, 1);
});

test('decode order is least recently served first, ties by admission order, in both policies', () => {
  const p = run({ trace: [r('a', 0, 1, 4), r('b', 0, 1, 4), r('c', 0, 1, 4)], policy: 'whole-prefill', scheduler: { maxBatchTokens: 2 } });
  assert.deepEqual(ids(p, 0), ['a:prefill:1', 'b:prefill:1']);
  assert.deepEqual(ids(p, 1), ['c:prefill:1', 'a:decode:1']);
  assert.deepEqual(ids(p, 2), ['b:decode:1', 'a:decode:1']);
  assert.deepEqual(ids(p, 3), ['c:decode:1', 'a:decode:1']);
  const skipped = p.iterations[3]!.skipped[0]!;
  assert.deepEqual([skipped.request, skipped.reason.code], [1, 'tokenBudgetExhausted']);
});

test('Policy B schedules decodes before prefill chunks and respects the chunk limit', () => {
  const p = run({ trace: [r('a', 0, 2, 6), r('long', 0.5, 10, 2)], scheduler: { maxPrefillChunkTokens: 4 } });
  assert.deepEqual(ids(p, 1), ['a:decode:1', 'long:prefill:4']);
  assert.deepEqual(ids(p, 2), ['a:decode:1', 'long:prefill:4']);
  assert.deepEqual(ids(p, 3), ['a:decode:1', 'long:prefill:2']);
  assert.deepEqual(p.iterations[1]!.entries[1]!.reason, { code: 'prefillChunk', limitedBy: 'chunkLimit' });
  assert.deepEqual(p.iterations[3]!.entries[1]!.reason, { code: 'prefillChunk', limitedBy: 'promptEnd' });
});

test('every selected request counts once against the batch', () => {
  const p = run({ trace: Array.from({ length: 6 }, (_, i) => r(`q${i}`, 0, 3, 5)), scheduler: { maxBatchTokens: 7, maxPrefillChunkTokens: 2 } });
  for (const it of p.iterations) {
    const reqs = it.entries.map(e => e.request);
    assert.equal(new Set(reqs).size, reqs.length);
    assert.ok(it.prefillTokens + it.decodeTokens <= 7);
  }
});
