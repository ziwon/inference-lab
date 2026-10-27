import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner executes TypeScript', () => {
  const n: number = 1;
  assert.equal(n, 1);
});
