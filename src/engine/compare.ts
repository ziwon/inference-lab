import { effectiveScheduler } from './config';
import type { RequestMetrics } from './metrics';
import type { PolicyId, SimConfig } from './types';

// A/B comparison helpers. Both panels always share the trace, seed, architecture,
// memory, cost model, and SLOs; only policy and explicit scheduler overrides can differ.

export interface PanelDifference {
  field: 'policy' | 'tokenBudget' | 'maxActiveSequences' | 'maxPrefillChunk';
  a: string | number;
  b: string | number;
  /** True when one side ignores the field (chunk size under whole-prefill). */
  inactiveOn?: 'A' | 'B';
}

export function panelDifferences(config: SimConfig): PanelDifference[] {
  const diffs: PanelDifference[] = [];
  const pa: PolicyId = config.panels.A.policy;
  const pb: PolicyId = config.panels.B.policy;
  if (pa !== pb) diffs.push({ field: 'policy', a: pa, b: pb });
  const sa = effectiveScheduler(config, 'A');
  const sb = effectiveScheduler(config, 'B');
  if (sa.tokenBudget !== sb.tokenBudget) diffs.push({ field: 'tokenBudget', a: sa.tokenBudget, b: sb.tokenBudget });
  if (sa.maxActiveSequences !== sb.maxActiveSequences) diffs.push({ field: 'maxActiveSequences', a: sa.maxActiveSequences, b: sb.maxActiveSequences });
  const chunkUsedA = pa === 'chunked-prefill';
  const chunkUsedB = pb === 'chunked-prefill';
  if (chunkUsedA && chunkUsedB && sa.maxPrefillChunk !== sb.maxPrefillChunk) {
    diffs.push({ field: 'maxPrefillChunk', a: sa.maxPrefillChunk, b: sb.maxPrefillChunk });
  } else if (chunkUsedA !== chunkUsedB) {
    diffs.push({ field: 'maxPrefillChunk', a: sa.maxPrefillChunk, b: sb.maxPrefillChunk, inactiveOn: chunkUsedA ? 'B' : 'A' });
  }
  return diffs;
}

export interface RequestComparison {
  req: number;
  id: string;
  a: RequestMetrics;
  b: RequestMetrics;
  ttftDeltaMs: number | null;
  e2eDeltaMs: number | null;
  maxItlDeltaMs: number | null;
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export function compareRequests(a: readonly RequestMetrics[], b: readonly RequestMetrics[]): RequestComparison[] {
  return a.map((ra, i) => {
    const rb = b[i];
    return { req: ra.req, id: ra.id, a: ra, b: rb, ttftDeltaMs: delta(ra.ttftMs, rb.ttftMs), e2eDeltaMs: delta(ra.e2eMs, rb.e2eMs), maxItlDeltaMs: delta(ra.maxItlMs, rb.maxItlMs) };
  });
}
