import type { ArchitectureConfig, CostConfig, SimConfig, TraceRequest } from './types';

// Synthetic presets chosen for readable educational scenarios. They do not describe a
// particular commercial model or GPU, and the cost coefficients are not measurements.

export interface ArchitecturePreset extends Omit<ArchitectureConfig, 'presetId'> {
  id: string;
}

export const ARCHITECTURE_PRESETS: readonly ArchitecturePreset[] = [
  { id: 'synthetic-8b-gqa', paramsBillions: 8, numLayers: 32, numQueryHeads: 32, numKVHeads: 8, headDim: 128, maxContextLength: 8192 },
  { id: 'synthetic-8b-mha', paramsBillions: 8, numLayers: 32, numQueryHeads: 32, numKVHeads: 32, headDim: 128, maxContextLength: 8192 },
  { id: 'synthetic-3b-mha', paramsBillions: 3, numLayers: 26, numQueryHeads: 24, numKVHeads: 24, headDim: 128, maxContextLength: 4096 },
  { id: 'synthetic-30b-gqa', paramsBillions: 30, numLayers: 48, numQueryHeads: 48, numKVHeads: 8, headDim: 128, maxContextLength: 16384 },
];

export function architectureFromPreset(id: string): ArchitectureConfig {
  const preset = ARCHITECTURE_PRESETS.find(p => p.id === id) ?? ARCHITECTURE_PRESETS[0];
  const { id: presetId, ...rest } = preset;
  return { presetId, ...rest };
}

export const DEFAULT_COST: CostConfig = {
  iterationOverheadMs: 8,
  linearMsPerToken: 0.06,
  prefillAttentionMsPerMillionPairs: 4,
  decodeAttentionMsPerThousandPositions: 0.5,
};

export type ScenarioId = 'long-prefill' | 'kv-pressure' | 'burst' | 'edge-cases';
export const SCENARIO_IDS: readonly ScenarioId[] = ['long-prefill', 'kv-pressure', 'burst', 'edge-cases'];

export interface Scenario {
  id: ScenarioId;
  /** Suggested playback rate in modeled ms per wall-clock second. */
  playbackRate: number;
  config: SimConfig;
}

function explicit(rows: [string, number, number, number][]): TraceRequest[] {
  return rows.map(([id, arrivalMs, promptTokens, outputTokens]) => ({ id, arrivalMs, promptTokens, outputTokens }));
}

function base(id: ScenarioId): Omit<SimConfig, 'workload' | 'memory' | 'scheduler'> {
  return {
    version: 1,
    scenarioId: id,
    seed: 1,
    architecture: architectureFromPreset('synthetic-8b-gqa'),
    precision: { weightBits: 16, weightMetadataPercent: 0, kvElementBytes: 2 },
    cost: { ...DEFAULT_COST },
    slo: { ttftMs: 500, tpotMs: 25 },
    panels: { A: { policy: 'whole-prefill', overrides: {} }, B: { policy: 'chunked-prefill', overrides: {} } },
  };
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  'long-prefill': {
    id: 'long-prefill',
    playbackRate: 250,
    config: {
      ...base('long-prefill'),
      memory: { deviceMemoryGiB: 32, runtimeAllowanceGiB: 4, blockSizeTokens: 16 },
      scheduler: { maxActiveSequences: 16, tokenBudget: 4096, maxPrefillChunk: 512 },
      slo: { ttftMs: 250, tpotMs: 20 },
      workload: {
        kind: 'explicit',
        requests: explicit([
          ['R1', 0, 192, 120],
          ['R2', 10, 160, 110],
          ['R3', 20, 224, 130],
          ['R4', 30, 128, 100],
          ['R5', 40, 256, 120],
          ['R6', 50, 176, 115],
          ['LONG', 320, 4000, 40],
          ['R7', 420, 160, 60],
          ['R8', 470, 192, 60],
        ]),
      },
    },
  },
  'kv-pressure': {
    id: 'kv-pressure',
    playbackRate: 1000,
    config: {
      ...base('kv-pressure'),
      seed: 7,
      memory: { deviceMemoryGiB: 20, runtimeAllowanceGiB: 2, blockSizeTokens: 16 },
      scheduler: { maxActiveSequences: 32, tokenBudget: 4096, maxPrefillChunk: 1024 },
      slo: { ttftMs: 2000, tpotMs: 30 },
      workload: {
        kind: 'generated',
        params: { count: 24, startMs: 0, meanInterArrivalMs: 60, promptMin: 1024, promptMax: 2048, outputMin: 128, outputMax: 320 },
      },
    },
  },
  burst: {
    id: 'burst',
    playbackRate: 500,
    config: {
      ...base('burst'),
      seed: 42,
      memory: { deviceMemoryGiB: 32, runtimeAllowanceGiB: 4, blockSizeTokens: 16 },
      scheduler: { maxActiveSequences: 16, tokenBudget: 2048, maxPrefillChunk: 512 },
      slo: { ttftMs: 1000, tpotMs: 25 },
      workload: {
        kind: 'generated',
        params: { count: 32, startMs: 100, meanInterArrivalMs: 0, promptMin: 64, promptMax: 1536, outputMin: 32, outputMax: 256 },
      },
    },
  },
  'edge-cases': {
    id: 'edge-cases',
    playbackRate: 100,
    config: {
      ...base('edge-cases'),
      memory: { deviceMemoryGiB: 16, runtimeAllowanceGiB: 0.5, blockSizeTokens: 16 },
      scheduler: { maxActiveSequences: 8, tokenBudget: 8192, maxPrefillChunk: 512 },
      slo: { ttftMs: 300, tpotMs: 20 },
      workload: {
        kind: 'explicit',
        requests: explicit([
          ['ONE', 0, 200, 1],
          ['HUGE', 5, 6000, 64],
          ['NEXT', 10, 300, 40],
          ['EDGE', 15, 16, 17],
        ]),
      },
    },
  },
};

export const DEFAULT_SCENARIO: ScenarioId = 'long-prefill';

export function scenarioConfig(id: ScenarioId): SimConfig {
  return structuredClone(SCENARIOS[id].config);
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (SCENARIO_IDS as readonly string[]).includes(value);
}
