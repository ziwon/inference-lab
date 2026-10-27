import { describe, expect, it } from 'vitest';
import { AllocatorError, BlockAllocator } from './allocator';
import { kvBytesPerToken, memoryModel, weightBytes } from './memory';
import { createReplayer } from './replay';
import { simulatePanel } from './simulator';
import { testConfig } from './testUtils';
import { blocksFor, finalCachedPositions, internalFragmentationTokens, reservationBlocks } from './tokens';
import { architectureFromPreset } from './scenarios';

describe('token semantics', () => {
  it('reaches P + G - 1 populated positions before completion', () => {
    expect(finalCachedPositions(100, 1)).toBe(100);
    expect(finalCachedPositions(100, 10)).toBe(109);
    expect(reservationBlocks(16, 1, 16)).toBe(1);
    expect(reservationBlocks(16, 2, 16)).toBe(2);
    expect(reservationBlocks(15, 2, 16)).toBe(1);
  });

  it('counts exact block boundaries', () => {
    expect(blocksFor(0, 16)).toBe(0);
    expect(blocksFor(1, 16)).toBe(1);
    expect(blocksFor(16, 16)).toBe(1);
    expect(blocksFor(17, 16)).toBe(2);
    expect(internalFragmentationTokens(17, 2, 16)).toBe(15);
  });

  it('G = 1 completes after prefill with no decode iterations', () => {
    const config = testConfig({ requests: [['ONE', 0, 40, 1]] });
    for (const panel of ['A', 'B'] as const) {
      const result = simulatePanel(config, panel, { checkInvariants: true });
      expect(result.status).toBe('completed');
      const decodeItems = result.iterations.flatMap(it => it.items).filter(i => i.kind === 'decode');
      expect(decodeItems).toHaveLength(0);
      const replay = createReplayer(result, 16);
      const beforeRelease = replay.snapshotAfter(result.events.findIndex(e => e.type === 'complete') + 1);
      expect(beforeRelease.requests[0].cachedTokens).toBe(40);
      expect(beforeRelease.requests[0].generatedTokens).toBe(1);
      expect(beforeRelease.requests[0].allocatedBlocks).toBe(3);
    }
  });

  it('keeps generated tokens, populated positions, and allocated blocks separate', () => {
    // P = 32 fills exactly two 16-token blocks; the first decode crosses into a third block.
    const config = testConfig({ requests: [['R', 0, 32, 3]] });
    const result = simulatePanel(config, 'A', { checkInvariants: true });
    const replay = createReplayer(result, 16);
    const ends = result.events.map((e, i) => ({ e, i })).filter(x => x.e.type === 'iteration-end');
    const views = ends.map(({ i }) => replay.snapshotAfter(i + 1).requests[0]);
    expect(views.map(v => [v.generatedTokens, v.cachedTokens, v.allocatedBlocks])).toEqual([
      [1, 32, 2],
      [2, 33, 3],
      [3, 34, 3],
    ]);
    expect(result.iterations[1].items[0].newBlocks).toHaveLength(1);
    expect(result.iterations[2].items[0].newBlocks).toHaveLength(0);
  });

  it('emits no output token before the final prefill chunk', () => {
    const config = testConfig({ requests: [['R', 0, 1200, 2]], scheduler: { maxPrefillChunk: 500 } });
    const result = simulatePanel(config, 'B', { checkInvariants: true });
    const chunks = result.iterations.filter(it => it.items.some(i => i.kind === 'prefill')).map(it => it.items[0]);
    expect(chunks.map(c => [c.tokens, c.contextBefore, c.emitsToken])).toEqual([
      [500, 0, 0],
      [500, 500, 0],
      [200, 1000, 1],
    ]);
    const ends = result.events.filter(e => e.type === 'iteration-end');
    expect(ends.slice(0, 2).every(e => e.type === 'iteration-end' && e.emitted.length === 0)).toBe(true);
  });
});

describe('memory model', () => {
  it('uses KV heads, not query heads, and the factor two for keys and values', () => {
    const arch = architectureFromPreset('synthetic-8b-gqa');
    expect(kvBytesPerToken(arch, { weightBits: 16, weightMetadataPercent: 0, kvElementBytes: 2 })).toBe(2 * 32 * 8 * 128 * 2);
    expect(kvBytesPerToken({ ...arch, numKVHeads: 32 }, { weightBits: 16, weightMetadataPercent: 0, kvElementBytes: 2 })).toBe(4 * 131072);
  });

  it('changing weight precision does not change KV size', () => {
    const arch = architectureFromPreset('synthetic-8b-gqa');
    const a = memoryModel(arch, { weightBits: 16, weightMetadataPercent: 0, kvElementBytes: 2 }, { deviceMemoryGiB: 32, runtimeAllowanceGiB: 2, blockSizeTokens: 16 });
    const b = memoryModel(arch, { weightBits: 4, weightMetadataPercent: 0, kvElementBytes: 2 }, { deviceMemoryGiB: 32, runtimeAllowanceGiB: 2, blockSizeTokens: 16 });
    expect(b.kvBytesPerToken).toBe(a.kvBytesPerToken);
    expect(b.weightBytes).toBe(a.weightBytes / 4);
    expect(b.totalBlocks).toBeGreaterThan(a.totalBlocks);
  });

  it('adds the declared quantization metadata allowance', () => {
    const arch = architectureFromPreset('synthetic-8b-gqa');
    const w = weightBytes(arch, { weightBits: 4, weightMetadataPercent: 5, kvElementBytes: 2 });
    expect(w.packed).toBe(4e9);
    expect(w.metadata).toBe(2e8);
    expect(w.total).toBe(4.2e9);
  });

  it('rounds blocks per request, not across the combined token count', () => {
    // Two requests with 17 populated positions each need 2 blocks each (4 total), not ceil(34/16) = 3.
    const config = testConfig({ requests: [['A', 0, 17, 1], ['B', 0, 17, 1]] });
    const result = simulatePanel(config, 'A', { checkInvariants: true });
    expect(result.iterations[0].allocatedBlocks).toBe(4);
    const replay = createReplayer(result, 16);
    const snap = replay.snapshotAfter(result.events.findIndex(e => e.type === 'iteration-end') + 1);
    expect(snap.cachedTokens).toBe(34);
    expect(snap.allocatedBlocks).toBe(4);
    expect(snap.allocatedBlocks * 16 - snap.cachedTokens).toBe(30);
  });
});

describe('block allocator', () => {
  it('rejects double frees and allocations beyond a reservation', () => {
    const alloc = new BlockAllocator(10);
    alloc.reserve(1, 3);
    expect(alloc.allocate(1, 2)).toEqual([0, 1]);
    expect(() => alloc.allocate(1, 2)).toThrow(AllocatorError);
    expect(alloc.release(1)).toEqual({ blocks: 2, reservedBlocks: 3 });
    expect(() => alloc.release(1)).toThrow(AllocatorError);
    alloc.checkInvariants();
  });

  it('never over-reserves and keeps unique block ownership through reuse', () => {
    const alloc = new BlockAllocator(6);
    alloc.reserve(1, 4);
    expect(alloc.canReserve(3)).toBe(false);
    expect(() => alloc.reserve(2, 3)).toThrow(AllocatorError);
    alloc.reserve(2, 2);
    alloc.allocate(1, 4);
    alloc.allocate(2, 2);
    expect(alloc.physicallyFree).toBe(0);
    alloc.release(1);
    alloc.reserve(3, 3);
    const reused = alloc.allocate(3, 3);
    expect(reused).toEqual([0, 1, 2]);
    for (const block of reused) expect(alloc.ownerOf(block)).toBe(3);
    alloc.checkInvariants();
    expect(alloc.reserved).toBe(5);
    expect(alloc.allocated).toBe(5);
  });
});
