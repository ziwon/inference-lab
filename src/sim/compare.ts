import { type Issue, LIMIT_KEYS, PANEL_IDS, type PanelId, type SchedulerLimits, type SimConfig, type TraceRequest, resolveLimits } from './config.ts';
import { zeroDurationWork } from './cost.ts';
import { type PanelRun, simulatePanel } from './engine.ts';
import { type MemoryPlan, completionReservation, planMemory } from './memory.ts';
import { usedBy } from './scheduler.ts';
import { type TraceItem, materializeTrace, normalizeTrace } from './trace.ts';
import { type Result, err, ok } from './units.ts';

export const MAX_TOTAL_OUTPUT_TOKENS = 250_000;
export const MAX_TOTAL_KV_BLOCKS = 2 ** 21;

export interface Comparison {
  config: SimConfig;
  requests: TraceRequest[];
  trace: TraceItem[];
  memory: MemoryPlan;
  panels: Record<PanelId, PanelRun>;
  steps: {
    timeUs: number[];
    panel: PanelId[];
    event: number[];
    appliedAfterStep: Record<PanelId, Int32Array>;
  };
  endUs: number;
}

export function semanticIssues(config: SimConfig, trace: readonly TraceItem[], memory: MemoryPlan): Issue[] {
  const issues: Issue[] = [];
  if (memory.kvPoolBytes <= 0) {
    issues.push({
      path: 'memory',
      code: 'weightsDoNotFit',
      params: { weightBytes: memory.weightBytes, runtimeAllowanceBytes: memory.runtimeAllowanceBytes, deviceBytes: memory.deviceBytes },
    });
  } else if (memory.totalBlocks < 1) {
    issues.push({ path: 'memory', code: 'noKvBlocks', params: { kvPoolBytes: memory.kvPoolBytes, kvBlockBytes: memory.kvBlockBytes } });
  }
  for (const kind of zeroDurationWork(config.cost)) issues.push({ path: 'cost', code: 'zeroDurationWork', params: { kind } });
  const totalOutput = trace.reduce((sum, r) => sum + r.outputTokens, 0);
  if (totalOutput > MAX_TOTAL_OUTPUT_TOKENS) issues.push({ path: 'trace', code: 'tooLarge', params: { total: totalOutput, max: MAX_TOTAL_OUTPUT_TOKENS } });
  const reservations = trace.map(r => completionReservation(r.promptTokens, r.outputTokens, memory.blockSizeTokens));
  const totalBlocks = reservations.reduce((sum, need) => (need <= memory.totalBlocks ? sum + need : sum), 0);
  if (totalBlocks > MAX_TOTAL_KV_BLOCKS) issues.push({ path: 'trace', code: 'tooManyKvBlocks', params: { total: totalBlocks, max: MAX_TOTAL_KV_BLOCKS } });
  for (const panel of PANEL_IDS) {
    if (config.panels[panel].policy !== 'whole-prefill') continue;
    const budget = resolveLimits(config, panel).maxBatchTokens;
    const fitsPool = (r: TraceItem) => completionReservation(r.promptTokens, r.outputTokens, memory.blockSizeTokens) <= memory.totalBlocks;
    const oversized = trace.find(r => fitsPool(r) && r.promptTokens > budget);
    if (oversized) {
      issues.push({
        path: `panels.${panel}`,
        code: 'promptExceedsWholePrefillBudget',
        params: { panel, id: oversized.id, promptTokens: oversized.promptTokens, budget },
      });
    }
  }
  return issues;
}

export function buildComparison(config: SimConfig): Result<Comparison, Issue[]> {
  const requests = materializeTrace(config.trace, config.seed);
  const trace = normalizeTrace(requests);
  const memory = planMemory(config.architecture, config.memory);
  const issues = semanticIssues(config, trace, memory);
  if (issues.length > 0) return err(issues);
  const run = (panel: PanelId) =>
    simulatePanel({ panel, policy: config.panels[panel].policy, limits: resolveLimits(config, panel), memory, cost: config.cost, trace });
  const panels = { A: run('A'), B: run('B') };
  return ok({ config, requests, trace, memory, panels, steps: mergeSteps(panels), endUs: Math.max(panels.A.endUs, panels.B.endUs) });
}

function mergeSteps(panels: Record<PanelId, PanelRun>): Comparison['steps'] {
  const a = panels.A.events;
  const b = panels.B.events;
  const total = a.length + b.length;
  const timeUs: number[] = [];
  const panel: PanelId[] = [];
  const event: number[] = [];
  const appliedAfterStep = { A: new Int32Array(total + 1), B: new Int32Array(total + 1) };
  let i = 0;
  let j = 0;
  for (let k = 0; k < total; k++) {
    const takeA = j >= b.length || (i < a.length && a[i]!.timeUs <= b[j]!.timeUs);
    if (takeA) {
      timeUs.push(a[i]!.timeUs);
      panel.push('A');
      event.push(i++);
    } else {
      timeUs.push(b[j]!.timeUs);
      panel.push('B');
      event.push(j++);
    }
    appliedAfterStep.A[k + 1] = i;
    appliedAfterStep.B[k + 1] = j;
  }
  return { timeUs, panel, event, appliedAfterStep };
}

export function appliedAtTime(cmp: Comparison, timeUs: number): number {
  const times = cmp.steps.timeUs;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= timeUs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Playhead {
  applied: number;
  timeUs: number;
}

export const startPlayhead = (cmp: Comparison): Playhead => ({ applied: 0, timeUs: cmp.steps.timeUs[0] ?? 0 });

export function seekTime(cmp: Comparison, timeUs: number): Playhead {
  const t = Math.max(0, Math.min(timeUs, cmp.endUs));
  return { applied: appliedAtTime(cmp, t), timeUs: t };
}

export function seekStep(cmp: Comparison, applied: number): Playhead {
  const k = Math.max(0, Math.min(applied, cmp.steps.timeUs.length));
  return { applied: k, timeUs: k === 0 ? (cmp.steps.timeUs[0] ?? 0) : cmp.steps.timeUs[k - 1]! };
}

export const panelApplied = (cmp: Comparison, at: Playhead, panel: PanelId) => cmp.steps.appliedAfterStep[panel][at.applied]!;

export interface LimitDifference {
  limit: keyof SchedulerLimits;
  shared: number;
  values: Record<PanelId, number>;
  unusedBy: PanelId[];
}

export function limitDifferences(config: SimConfig): LimitDifference[] {
  return LIMIT_KEYS.flatMap(limit => {
    const shared = config.scheduler[limit];
    const values = { A: resolveLimits(config, 'A')[limit], B: resolveLimits(config, 'B')[limit] };
    if (PANEL_IDS.every(p => values[p] === shared)) return [];
    return [{ limit, shared, values, unusedBy: PANEL_IDS.filter(p => !usedBy(config.panels[p].policy, limit)) }];
  });
}
