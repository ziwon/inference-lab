import { costGuaranteesProgress } from './cost';
import { memoryModel } from './memory';
import type { PanelId, PolicyId, SchedulerConfig, SimConfig, TraceRequest, ValidationIssue } from './types';

export const SIMULATOR_VERSION = '1.0.0';
export const CONFIG_VERSION = 1;

/** Hard limits that keep the browser responsive and inputs meaningful. */
export const LIMITS = {
  maxRequests: 500,
  maxTotalOutputTokens: 400_000,
  maxArrivalMs: 10_000_000,
  maxTokensPerRequest: 262_144,
  maxBlocks: 2_000_000,
  maxIterations: 60_000,
  seedMax: 4_294_967_295,
  idPattern: /^[A-Za-z0-9_.-]{1,24}$/,
} as const;

export const WEIGHT_BITS = [16, 8, 4] as const;
export const KV_ELEMENT_BYTES = [2, 1] as const;
export const POLICIES: readonly PolicyId[] = ['whole-prefill', 'chunked-prefill'];

interface Range { min: number; max: number; integer?: boolean }

/** Numeric field ranges, also used by the UI to bound inputs. */
export const RANGES = {
  paramsBillions: { min: 0.1, max: 2000 },
  numLayers: { min: 1, max: 256, integer: true },
  numQueryHeads: { min: 1, max: 256, integer: true },
  numKVHeads: { min: 1, max: 256, integer: true },
  headDim: { min: 8, max: 1024, integer: true },
  maxContextLength: { min: 16, max: LIMITS.maxTokensPerRequest, integer: true },
  weightMetadataPercent: { min: 0, max: 50 },
  deviceMemoryGiB: { min: 1, max: 4096 },
  runtimeAllowanceGiB: { min: 0, max: 4096 },
  blockSizeTokens: { min: 1, max: 256, integer: true },
  maxActiveSequences: { min: 1, max: 1024, integer: true },
  tokenBudget: { min: 1, max: LIMITS.maxTokensPerRequest, integer: true },
  maxPrefillChunk: { min: 1, max: LIMITS.maxTokensPerRequest, integer: true },
  cost: { min: 0, max: 10_000 },
  sloMs: { min: 0.001, max: 10_000_000 },
  seed: { min: 0, max: LIMITS.seedMax, integer: true },
  generatorCount: { min: 1, max: LIMITS.maxRequests, integer: true },
  generatorMs: { min: 0, max: LIMITS.maxArrivalMs },
  generatorTokens: { min: 1, max: LIMITS.maxTokensPerRequest, integer: true },
} satisfies Record<string, Range>;

function checkRange(issues: ValidationIssue[], path: string, value: number, range: Range, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: `${label} must be a finite number.` });
  } else if (range.integer && !Number.isInteger(value)) {
    issues.push({ path, message: `${label} must be a whole number.` });
  } else if (value < range.min || value > range.max) {
    issues.push({ path, message: `${label} must be between ${range.min} and ${range.max}.` });
  }
}

export function effectiveScheduler(config: SimConfig, panel: PanelId): SchedulerConfig {
  return { ...config.scheduler, ...config.panels[panel].overrides };
}

export function validateTrace(trace: readonly TraceRequest[], maxContextLength: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (trace.length === 0) issues.push({ path: 'workload', message: 'The trace needs at least one request.' });
  if (trace.length > LIMITS.maxRequests) issues.push({ path: 'workload', message: `The trace has ${trace.length} requests; the limit is ${LIMITS.maxRequests}.` });
  const ids = new Set<string>();
  let totalOutput = 0;
  trace.forEach((request, index) => {
    const path = `workload.requests[${index}]`;
    const name = typeof request.id === 'string' ? request.id : `#${index + 1}`;
    if (typeof request.id !== 'string' || !LIMITS.idPattern.test(request.id)) {
      issues.push({ path, message: `Request ${index + 1} needs an id of 1 to 24 letters, digits, ".", "_" or "-".` });
    } else if (ids.has(request.id)) {
      issues.push({ path, message: `Request id ${request.id} is duplicated.` });
    } else {
      ids.add(request.id);
    }
    if (!Number.isFinite(request.arrivalMs) || request.arrivalMs < 0 || request.arrivalMs > LIMITS.maxArrivalMs) {
      issues.push({ path, message: `${name}: arrival must be between 0 and ${LIMITS.maxArrivalMs} ms.` });
    }
    if (!Number.isInteger(request.promptTokens) || request.promptTokens < 1) {
      issues.push({ path, message: `${name}: prompt tokens must be a positive whole number.` });
    }
    if (!Number.isInteger(request.outputTokens) || request.outputTokens < 1) {
      issues.push({ path, message: `${name}: output tokens must be a positive whole number.` });
    }
    if (request.promptTokens + request.outputTokens > maxContextLength) {
      issues.push({ path, message: `${name}: P + G = ${request.promptTokens + request.outputTokens} exceeds the maximum context length ${maxContextLength}.` });
    }
    totalOutput += Number.isFinite(request.outputTokens) ? request.outputTokens : 0;
  });
  if (totalOutput > LIMITS.maxTotalOutputTokens) {
    issues.push({ path: 'workload', message: `The trace requests ${totalOutput} output tokens; the limit is ${LIMITS.maxTotalOutputTokens}.` });
  }
  return issues;
}

/** Validates everything both panels share: architecture, memory, cost, SLOs, workload inputs. */
export function validateConfig(config: SimConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { architecture: a, precision: p, memory: m, scheduler: s, cost: c, slo } = config;
  checkRange(issues, 'seed', config.seed, RANGES.seed, 'Seed');
  checkRange(issues, 'architecture.paramsBillions', a.paramsBillions, RANGES.paramsBillions, 'Parameters');
  checkRange(issues, 'architecture.numLayers', a.numLayers, RANGES.numLayers, 'Layers');
  checkRange(issues, 'architecture.numQueryHeads', a.numQueryHeads, RANGES.numQueryHeads, 'Query heads');
  checkRange(issues, 'architecture.numKVHeads', a.numKVHeads, RANGES.numKVHeads, 'KV heads');
  checkRange(issues, 'architecture.headDim', a.headDim, RANGES.headDim, 'Head dimension');
  checkRange(issues, 'architecture.maxContextLength', a.maxContextLength, RANGES.maxContextLength, 'Maximum context length');
  if (Number.isInteger(a.numKVHeads) && Number.isInteger(a.numQueryHeads) && a.numKVHeads >= 1) {
    if (a.numKVHeads > a.numQueryHeads) issues.push({ path: 'architecture.numKVHeads', message: 'KV heads cannot exceed query heads.' });
    else if (a.numQueryHeads % a.numKVHeads !== 0) issues.push({ path: 'architecture.numKVHeads', message: 'Query heads must be a multiple of KV heads (MHA or GQA).' });
  }
  if (!(WEIGHT_BITS as readonly number[]).includes(p.weightBits)) issues.push({ path: 'precision.weightBits', message: 'Weight precision must be 16, 8, or 4 bits.' });
  if (!(KV_ELEMENT_BYTES as readonly number[]).includes(p.kvElementBytes)) issues.push({ path: 'precision.kvElementBytes', message: 'KV element size must be 2 or 1 bytes.' });
  checkRange(issues, 'precision.weightMetadataPercent', p.weightMetadataPercent, RANGES.weightMetadataPercent, 'Quantization metadata allowance');
  checkRange(issues, 'memory.deviceMemoryGiB', m.deviceMemoryGiB, RANGES.deviceMemoryGiB, 'Device memory');
  checkRange(issues, 'memory.runtimeAllowanceGiB', m.runtimeAllowanceGiB, RANGES.runtimeAllowanceGiB, 'Runtime allowance');
  checkRange(issues, 'memory.blockSizeTokens', m.blockSizeTokens, RANGES.blockSizeTokens, 'Block size');
  checkRange(issues, 'scheduler.maxActiveSequences', s.maxActiveSequences, RANGES.maxActiveSequences, 'Max active sequences');
  checkRange(issues, 'scheduler.tokenBudget', s.tokenBudget, RANGES.tokenBudget, 'Token budget');
  checkRange(issues, 'scheduler.maxPrefillChunk', s.maxPrefillChunk, RANGES.maxPrefillChunk, 'Max prefill chunk');
  checkRange(issues, 'cost.iterationOverheadMs', c.iterationOverheadMs, RANGES.cost, 'Iteration overhead');
  checkRange(issues, 'cost.linearMsPerToken', c.linearMsPerToken, RANGES.cost, 'Linear cost');
  checkRange(issues, 'cost.prefillAttentionMsPerMillionPairs', c.prefillAttentionMsPerMillionPairs, RANGES.cost, 'Prefill attention cost');
  checkRange(issues, 'cost.decodeAttentionMsPerThousandPositions', c.decodeAttentionMsPerThousandPositions, RANGES.cost, 'Decode attention cost');
  checkRange(issues, 'slo.ttftMs', slo.ttftMs, RANGES.sloMs, 'TTFT SLO');
  checkRange(issues, 'slo.tpotMs', slo.tpotMs, RANGES.sloMs, 'TPOT SLO');
  if (!costGuaranteesProgress(c)) {
    issues.push({ path: 'cost', message: 'The cost model allows zero-duration iterations. Set a positive overhead or linear cost, or make both attention costs positive.' });
  }
  for (const panel of ['A', 'B'] as const) {
    const pc = config.panels[panel];
    if (!POLICIES.includes(pc.policy)) issues.push({ path: `panels.${panel}.policy`, message: `Panel ${panel} has an unknown policy.` });
    for (const key of ['maxActiveSequences', 'tokenBudget', 'maxPrefillChunk'] as const) {
      const value = pc.overrides[key];
      if (value !== undefined) checkRange(issues, `panels.${panel}.overrides.${key}`, value, RANGES[key], `Panel ${panel} ${key}`);
    }
  }
  if (config.workload.kind === 'generated') {
    const g = config.workload.params;
    checkRange(issues, 'workload.params.count', g.count, RANGES.generatorCount, 'Request count');
    checkRange(issues, 'workload.params.startMs', g.startMs, RANGES.generatorMs, 'First arrival');
    checkRange(issues, 'workload.params.meanInterArrivalMs', g.meanInterArrivalMs, RANGES.generatorMs, 'Mean inter-arrival gap');
    for (const key of ['promptMin', 'promptMax', 'outputMin', 'outputMax'] as const) {
      checkRange(issues, `workload.params.${key}`, g[key], RANGES.generatorTokens, key);
    }
    if (g.promptMin > g.promptMax) issues.push({ path: 'workload.params.promptMin', message: 'Minimum prompt length exceeds the maximum.' });
    if (g.outputMin > g.outputMax) issues.push({ path: 'workload.params.outputMin', message: 'Minimum output length exceeds the maximum.' });
  }
  if (issues.length === 0) {
    const mem = memoryModel(a, p, m);
    if (mem.weightBytes + mem.runtimeAllowanceBytes >= mem.deviceBytes) {
      issues.push({ path: 'memory.deviceMemoryGiB', message: 'Weights plus the runtime allowance do not fit in device memory, so no KV cache can be allocated.' });
    } else if (mem.totalBlocks < 1) {
      issues.push({ path: 'memory.blockSizeTokens', message: 'The KV pool is smaller than one block.' });
    } else if (mem.totalBlocks > LIMITS.maxBlocks) {
      issues.push({ path: 'memory.blockSizeTokens', message: `The KV pool has ${mem.totalBlocks} blocks; the limit is ${LIMITS.maxBlocks}. Increase the block size.` });
    }
  }
  return issues;
}

/** Panel-specific checks: the whole-prefill baseline cannot schedule a prompt larger than its token budget. */
export function validatePanel(config: SimConfig, panel: PanelId, trace: readonly TraceRequest[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scheduler = effectiveScheduler(config, panel);
  if (config.panels[panel].policy === 'whole-prefill') {
    const oversized = trace.filter(r => r.promptTokens > scheduler.tokenBudget);
    if (oversized.length > 0) {
      const worst = oversized.reduce((a, b) => (b.promptTokens > a.promptTokens ? b : a));
      issues.push({
        path: `panels.${panel}`,
        message: `Incompatible A/B configuration: whole-prefill never splits prompts, but ${oversized.length} prompt${oversized.length > 1 ? 's exceed' : ' exceeds'} the ${scheduler.tokenBudget}-token iteration budget (largest: ${worst.id}, ${worst.promptTokens} tokens). Raise this panel's token budget to at least ${worst.promptTokens} or shorten the prompts.`,
      });
    }
  }
  return issues;
}
