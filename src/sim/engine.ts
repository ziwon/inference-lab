import type { CostModel, PanelId, PolicyId, SchedulerLimits } from './config.ts';
import { type CostBreakdown, iterationCost } from './cost.ts';
import { BlockAllocator, type MemoryPlan, blocksFor, completionReservation } from './memory.ts';
import { type AdmissionBlock, POLICIES, type PlannedEntry, type Skip, decideAdmission } from './scheduler.ts';
import {
  type InfeasibleReason,
  type ReducerContext,
  type RunOutcome,
  type SimEvent,
  type SimState,
  applyEvent,
  cloneState,
  initialState,
} from './state.ts';
import type { TraceItem } from './trace.ts';
import { durationUs } from './units.ts';

export const MAX_ITERATIONS = 100_000;

export interface IterationEntry extends PlannedEntry {
  newBlocks: number;
}

export interface Iteration {
  index: number;
  startUs: number;
  endUs: number;
  entries: IterationEntry[];
  skipped: Skip[];
  /** Admission decided at this iteration's decision instant, before planning. */
  admitted: number[];
  blocked: { request: number; reason: AdmissionBlock } | null;
  prefillTokens: number;
  decodeTokens: number;
  remainingTokens: number;
  cost: CostBreakdown;
}

export interface RequestHistory {
  arrivalUs: number;
  infeasible: InfeasibleReason | null;
  admittedUs: number | null;
  firstExecUs: number | null;
  prefills: { iteration: number; tokens: number; cachedBefore: number; final: boolean }[];
  decodeIterations: number[];
  tokenTimesUs: number[];
  releasedUs: number | null;
  peakBlocks: number;
}

export interface PanelInput {
  panel: PanelId;
  policy: PolicyId;
  limits: SchedulerLimits;
  memory: MemoryPlan;
  cost: CostModel;
  trace: readonly TraceItem[];
}

export interface PanelRun extends PanelInput {
  reservations: number[];
  infeasible: (InfeasibleReason | null)[];
  events: SimEvent[];
  iterations: Iteration[];
  /** Block ids per request in allocation order. A request's live blocks are always a prefix of this list. */
  blockIds: number[][];
  histories: RequestHistory[];
  outcome: RunOutcome;
  endUs: number;
  final: SimState;
  checkpoints: { interval: number; states: SimState[] };
}

export function reducerContext(run: Pick<PanelRun, 'trace' | 'iterations'>): ReducerContext {
  return { trace: run.trace, entriesOf: i => run.iterations[i]!.entries };
}

/**
 * Runs one panel to its terminal event. Each decision instant at time t, in order:
 * complete the executing iteration, release finished requests in admission order, apply arrivals with
 * arrival <= t in trace order, admit FIFO, then plan and start the next iteration. Arrivals strictly inside
 * an iteration are recorded at their own time and wait for the next instant.
 */
export function simulatePanel(input: PanelInput): PanelRun {
  const { trace, memory, limits } = input;
  const n = trace.length;
  const reservations = trace.map(r => completionReservation(r.promptTokens, r.outputTokens, memory.blockSizeTokens));
  const infeasible = reservations.map((need): InfeasibleReason | null =>
    need > memory.totalBlocks ? { code: 'reservationExceedsPool', needBlocks: need, totalBlocks: memory.totalBlocks } : null,
  );
  const iterations: Iteration[] = [];
  const events: SimEvent[] = [];
  const ctx = reducerContext({ trace, iterations });
  const state = initialState(n);
  const emit = (e: SimEvent) => {
    events.push(e);
    applyEvent(state, e, ctx);
  };
  const allocator = new BlockAllocator(memory.totalBlocks);
  const blockIds = trace.map((): number[] => []);
  let active: number[] = [];
  let nextArrival = 0;
  let nextAdmit = 0;
  let outcome: RunOutcome | null = null;

  const arrive = () => {
    const request = nextArrival++;
    const timeUs = trace[request]!.arrivalUs;
    emit({ kind: 'arrived', timeUs, request });
    const reason = infeasible[request];
    if (reason) emit({ kind: 'rejected', timeUs, request, reason });
  };

  let t = trace[0]?.arrivalUs ?? 0;
  while (outcome === null) {
    while (nextArrival < n && trace[nextArrival]!.arrivalUs <= t) arrive();

    const waiting: number[] = [];
    for (let i = nextAdmit; i < nextArrival; i++) if (state.requests[i]!.phase === 'waiting') waiting.push(i);
    const admission = decideAdmission({
      waiting,
      trace,
      activeCount: state.activeCount,
      reservedBlocks: state.reservedBlocks,
      totalBlocks: memory.totalBlocks,
      limits,
      reservationOf: i => reservations[i]!,
    });
    for (const request of admission.admit) {
      emit({ kind: 'admitted', timeUs: t, request, reservedBlocks: reservations[request]! });
      active.push(request);
    }
    while (nextAdmit < nextArrival && state.requests[nextAdmit]!.phase !== 'waiting') nextAdmit++;

    if (active.length === 0) {
      if (nextArrival < n) {
        t = trace[nextArrival]!.arrivalUs;
        continue;
      }
      outcome = waiting.length > admission.admit.length ? { code: 'stalled', waiting: waiting.length - admission.admit.length } : { code: 'drained' };
      break;
    }
    if (iterations.length >= MAX_ITERATIONS) {
      outcome = { code: 'truncated', maxIterations: MAX_ITERATIONS };
      break;
    }

    const plan = POLICIES[input.policy]({ requests: state.requests, trace, active, limits });
    if (plan.entries.length === 0) {
      outcome = { code: 'stalled', waiting: waiting.length };
      break;
    }
    const entries = plan.entries.map((entry): IterationEntry => {
      const r = state.requests[entry.request]!;
      const newBlocks = blocksFor(entry.cachedBefore + entry.tokens, memory.blockSizeTokens) - r.allocatedBlocks;
      if (r.allocatedBlocks + newBlocks > r.reservedBlocks) throw new Error(`request ${entry.request} would exceed its reservation`);
      for (let k = 0; k < newBlocks; k++) blockIds[entry.request]!.push(allocator.allocate());
      return { ...entry, newBlocks };
    });
    const prefills = entries.filter(e => e.kind === 'prefill');
    const decodes = entries.filter(e => e.kind === 'decode');
    const cost = iterationCost(input.cost, prefills, decodes);
    const prefillTokens = cost.prefillTokens;
    const endUs = t + durationUs(cost.totalMs);
    const index = iterations.length;
    iterations.push({
      index,
      startUs: t,
      endUs,
      entries,
      skipped: plan.skipped,
      admitted: admission.admit,
      blocked: admission.blocked,
      prefillTokens,
      decodeTokens: decodes.length,
      remainingTokens: limits.maxBatchTokens - prefillTokens - decodes.length,
      cost,
    });
    emit({ kind: 'iterationStarted', timeUs: t, iteration: index });
    while (nextArrival < n && trace[nextArrival]!.arrivalUs < endUs) arrive();
    t = endUs;
    emit({ kind: 'iterationCompleted', timeUs: t, iteration: index });
    for (const request of active) {
      const r = state.requests[request]!;
      if (r.phase !== 'finished') continue;
      allocator.free(blockIds[request]!);
      emit({ kind: 'released', timeUs: t, request, freedBlocks: r.allocatedBlocks, freedReservation: r.reservedBlocks });
    }
    active = active.filter(i => state.requests[i]!.phase !== 'completed');
  }
  emit({ kind: 'runEnded', timeUs: t, outcome });

  const base = { ...input, reservations, infeasible, events, iterations, blockIds, outcome, endUs: t, final: state };
  return { ...base, histories: buildHistories(base), checkpoints: buildCheckpoints(base) };
}

function buildHistories(run: Pick<PanelRun, 'trace' | 'events' | 'iterations' | 'infeasible' | 'reservations' | 'memory'>): RequestHistory[] {
  const out = run.trace.map(
    (r, i): RequestHistory => ({
      arrivalUs: r.arrivalUs,
      infeasible: run.infeasible[i] ?? null,
      admittedUs: null,
      firstExecUs: null,
      prefills: [],
      decodeIterations: [],
      tokenTimesUs: [],
      releasedUs: null,
      peakBlocks: 0,
    }),
  );
  for (const e of run.events) {
    if (e.kind === 'admitted') out[e.request]!.admittedUs = e.timeUs;
    if (e.kind === 'released') {
      out[e.request]!.releasedUs = e.timeUs;
      out[e.request]!.peakBlocks = e.freedBlocks;
    }
  }
  for (const it of run.iterations) {
    for (const entry of it.entries) {
      const h = out[entry.request]!;
      h.firstExecUs ??= it.startUs;
      if (entry.kind === 'prefill') h.prefills.push({ iteration: it.index, tokens: entry.tokens, cachedBefore: entry.cachedBefore, final: entry.final });
      else h.decodeIterations.push(it.index);
      if (entry.kind === 'decode' || entry.final) h.tokenTimesUs.push(it.endUs);
    }
  }
  return out;
}

function buildCheckpoints(run: Pick<PanelRun, 'trace' | 'events' | 'iterations'>): PanelRun['checkpoints'] {
  const interval = Math.max(64, Math.ceil(run.events.length / 400));
  const ctx = reducerContext(run);
  const state = initialState(run.trace.length);
  const states: SimState[] = [cloneState(state)];
  run.events.forEach((e, i) => {
    applyEvent(state, e, ctx);
    if ((i + 1) % interval === 0) states.push(cloneState(state));
  });
  return { interval, states };
}

const lastRead = new WeakMap<PanelRun, { applied: number; state: SimState }>();

/** State after the first `applied` events (0 = before the first event). Replays from the nearest checkpoint. */
export function stateAt(run: PanelRun, applied: number): Readonly<SimState> {
  const k = Math.max(0, Math.min(applied, run.events.length));
  const cached = lastRead.get(run);
  if (cached?.applied === k) return cached.state;
  const { interval, states } = run.checkpoints;
  const c = Math.floor(k / interval);
  const canContinue = cached !== undefined && cached.applied < k && Math.floor(cached.applied / interval) === c;
  const state = canContinue ? cloneState(cached.state) : cloneState(states[c]!);
  const ctx = reducerContext(run);
  for (let i = canContinue ? cached.applied : c * interval; i < k; i++) applyEvent(state, run.events[i]!, ctx);
  lastRead.set(run, { applied: k, state });
  return state;
}
