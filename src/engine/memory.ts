import type { ArchitectureConfig, MemoryConfig, MemoryModel, PrecisionConfig } from './types';

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
export const KiB = 1024;

/**
 * KV bytes per populated token position for a full-attention decoder-only Transformer.
 * The factor 2 stores keys and values. KV heads (not query heads) set the size, so GQA shrinks it.
 */
export function kvBytesPerToken(arch: ArchitectureConfig, precision: PrecisionConfig): number {
  return 2 * arch.numLayers * arch.numKVHeads * arch.headDim * precision.kvElementBytes;
}

/** Packed weight bytes plus the declared metadata allowance. */
export function weightBytes(arch: ArchitectureConfig, precision: PrecisionConfig) {
  const packed = Math.round(arch.paramsBillions * 1e9 * precision.weightBits / 8);
  const metadata = Math.round(packed * precision.weightMetadataPercent / 100);
  return { packed, metadata, total: packed + metadata };
}

export function memoryModel(arch: ArchitectureConfig, precision: PrecisionConfig, memory: MemoryConfig): MemoryModel {
  const weights = weightBytes(arch, precision);
  const deviceBytes = Math.round(memory.deviceMemoryGiB * GiB);
  const runtimeAllowanceBytes = Math.round(memory.runtimeAllowanceGiB * GiB);
  const perToken = kvBytesPerToken(arch, precision);
  const kvBlockBytes = memory.blockSizeTokens * perToken;
  const kvPoolBytes = Math.max(0, deviceBytes - weights.total - runtimeAllowanceBytes);
  const totalBlocks = kvBlockBytes > 0 ? Math.floor(kvPoolBytes / kvBlockBytes) : 0;
  return {
    weightPackedBytes: weights.packed,
    weightMetadataBytes: weights.metadata,
    weightBytes: weights.total,
    runtimeAllowanceBytes,
    deviceBytes,
    kvBytesPerToken: perToken,
    kvBlockBytes,
    kvPoolBytes,
    totalBlocks,
    unusedTailBytes: kvPoolBytes - totalBlocks * kvBlockBytes,
  };
}
