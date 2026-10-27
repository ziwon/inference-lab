import { blocksFor } from './tokens';
import type { IterationRecord, SimEvent, SimResult } from './types';

// Snapshots are derived from the immutable event log, so stepping backward and forward
// is just folding a different prefix of events. Checkpoints keep folds short.

export type RequestPhase = 'not-arrived' | 'waiting' | 'admitted' | 'prefill' | 'decode' | 'complete' | 'infeasible';

export interface RequestView {
  req: number;
  phase: RequestPhase;
  prefilledTokens: number;
  /** Populated KV positions (committed at iteration end). */
  cachedTokens: number;
  /** Positions being written by the iteration currently running. */
  inFlightTokens: number;
  generatedTokens: number;
  allocatedBlocks: number;
  reservedBlocks: number;
  /** Selected in the iteration currently running. */
  running: boolean;
  /** Retained after release so completed requests keep their historical footprint. */
  peakAllocatedBlocks: number;
}

export interface Snapshot {
  time: number;
  /** Number of events applied. */
  eventCount: number;
  requests: RequestView[];
  waiting: number[];
  active: number[];
  /** Iteration running at this time, if any. */
  runningIteration: number | null;
  /** Most recently started iteration. */
  lastIteration: number | null;
  allocatedBlocks: number;
  reservedBlocks: number;
  cachedTokens: number;
  inFlightTokens: number;
  finished: { status: string; reason: string } | null;
}

function initialSnapshot(result: SimResult): Snapshot {
  return {
    time: 0,
    eventCount: 0,
    requests: result.trace.map((_, req) => ({
      req, phase: 'not-arrived', prefilledTokens: 0, cachedTokens: 0, inFlightTokens: 0, generatedTokens: 0,
      allocatedBlocks: 0, reservedBlocks: 0, running: false, peakAllocatedBlocks: 0,
    })),
    waiting: [],
    active: [],
    runningIteration: null,
    lastIteration: null,
    allocatedBlocks: 0,
    reservedBlocks: 0,
    cachedTokens: 0,
    inFlightTokens: 0,
    finished: null,
  };
}

function cloneSnapshot(s: Snapshot): Snapshot {
  return { ...s, requests: s.requests.map(r => ({ ...r })), waiting: [...s.waiting], active: [...s.active], finished: s.finished ? { ...s.finished } : null };
}

/** Apply one event in place. Mirrors the simulator's state transitions. */
export function applyEvent(s: Snapshot, e: SimEvent, iterations: readonly IterationRecord[], blockSize: number): void {
  s.time = e.t;
  s.eventCount += 1;
  switch (e.type) {
    case 'arrival':
      s.requests[e.req].phase = 'waiting';
      s.waiting.push(e.req);
      break;
    case 'admit': {
      const r = s.requests[e.req];
      r.phase = 'admitted';
      r.reservedBlocks = e.reservedBlocks;
      s.reservedBlocks += e.reservedBlocks;
      s.waiting.splice(s.waiting.indexOf(e.req), 1);
      s.active.push(e.req);
      break;
    }
    case 'infeasible':
      s.requests[e.req].phase = 'infeasible';
      s.waiting.splice(s.waiting.indexOf(e.req), 1);
      break;
    case 'iteration-start': {
      const it = e.iteration;
      s.runningIteration = it.index;
      s.lastIteration = it.index;
      for (const item of it.items) {
        const r = s.requests[item.req];
        r.running = true;
        r.inFlightTokens = item.tokens;
        r.allocatedBlocks += item.newBlocks.length;
        r.peakAllocatedBlocks = Math.max(r.peakAllocatedBlocks, r.allocatedBlocks);
        s.allocatedBlocks += item.newBlocks.length;
        s.inFlightTokens += item.tokens;
        if (item.kind === 'prefill') r.phase = 'prefill';
      }
      break;
    }
    case 'iteration-end': {
      const it = iterations[e.index];
      for (const item of it.items) {
        const r = s.requests[item.req];
        r.running = false;
        r.cachedTokens += item.tokens;
        r.inFlightTokens = 0;
        s.cachedTokens += item.tokens;
        s.inFlightTokens -= item.tokens;
        if (item.kind === 'prefill') r.prefilledTokens += item.tokens;
        // Consistency: blocks always cover populated positions exactly.
        if (r.allocatedBlocks !== blocksFor(r.cachedTokens, blockSize)) throw new Error(`Replay mismatch for request ${item.req}`);
      }
      for (const { req, token } of e.emitted) {
        const r = s.requests[req];
        r.generatedTokens = token;
        r.phase = 'decode';
      }
      s.runningIteration = null;
      break;
    }
    case 'complete':
      s.requests[e.req].phase = 'complete';
      break;
    case 'release': {
      const r = s.requests[e.req];
      s.allocatedBlocks -= r.allocatedBlocks;
      s.reservedBlocks -= r.reservedBlocks;
      s.cachedTokens -= r.cachedTokens;
      r.allocatedBlocks = 0;
      r.reservedBlocks = 0;
      s.active.splice(s.active.indexOf(e.req), 1);
      break;
    }
    case 'finished':
      s.finished = { status: e.status, reason: e.reason };
      break;
    case 'admission-blocked':
    case 'idle':
      break;
  }
}

export interface Replayer {
  /** Number of events with time <= t. */
  countAt(t: number): number;
  snapshotAt(t: number): Snapshot;
  snapshotAfter(eventCount: number): Snapshot;
}

export function createReplayer(result: SimResult, blockSize: number): Replayer {
  const events = result.events;
  const interval = Math.max(64, Math.ceil((events.length * Math.max(1, result.trace.length)) / 150_000));
  const checkpoints: Snapshot[] = [];
  const s = initialSnapshot(result);
  checkpoints.push(cloneSnapshot(s));
  for (let i = 0; i < events.length; i++) {
    applyEvent(s, events[i], result.iterations, blockSize);
    if ((i + 1) % interval === 0) checkpoints.push(cloneSnapshot(s));
  }
  const times = events.map(e => e.t);
  const countAt = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const snapshotAfter = (eventCount: number) => {
    const n = Math.max(0, Math.min(events.length, eventCount));
    const snap = cloneSnapshot(checkpoints[Math.floor(n / interval)]);
    for (let i = snap.eventCount; i < n; i++) applyEvent(snap, events[i], result.iterations, blockSize);
    return snap;
  };
  return {
    countAt,
    snapshotAfter,
    snapshotAt: (t: number) => {
      const snap = snapshotAfter(countAt(t));
      snap.time = t;
      return snap;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-request timelines for drawing lanes and computing metrics.

export interface WorkSegment {
  kind: 'prefill' | 'decode';
  iteration: number;
  startMs: number;
  endMs: number;
  tokens: number;
  contextBefore: number;
}

export interface RequestTimeline {
  req: number;
  arrivalMs: number | null;
  admittedMs: number | null;
  infeasibleMs: number | null;
  completedMs: number | null;
  firstExecutionMs: number | null;
  segments: WorkSegment[];
  /** Emission time of output token k at index k-1. */
  tokenTimes: number[];
}

export function buildTimelines(result: SimResult): RequestTimeline[] {
  const lanes: RequestTimeline[] = result.trace.map((_, req) => ({
    req, arrivalMs: null, admittedMs: null, infeasibleMs: null, completedMs: null, firstExecutionMs: null, segments: [], tokenTimes: [],
  }));
  for (const e of result.events) {
    switch (e.type) {
      case 'arrival': lanes[e.req].arrivalMs = e.t; break;
      case 'admit': lanes[e.req].admittedMs = e.t; break;
      case 'infeasible': lanes[e.req].infeasibleMs = e.t; break;
      case 'complete': lanes[e.req].completedMs = e.t; break;
      case 'iteration-start':
        for (const item of e.iteration.items) {
          const lane = lanes[item.req];
          if (lane.firstExecutionMs === null) lane.firstExecutionMs = e.t;
          lane.segments.push({ kind: item.kind, iteration: e.iteration.index, startMs: e.iteration.startMs, endMs: e.iteration.endMs, tokens: item.tokens, contextBefore: item.contextBefore });
        }
        break;
      case 'iteration-end':
        for (const { req } of e.emitted) lanes[req].tokenTimes.push(e.t);
        break;
      default:
        break;
    }
  }
  return lanes;
}

/** Sorted distinct event timestamps (playback stops). */
export function eventMoments(result: SimResult): number[] {
  const out: number[] = [];
  for (const e of result.events) if (out.length === 0 || out[out.length - 1] !== e.t) out.push(e.t);
  return out;
}

/** Index of the iteration covering time t (start <= t < end), else null. */
export function iterationAt(iterations: readonly IterationRecord[], t: number): number | null {
  let lo = 0;
  let hi = iterations.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const it = iterations[mid];
    if (t < it.startMs) hi = mid - 1;
    else if (t >= it.endMs) lo = mid + 1;
    else return mid;
  }
  return null;
}
