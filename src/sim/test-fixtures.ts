import { buildComparison, type Comparison } from './compare.ts';
import { CONFIG_VERSION, type CostModel, type MemoryConfig, type PanelSpec, type PolicyId, type SchedulerLimits, type SimConfig, type TraceRequest } from './config.ts';
import { GIB } from './units.ts';

export const TINY_ARCH = { label: 'tiny', parameterCount: 1e6, numLayers: 1, numQueryHeads: 1, numKvHeads: 1, headDim: 1, maxContextTokens: 4096 };
const WEIGHT_BYTES = 1e6;

export const FLAT_COST: CostModel = { overheadMs: 1, prefillTokenMs: 0, attentionMsPerMillionPairs: 0, decodeSequenceMs: 0, decodeContextMsPerThousandTokens: 0 };

export interface FixtureOptions {
  trace: TraceRequest[];
  blocks?: number;
  blockSize?: number;
  scheduler?: Partial<SchedulerLimits>;
  cost?: Partial<CostModel>;
  memory?: Partial<MemoryConfig>;
  policy?: PolicyId;
  panels?: Partial<Record<'A' | 'B', PanelSpec>>;
}

export function fixture(o: FixtureOptions): SimConfig {
  const blockSize = o.blockSize ?? 4;
  const blocks = o.blocks ?? 64;
  const policy = o.policy ?? 'chunked-prefill';
  return {
    version: CONFIG_VERSION,
    seed: 1,
    architecture: { ...TINY_ARCH },
    memory: {
      deviceBytes: GIB,
      weightBits: 8,
      weightMetadataPercent: 0,
      runtimeAllowanceBytes: GIB - WEIGHT_BYTES - blocks * blockSize * 2,
      kvElementBytes: 1,
      blockSizeTokens: blockSize,
      ...o.memory,
    },
    scheduler: { maxActiveSequences: 8, maxBatchTokens: 64, maxPrefillChunkTokens: 64, ...o.scheduler },
    cost: { ...FLAT_COST, ...o.cost },
    slo: { ttftMs: 1.2, tpotMs: 2 },
    trace: { kind: 'explicit', requests: o.trace },
    panels: { A: { policy, overrides: {} }, B: { policy, overrides: {} }, ...o.panels },
  };
}

export const r = (id: string, arrivalMs: number, promptTokens: number, outputTokens: number): TraceRequest => ({ id, arrivalMs, promptTokens, outputTokens });

export function build(config: SimConfig): Comparison {
  const built = buildComparison(config);
  if (!built.ok) throw new Error(`fixture failed validation: ${JSON.stringify(built.error)}`);
  return built.value;
}

export const run = (o: FixtureOptions) => build(fixture(o)).panels.A;
