import { ARCHITECTURE_PRESETS, CONFIG_VERSION, DEFAULT_COST, type SimConfig, type TraceRequest } from './config.ts';
import { GIB } from './units.ts';

export const SCENARIO_IDS = ['long-prefill', 'kv-pressure', 'burst', 'edge-cases'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface Scenario {
  id: ScenarioId;
  config: SimConfig;
  playbackMsPerSec: number;
}

const base = (): SimConfig => ({
  version: CONFIG_VERSION,
  seed: 7,
  architecture: { ...ARCHITECTURE_PRESETS[0].arch },
  memory: { deviceBytes: 24 * GIB, weightBits: 16, weightMetadataPercent: 0, runtimeAllowanceBytes: 2 * GIB, kvElementBytes: 2, blockSizeTokens: 16 },
  scheduler: { maxActiveSequences: 16, maxBatchTokens: 8192, maxPrefillChunkTokens: 512 },
  cost: { ...DEFAULT_COST },
  slo: { ttftMs: 200, tpotMs: 20 },
  trace: { kind: 'explicit', requests: [] },
  panels: { A: { policy: 'whole-prefill', overrides: {} }, B: { policy: 'chunked-prefill', overrides: {} } },
});

const req = (id: string, arrivalMs: number, promptTokens: number, outputTokens: number): TraceRequest => ({ id, arrivalMs, promptTokens, outputTokens });

function longPrefill(): SimConfig {
  return {
    ...base(),
    trace: {
      kind: 'explicit',
      requests: [
        req('R1', 0, 160, 96),
        req('R2', 10, 220, 96),
        req('R3', 20, 180, 96),
        req('R4', 30, 256, 96),
        req('R5', 40, 200, 96),
        req('R6', 50, 240, 96),
        req('Long', 150, 6144, 32),
        req('R8', 200, 200, 48),
      ],
    },
  };
}

function kvPressure(): SimConfig {
  const c = base();
  return {
    ...c,
    seed: 11,
    memory: { ...c.memory, deviceBytes: 20 * GIB },
    slo: { ttftMs: 1500, tpotMs: 25 },
    trace: { kind: 'generated', count: 20, pattern: 'jittered', spanMs: 600, promptTokens: { min: 1500, max: 3000 }, outputTokens: { min: 64, max: 160 } },
  };
}

function burst(): SimConfig {
  const c = base();
  return {
    ...c,
    seed: 23,
    scheduler: { maxActiveSequences: 8, maxBatchTokens: 4096, maxPrefillChunkTokens: 512 },
    slo: { ttftMs: 400, tpotMs: 20 },
    trace: { kind: 'generated', count: 24, pattern: 'burst', spanMs: 20, promptTokens: { min: 256, max: 1536 }, outputTokens: { min: 24, max: 128 } },
  };
}

function edgeCases(): SimConfig {
  const c = base();
  return {
    ...c,
    memory: { ...c.memory, deviceBytes: 17 * GIB },
    scheduler: { maxActiveSequences: 4, maxBatchTokens: 2048, maxPrefillChunkTokens: 256 },
    trace: {
      kind: 'explicit',
      requests: [req('OneToken', 0, 96, 1), req('TooBig', 5, 1200, 16), req('R3', 10, 200, 40), req('R4', 60, 300, 24)],
    },
  };
}

const BUILDERS: Record<ScenarioId, { build: () => SimConfig; playbackMsPerSec: number }> = {
  'long-prefill': { build: longPrefill, playbackMsPerSec: 100 },
  'kv-pressure': { build: kvPressure, playbackMsPerSec: 500 },
  burst: { build: burst, playbackMsPerSec: 200 },
  'edge-cases': { build: edgeCases, playbackMsPerSec: 50 },
};

export const DEFAULT_SCENARIO: ScenarioId = 'long-prefill';

export function scenario(id: ScenarioId): Scenario {
  const b = BUILDERS[id];
  return { id, config: b.build(), playbackMsPerSec: b.playbackMsPerSec };
}
