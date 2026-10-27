import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComparison } from './compare.ts';
import { ARCHITECTURE_PRESETS } from './config.ts';
import { stateAt } from './engine.ts';
import { memoryView } from './inspect.ts';
import { auditRun } from './invariants.ts';
import { completionReservation, kvBytesPerToken, planMemory } from './memory.ts';
import { scenario } from './scenarios.ts';
import { build, fixture, r, run } from './test-fixtures.ts';
import { GIB } from './units.ts';

test('KV bytes per token use KV heads, not query heads', () => {
  const gqa = ARCHITECTURE_PRESETS[0].arch;
  assert.equal(kvBytesPerToken(gqa, 2), 2 * 32 * 8 * 128 * 2);
  assert.equal(kvBytesPerToken({ ...gqa, numKvHeads: gqa.numQueryHeads }, 2), 4 * kvBytesPerToken(gqa, 2));
});

test('memory plan subtracts weights, metadata, and runtime allowance before cutting whole blocks', () => {
  const m = planMemory(ARCHITECTURE_PRESETS[0].arch, {
    deviceBytes: 24 * GIB, weightBits: 4, weightMetadataPercent: 5, runtimeAllowanceBytes: 2 * GIB, kvElementBytes: 2, blockSizeTokens: 16,
  });
  assert.equal(m.packedWeightBytes, 4e9);
  assert.equal(m.weightMetadataBytes, 2e8);
  assert.equal(m.kvBlockBytes, 16 * 131072);
  assert.equal(m.kvPoolBytes, 24 * GIB - 4.2e9 - 2 * GIB);
  assert.equal(m.totalBlocks, Math.floor(m.kvPoolBytes / m.kvBlockBytes));
  assert.equal(m.unusableTailBytes, m.kvPoolBytes - m.totalBlocks * m.kvBlockBytes);
});

test('quantized weights without a metadata allowance are flagged as undeclared', () => {
  const arch = ARCHITECTURE_PRESETS[0].arch;
  const mem = { deviceBytes: 24 * GIB, weightBits: 4, weightMetadataPercent: 0, runtimeAllowanceBytes: GIB, kvElementBytes: 2, blockSizeTokens: 16 };
  assert.equal(planMemory(arch, mem).metadataDeclared, false);
  assert.equal(planMemory(arch, { ...mem, weightBits: 16 }).metadataDeclared, true);
});

test('a configuration whose weights and allowance do not fit is rejected', () => {
  const c = scenario('long-prefill').config;
  const built = buildComparison({ ...c, memory: { ...c.memory, deviceBytes: 16 * GIB } });
  assert.equal(built.ok, false);
  assert.equal(!built.ok && built.error[0]!.code, 'weightsDoNotFit');
});

test('weight precision changes neither KV precision nor modeled compute time', () => {
  const c = scenario('long-prefill').config;
  const a = buildComparison(c);
  const b = buildComparison({ ...c, memory: { ...c.memory, weightBits: 4 } });
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.memory.kvBytesPerToken, b.value.memory.kvBytesPerToken);
  assert.ok(b.value.memory.totalBlocks > a.value.memory.totalBlocks);
  assert.deepEqual(a.value.panels.A.iterations.map(it => it.endUs), b.value.panels.A.iterations.map(it => it.endUs));
});

test('block boundaries: exact fit allocates no spare block, a decode crossing the boundary allocates one', () => {
  const p = run({ trace: [r('a', 0, 4, 3)], blockSize: 4 });
  assert.deepEqual(p.iterations.map(it => it.entries[0]!.newBlocks), [1, 1, 0]);
  assert.equal(p.reservations[0], completionReservation(4, 3, 4));
  assert.equal(p.reservations[0], 2);
});

test('blocks round per request, and the waste is internal fragmentation', () => {
  const p = run({ trace: [r('a', 0, 5, 8), r('b', 0, 5, 8)], blockSize: 4 });
  const after = p.events.findIndex(e => e.kind === 'iterationCompleted');
  const view = memoryView(p, stateAt(p, after + 1));
  assert.equal(view.cachedTokens, 10);
  assert.equal(view.allocatedBlocks, 4, 'two 5-token caches hold 2 blocks each, not ceil(10 / 4) = 3');
  assert.equal(view.fragmentationTokens, 6);
});

test('reservation headroom is accounting, not a second allocation', () => {
  const p = run({ trace: [r('a', 0, 5, 12)], blockSize: 4 });
  const after = p.events.findIndex(e => e.kind === 'iterationCompleted');
  const view = memoryView(p, stateAt(p, after + 1));
  assert.equal(view.allocatedBlocks, 2);
  assert.equal(view.headroomBlocks, completionReservation(5, 12, 4) - 2);
  assert.equal(view.freeBlocks, 64 - 2);
  assert.equal(view.unreservedBlocks, 64 - completionReservation(5, 12, 4));
});

test('reservation holds back admission until capacity frees, and the finite trace completes', () => {
  const trace = [r('a', 0, 8, 5), r('b', 0, 8, 5), r('c', 0, 8, 5), r('d', 0, 8, 5)];
  const p = run({ trace, blocks: 10, blockSize: 4 });
  assert.deepEqual(p.iterations[0]!.admitted, [0, 1, 2]);
  assert.deepEqual(p.iterations[0]!.blocked, { request: 3, reason: { code: 'reservationDoesNotFit', needBlocks: 3, unreservedBlocks: 1 } });
  assert.equal(p.outcome.code, 'drained');
  assert.equal(p.final.completedCount, 4);
  assert.deepEqual(auditRun(p), []);
});

test('a request larger than the empty pool is infeasible and does not block the queue', () => {
  const p = run({ trace: [r('huge', 0, 40, 10), r('ok', 0, 4, 2)], blocks: 10, blockSize: 4 });
  assert.deepEqual(p.infeasible[0], { code: 'reservationExceedsPool', needBlocks: 13, totalBlocks: 10 });
  assert.ok(p.events.some(e => e.kind === 'rejected' && e.request === 0));
  assert.deepEqual(p.iterations[0]!.admitted, [1]);
  assert.equal(p.final.requests[0]!.phase, 'infeasible');
  assert.equal(p.final.requests[1]!.phase, 'completed');
});

test('releases happen exactly once, return every block, and reuse ids without double ownership', () => {
  const trace = Array.from({ length: 12 }, (_, i) => r(`q${i}`, i * 0.7, 3 + (i % 5), 2 + (i % 4)));
  const p = run({ trace, blocks: 12, blockSize: 2, scheduler: { maxActiveSequences: 3 } });
  const released = p.events.filter(e => e.kind === 'released').map(e => ('request' in e ? e.request : -1));
  assert.deepEqual([...released].sort((x, y) => x - y), trace.map((_, i) => i));
  assert.equal(p.final.allocatedBlocks, 0);
  assert.equal(p.final.reservedBlocks, 0);
  assert.ok(Math.max(...p.blockIds.flat()) < 12, 'freed ids are reused inside the pool');
  assert.deepEqual(auditRun(p), []);
});

test('peak memory is recorded before completed requests release their blocks', () => {
  const p = build(fixture({ trace: [r('a', 0, 8, 1)], blockSize: 4 })).panels.A;
  assert.equal(p.final.peakAllocatedBlocks, 2);
  assert.equal(p.histories[0]!.peakBlocks, 2);
  assert.equal(p.final.allocatedBlocks, 0);
});
