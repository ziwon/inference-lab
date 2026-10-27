import type { Architecture, MemoryConfig } from './config.ts';
import { ceilDiv } from './units.ts';

/** Static memory budget for one logical GPU. Every value is in bytes unless its name says otherwise. */
export interface MemoryPlan {
  deviceBytes: number;
  packedWeightBytes: number;
  weightMetadataBytes: number;
  weightBytes: number;
  runtimeAllowanceBytes: number;
  kvBytesPerToken: number;
  kvBlockBytes: number;
  blockSizeTokens: number;
  kvPoolBytes: number;
  totalBlocks: number;
  /** Bytes left after the pool is cut into whole blocks. */
  unusableTailBytes: number;
  metadataDeclared: boolean;
}

/** Full-attention decoder only: keys and values (factor 2) for every layer and KV head. */
export const kvBytesPerToken = (a: Architecture, kvElementBytes: number) => 2 * a.numLayers * a.numKvHeads * a.headDim * kvElementBytes;

export function planMemory(a: Architecture, m: MemoryConfig): MemoryPlan {
  const packedWeightBytes = Math.ceil((a.parameterCount * m.weightBits) / 8);
  const weightMetadataBytes = Math.ceil((packedWeightBytes * m.weightMetadataPercent) / 100);
  const weightBytes = packedWeightBytes + weightMetadataBytes;
  const perToken = kvBytesPerToken(a, m.kvElementBytes);
  const kvBlockBytes = m.blockSizeTokens * perToken;
  const kvPoolBytes = m.deviceBytes - weightBytes - m.runtimeAllowanceBytes;
  const totalBlocks = kvPoolBytes > 0 ? Math.floor(kvPoolBytes / kvBlockBytes) : 0;
  return {
    deviceBytes: m.deviceBytes,
    packedWeightBytes,
    weightMetadataBytes,
    weightBytes,
    runtimeAllowanceBytes: m.runtimeAllowanceBytes,
    kvBytesPerToken: perToken,
    kvBlockBytes,
    blockSizeTokens: m.blockSizeTokens,
    kvPoolBytes,
    totalBlocks,
    unusableTailBytes: kvPoolBytes > 0 ? kvPoolBytes - totalBlocks * kvBlockBytes : 0,
    metadataDeclared: m.weightMetadataPercent > 0 || m.weightBits >= 16,
  };
}

export const blocksFor = (tokens: number, blockSizeTokens: number) => ceilDiv(tokens, blockSizeTokens);

/** This simulator's admission policy: reserve enough blocks to finish, P + G - 1 populated positions. */
export const completionReservation = (promptTokens: number, outputTokens: number, blockSizeTokens: number) =>
  blocksFor(promptTokens + outputTokens - 1, blockSizeTokens);

/**
 * Block ids for the engine run. Fresh ids ascend from a high-water mark and freed ids are reused LIFO,
 * so the pool never materializes an array the size of the device.
 */
export class BlockAllocator {
  private recycled: number[] = [];
  private nextFresh = 0;
  private readonly total: number;
  constructor(total: number) {
    this.total = total;
  }
  allocate(): number {
    const id = this.recycled.pop() ?? this.nextFresh++;
    if (id >= this.total) throw new Error(`block pool exhausted at id ${id}`);
    return id;
  }
  free(ids: readonly number[]) {
    for (let i = ids.length - 1; i >= 0; i--) this.recycled.push(ids[i]!);
  }
}
