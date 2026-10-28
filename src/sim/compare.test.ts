import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitDifferences } from './compare.ts';
import { fixture, r } from './test-fixtures.ts';

const trace = [r('a', 0, 4, 2)];

test('panels on the shared limits differ in nothing but policy', () => {
  assert.deepEqual(limitDifferences(fixture({ trace, panels: { A: { policy: 'whole-prefill', overrides: {} } } })), []);
});

test('an override that matches the shared value is not a difference', () => {
  assert.deepEqual(limitDifferences(fixture({ trace, scheduler: { maxActiveSequences: 8 }, panels: { B: { policy: 'chunked-prefill', overrides: { maxActiveSequences: 8 } } } })), []);
});

test('an override lists both panel values and the shared value', () => {
  const config = fixture({ trace, scheduler: { maxActiveSequences: 8 }, panels: { B: { policy: 'chunked-prefill', overrides: { maxActiveSequences: 4 } } } });
  assert.deepEqual(limitDifferences(config), [{ limit: 'maxActiveSequences', shared: 8, values: { A: 8, B: 4 }, unusedBy: [] }]);
});

test('a chunk override names the whole-prefill panel that ignores it', () => {
  const onB = fixture({ trace, scheduler: { maxPrefillChunkTokens: 64 }, panels: { A: { policy: 'whole-prefill', overrides: {} }, B: { policy: 'chunked-prefill', overrides: { maxPrefillChunkTokens: 16 } } } });
  assert.deepEqual(limitDifferences(onB), [{ limit: 'maxPrefillChunkTokens', shared: 64, values: { A: 64, B: 16 }, unusedBy: ['A'] }]);
  const onA = fixture({ trace, scheduler: { maxPrefillChunkTokens: 64 }, panels: { A: { policy: 'whole-prefill', overrides: { maxPrefillChunkTokens: 16 } } } });
  assert.deepEqual(limitDifferences(onA), [{ limit: 'maxPrefillChunkTokens', shared: 64, values: { A: 16, B: 64 }, unusedBy: ['A'] }]);
});
