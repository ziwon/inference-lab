import { architectureFromPreset } from './scenarios';
import type { CostConfig, PolicyId, SchedulerConfig, SimConfig, TraceRequest } from './types';

/** Simple cost: overhead 10 ms + 1 ms per token, no attention terms. Easy to check by hand. */
export const HAND_COST: CostConfig = {
  iterationOverheadMs: 10,
  linearMsPerToken: 1,
  prefillAttentionMsPerMillionPairs: 0,
  decodeAttentionMsPerThousandPositions: 0,
};

export interface TestConfigOptions {
  requests: [string, number, number, number][];
  scheduler?: Partial<SchedulerConfig>;
  cost?: Partial<CostConfig>;
  blockSize?: number;
  /** KV pool size in blocks (device memory is derived to hit it exactly). */
  blocks?: number;
  policyA?: PolicyId;
  policyB?: PolicyId;
}

/**
 * Builds a config on a tiny synthetic model: 1 layer, 1 KV head, head dim 8, 2-byte KV
 * => 32 bytes per token. Weights are 1 B params at 16 bits = 2,000,000,000 bytes.
 */
export function testConfig(options: TestConfigOptions): SimConfig {
  const blockSize = options.blockSize ?? 16;
  const blocks = options.blocks ?? 1000;
  const kvBytesPerToken = 2 * 1 * 1 * 8 * 2;
  const weightBytes = 1e9 * 2;
  const deviceBytes = weightBytes + blocks * blockSize * kvBytesPerToken;
  const trace: TraceRequest[] = options.requests.map(([id, arrivalMs, promptTokens, outputTokens]) => ({ id, arrivalMs, promptTokens, outputTokens }));
  return {
    version: 1,
    scenarioId: null,
    seed: 1,
    workload: { kind: 'explicit', requests: trace },
    architecture: { ...architectureFromPreset('synthetic-8b-gqa'), presetId: 'custom', paramsBillions: 1, numLayers: 1, numQueryHeads: 1, numKVHeads: 1, headDim: 8, maxContextLength: 65536 },
    precision: { weightBits: 16, weightMetadataPercent: 0, kvElementBytes: 2 },
    memory: { deviceMemoryGiB: deviceBytes / 1024 ** 3, runtimeAllowanceGiB: 0, blockSizeTokens: blockSize },
    scheduler: { maxActiveSequences: 8, tokenBudget: 4096, maxPrefillChunk: 512, ...options.scheduler },
    cost: { ...HAND_COST, ...options.cost },
    slo: { ttftMs: 100, tpotMs: 20 },
    panels: { A: { policy: options.policyA ?? 'whole-prefill', overrides: {} }, B: { policy: options.policyB ?? 'chunked-prefill', overrides: {} } },
  };
}
