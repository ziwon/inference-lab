import type { Iteration, PanelRun } from './engine.ts';
import { type AdmissionBlock, decideAdmission } from './scheduler.ts';
import { LIVE_PHASES, type RequestState, type SimState } from './state.ts';

export interface MemoryRow {
  request: number;
  cachedTokens: number;
  inflightTokens: number;
  allocatedBlocks: number;
  reservedBlocks: number;
  fragmentationTokens: number;
}

export interface MemoryView {
  totalBlocks: number;
  allocatedBlocks: number;
  reservedUnallocatedBlocks: number;
  unreservedBlocks: number;
  freeBlocks: number;
  cachedTokens: number;
  inflightTokens: number;
  fragmentationTokens: number;
  peakAllocatedBlocks: number;
  rows: MemoryRow[];
}

export function memoryView(run: PanelRun, state: Readonly<SimState>): MemoryView {
  const bs = run.memory.blockSizeTokens;
  const rows: MemoryRow[] = [];
  state.requests.forEach((r, request) => {
    if (!LIVE_PHASES.includes(r.phase)) return;
    rows.push({
      request,
      cachedTokens: r.cachedTokens,
      inflightTokens: r.inflightTokens,
      allocatedBlocks: r.allocatedBlocks,
      reservedBlocks: r.reservedBlocks,
      fragmentationTokens: r.allocatedBlocks * bs - r.cachedTokens - r.inflightTokens,
    });
  });
  const sum = (f: (row: MemoryRow) => number) => rows.reduce((s, row) => s + f(row), 0);
  return {
    totalBlocks: run.memory.totalBlocks,
    allocatedBlocks: state.allocatedBlocks,
    reservedUnallocatedBlocks: state.reservedBlocks - state.allocatedBlocks,
    unreservedBlocks: run.memory.totalBlocks - state.reservedBlocks,
    freeBlocks: run.memory.totalBlocks - state.allocatedBlocks,
    cachedTokens: sum(row => row.cachedTokens),
    inflightTokens: sum(row => row.inflightTokens),
    fragmentationTokens: sum(row => row.fragmentationTokens),
    peakAllocatedBlocks: state.peakAllocatedBlocks,
    rows,
  };
}

export type WaitReason =
  | AdmissionBlock
  | { code: 'queuedBehind'; head: number }
  | { code: 'awaitingDecision' };

function waitReasonAt(run: PanelRun, request: number, decision: Iteration | undefined): WaitReason {
  const arrivalUs = run.trace[request]!.arrivalUs;
  if (!decision || arrivalUs > decision.startUs || !decision.blocked) return { code: 'awaitingDecision' };
  if (decision.blocked.request === request) return decision.blocked.reason;
  return { code: 'queuedBehind', head: decision.blocked.request };
}

export function waitReason(run: PanelRun, state: Readonly<SimState>, request: number): WaitReason {
  const waiting = state.requests.flatMap((r, i) => (r.phase === 'waiting' && !run.infeasible[i] ? [i] : []));
  const { admit, blocked } = decideAdmission({
    waiting,
    trace: run.trace,
    activeCount: state.activeCount,
    reservedBlocks: state.reservedBlocks,
    totalBlocks: run.memory.totalBlocks,
    limits: run.limits,
    reservationOf: i => run.reservations[i]!,
  });
  if (!blocked || admit.length > 0) return { code: 'awaitingDecision' };
  return blocked.request === request ? blocked.reason : { code: 'queuedBehind', head: blocked.request };
}

export function currentIteration(run: PanelRun, state: Readonly<SimState>): Iteration | null {
  return run.iterations[state.iterationsStarted - 1] ?? null;
}

export interface IterationWaiter {
  request: number;
  reason: WaitReason;
}

export function iterationWaiters(run: PanelRun, it: Iteration, state: Readonly<SimState>): { queued: IterationWaiter[]; arrivedDuring: number[] } {
  const queued: IterationWaiter[] = [];
  const arrivedDuring: number[] = [];
  run.histories.forEach((h, request) => {
    if (h.infeasible) return;
    if (h.arrivalUs <= it.startUs && (h.admittedUs === null || h.admittedUs > it.startUs)) {
      queued.push({ request, reason: waitReasonAt(run, request, it) });
    } else if (h.arrivalUs > it.startUs && h.arrivalUs < it.endUs && state.requests[request]!.phase !== 'pending') {
      arrivedDuring.push(request);
    }
  });
  return { queued, arrivedDuring };
}

export function liveBlockIds(run: PanelRun, r: RequestState, request: number): number[] {
  return run.blockAllocationOrder[request]!.slice(0, r.allocatedBlocks);
}
