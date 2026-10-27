import type { TraceItem } from './trace.ts';

export type Phase = 'pending' | 'waiting' | 'infeasible' | 'admitted' | 'prefilling' | 'decoding' | 'awaitingRelease' | 'completed';

export const LIVE_PHASES: readonly Phase[] = ['admitted', 'prefilling', 'decoding', 'awaitingRelease'];

export interface RequestState {
  phase: Phase;
  cachedTokens: number;
  inflightTokens: number;
  generatedTokens: number;
  allocatedBlocks: number;
  reservedBlocks: number;
  lastServedIteration: number;
}

export type RunOutcome = { code: 'drained' } | { code: 'truncated'; limit: 'iterations' | 'records'; max: number };

export interface SimState {
  timeUs: number;
  requests: RequestState[];
  executing: number | null;
  iterationsStarted: number;
  activeCount: number;
  reservedBlocks: number;
  allocatedBlocks: number;
  peakAllocatedBlocks: number;
  completedCount: number;
  ended: RunOutcome | null;
}

export type InfeasibleReason = { code: 'reservationExceedsPool'; needBlocks: number; totalBlocks: number };

export type SimEvent =
  | { kind: 'arrived'; timeUs: number; request: number }
  | { kind: 'rejected'; timeUs: number; request: number; reason: InfeasibleReason }
  | { kind: 'admitted'; timeUs: number; request: number; reservedBlocks: number }
  | { kind: 'iterationStarted'; timeUs: number; iteration: number }
  | { kind: 'iterationCompleted'; timeUs: number; iteration: number }
  | { kind: 'released'; timeUs: number; request: number; freedBlocks: number; freedReservation: number }
  | { kind: 'runEnded'; timeUs: number; outcome: RunOutcome };

export interface AppliedEntry {
  request: number;
  kind: 'prefill' | 'decode';
  tokens: number;
  newBlocks: number;
  emitsFirstToken: boolean;
}

export const emitsToken = (entry: Pick<AppliedEntry, 'kind' | 'emitsFirstToken'>) => entry.kind === 'decode' || entry.emitsFirstToken;

export interface ReducerContext {
  trace: readonly TraceItem[];
  entriesOf: (iteration: number) => readonly AppliedEntry[];
}

export function initialState(count: number): SimState {
  return {
    timeUs: 0,
    requests: Array.from({ length: count }, () => ({
      phase: 'pending' as Phase,
      cachedTokens: 0,
      inflightTokens: 0,
      generatedTokens: 0,
      allocatedBlocks: 0,
      reservedBlocks: 0,
      lastServedIteration: -1,
    })),
    executing: null,
    iterationsStarted: 0,
    activeCount: 0,
    reservedBlocks: 0,
    allocatedBlocks: 0,
    peakAllocatedBlocks: 0,
    completedCount: 0,
    ended: null,
  };
}

export const cloneState = (s: SimState): SimState => ({ ...s, requests: s.requests.map(r => ({ ...r })) });

const fail = (e: SimEvent, why: string): never => {
  throw new Error(`illegal ${e.kind} at ${e.timeUs}us: ${why}`);
};

export function applyEvent(s: SimState, e: SimEvent, ctx: ReducerContext): void {
  if (e.timeUs < s.timeUs) fail(e, 'time moved backward');
  s.timeUs = e.timeUs;
  switch (e.kind) {
    case 'arrived': {
      const r = s.requests[e.request]!;
      if (r.phase !== 'pending') fail(e, `request ${e.request} is ${r.phase}`);
      r.phase = 'waiting';
      return;
    }
    case 'rejected': {
      const r = s.requests[e.request]!;
      if (r.phase !== 'waiting') fail(e, `request ${e.request} is ${r.phase}`);
      r.phase = 'infeasible';
      return;
    }
    case 'admitted': {
      const r = s.requests[e.request]!;
      if (r.phase !== 'waiting') fail(e, `request ${e.request} is ${r.phase}`);
      r.phase = 'admitted';
      r.reservedBlocks = e.reservedBlocks;
      s.reservedBlocks += e.reservedBlocks;
      s.activeCount += 1;
      return;
    }
    case 'iterationStarted': {
      if (s.executing !== null) fail(e, `iteration ${s.executing} still executing`);
      s.executing = e.iteration;
      s.iterationsStarted += 1;
      for (const entry of ctx.entriesOf(e.iteration)) {
        const r = s.requests[entry.request]!;
        r.inflightTokens = entry.tokens;
        r.allocatedBlocks += entry.newBlocks;
        r.lastServedIteration = e.iteration;
        s.allocatedBlocks += entry.newBlocks;
      }
      s.peakAllocatedBlocks = Math.max(s.peakAllocatedBlocks, s.allocatedBlocks);
      return;
    }
    case 'iterationCompleted': {
      if (s.executing !== e.iteration) fail(e, `iteration ${e.iteration} is not executing`);
      s.executing = null;
      for (const entry of ctx.entriesOf(e.iteration)) {
        const r = s.requests[entry.request]!;
        const item = ctx.trace[entry.request]!;
        r.cachedTokens += r.inflightTokens;
        r.inflightTokens = 0;
        if (emitsToken(entry)) r.generatedTokens += 1;
        r.phase =
          r.cachedTokens < item.promptTokens ? 'prefilling'
          : r.generatedTokens === item.outputTokens ? 'awaitingRelease'
          : 'decoding';
      }
      return;
    }
    case 'released': {
      const r = s.requests[e.request]!;
      if (r.phase !== 'awaitingRelease') fail(e, `request ${e.request} is ${r.phase}`);
      if (e.freedBlocks !== r.allocatedBlocks || e.freedReservation !== r.reservedBlocks) fail(e, 'release does not match holdings');
      s.allocatedBlocks -= r.allocatedBlocks;
      s.reservedBlocks -= r.reservedBlocks;
      s.activeCount -= 1;
      s.completedCount += 1;
      r.phase = 'completed';
      r.cachedTokens = 0;
      r.allocatedBlocks = 0;
      r.reservedBlocks = 0;
      return;
    }
    case 'runEnded':
      s.ended = e.outcome;
      return;
  }
}
