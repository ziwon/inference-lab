import { buildTimelines, type RequestTimeline } from './replay';
import type { SimResult, SloConfig } from './types';

// All metrics come from event timestamps. Empty samples yield null (shown as N/A),
// never 0, NaN, or Infinity. Percentiles use the nearest-rank method.

export type SloOutcome = 'met' | 'missed-ttft' | 'missed-tpot' | 'missed-both' | 'pending' | 'unfinished' | 'infeasible';
export type RequestStatus = 'not-arrived' | 'waiting' | 'running' | 'completed' | 'unfinished' | 'infeasible';

export interface RequestMetrics {
  req: number;
  id: string;
  promptTokens: number;
  outputTokens: number;
  status: RequestStatus;
  generatedTokens: number;
  queueDelayMs: number | null;
  ttftMs: number | null;
  e2eMs: number | null;
  tpotMs: number | null;
  itlsMs: number[];
  maxItlMs: number | null;
  slo: SloOutcome;
}

export interface Distribution {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface SummaryMetrics {
  asOfMs: number;
  /** Observation window: first arrival to min(asOf, run end). */
  windowStartMs: number | null;
  windowEndMs: number | null;
  windowMs: number | null;
  counts: Record<RequestStatus, number> & { total: number };
  queueDelay: Distribution;
  ttft: Distribution;
  e2e: Distribution;
  tpot: Distribution;
  itl: Distribution;
  outputTokens: number;
  requestsPerSecond: number | null;
  outputTokensPerSecond: number | null;
  slo: {
    met: number;
    missedTtft: number;
    missedTpot: number;
    missedBoth: number;
    pending: number;
    unfinished: number;
    infeasible: number;
    /** met / total requests in the trace (failures and unfinished count against it). */
    attainment: number | null;
    goodputRequestsPerSecond: number | null;
    goodputTokensPerSecond: number | null;
  };
  busyMs: number;
  iterationsStarted: number;
}

/** Nearest-rank percentile: smallest sample with at least p% of samples at or below it. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) return { count: 0, mean: null, p50: null, p90: null, p99: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { count: sorted.length, mean, p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] };
}

/** Safe rate: count per second over a window, N/A for an empty window. */
export function ratePerSecond(count: number, windowMs: number | null): number | null {
  if (windowMs === null || !(windowMs > 0)) return null;
  return (count * 1000) / windowMs;
}

export function requestMetrics(result: SimResult, slo: SloConfig, asOfMs = Infinity, timelines: RequestTimeline[] = buildTimelines(result)): RequestMetrics[] {
  const runOver = asOfMs >= result.endMs && result.status !== 'invalid';
  return timelines.map(lane => {
    const request = result.trace[lane.req];
    const tokens = lane.tokenTimes.filter(t => t <= asOfMs);
    const G = request.outputTokens;
    const arrived = lane.arrivalMs !== null && lane.arrivalMs <= asOfMs;
    const infeasible = lane.infeasibleMs !== null && lane.infeasibleMs <= asOfMs;
    const completed = lane.completedMs !== null && lane.completedMs <= asOfMs;
    const started = lane.firstExecutionMs !== null && lane.firstExecutionMs <= asOfMs;
    let status: RequestStatus;
    if (!arrived) status = result.status === 'invalid' ? 'unfinished' : 'not-arrived';
    else if (infeasible) status = 'infeasible';
    else if (completed) status = 'completed';
    else if (runOver) status = 'unfinished';
    else status = lane.admittedMs !== null && lane.admittedMs <= asOfMs ? 'running' : 'waiting';

    const arrival = lane.arrivalMs ?? 0;
    const queueDelayMs = started && arrived ? lane.firstExecutionMs! - arrival : null;
    const ttftMs = tokens.length >= 1 ? tokens[0] - arrival : null;
    const e2eMs = completed ? tokens[tokens.length - 1] - arrival : null;
    const tpotMs = completed && G > 1 ? (tokens[tokens.length - 1] - tokens[0]) / (G - 1) : null;
    const itlsMs: number[] = [];
    for (let i = 1; i < tokens.length; i++) itlsMs.push(tokens[i] - tokens[i - 1]);
    const maxItlMs = itlsMs.length > 0 ? Math.max(...itlsMs) : null;

    let sloOutcome: SloOutcome;
    if (status === 'infeasible') sloOutcome = 'infeasible';
    else if (status === 'unfinished') sloOutcome = 'unfinished';
    else if (status !== 'completed') sloOutcome = 'pending';
    else {
      const ttftOk = ttftMs !== null && ttftMs <= slo.ttftMs;
      const tpotOk = tpotMs === null || tpotMs <= slo.tpotMs; // G = 1 has no TPOT to violate
      sloOutcome = ttftOk && tpotOk ? 'met' : !ttftOk && !tpotOk ? 'missed-both' : !ttftOk ? 'missed-ttft' : 'missed-tpot';
    }
    return {
      req: lane.req, id: request.id, promptTokens: request.promptTokens, outputTokens: G, status,
      generatedTokens: tokens.length, queueDelayMs, ttftMs, e2eMs, tpotMs, itlsMs, maxItlMs, slo: sloOutcome,
    };
  });
}

export function summarize(
  result: SimResult,
  slo: SloConfig,
  asOfMs = Infinity,
  timelines: RequestTimeline[] = buildTimelines(result),
  perRequest: RequestMetrics[] = requestMetrics(result, slo, asOfMs, timelines),
): SummaryMetrics {
  const counts = { 'not-arrived': 0, waiting: 0, running: 0, completed: 0, unfinished: 0, infeasible: 0, total: perRequest.length } as SummaryMetrics['counts'];
  for (const r of perRequest) counts[r.status] += 1;

  const firstArrival = result.trace.length > 0 ? result.trace[0].arrivalMs : null;
  const windowStartMs = firstArrival !== null && firstArrival <= asOfMs ? firstArrival : null;
  const windowEndMs = windowStartMs === null ? null : Math.min(asOfMs, result.endMs);
  const windowMs = windowStartMs === null || windowEndMs === null ? null : windowEndMs - windowStartMs;

  const outputTokens = perRequest.reduce((sum, r) => sum + r.generatedTokens, 0);
  const sloCounts = { met: 0, missedTtft: 0, missedTpot: 0, missedBoth: 0, pending: 0, unfinished: 0, infeasible: 0 };
  let goodTokens = 0;
  for (const r of perRequest) {
    switch (r.slo) {
      case 'met': sloCounts.met++; goodTokens += r.generatedTokens; break;
      case 'missed-ttft': sloCounts.missedTtft++; break;
      case 'missed-tpot': sloCounts.missedTpot++; break;
      case 'missed-both': sloCounts.missedBoth++; break;
      case 'pending': sloCounts.pending++; break;
      case 'unfinished': sloCounts.unfinished++; break;
      case 'infeasible': sloCounts.infeasible++; break;
    }
  }
  const busyMs = result.iterations.reduce((sum, it) => sum + Math.max(0, Math.min(it.endMs, asOfMs) - it.startMs), 0);
  return {
    asOfMs,
    windowStartMs,
    windowEndMs,
    windowMs,
    counts,
    queueDelay: distribution(perRequest.flatMap(r => (r.queueDelayMs === null ? [] : [r.queueDelayMs]))),
    ttft: distribution(perRequest.flatMap(r => (r.ttftMs === null ? [] : [r.ttftMs]))),
    e2e: distribution(perRequest.flatMap(r => (r.e2eMs === null ? [] : [r.e2eMs]))),
    tpot: distribution(perRequest.flatMap(r => (r.tpotMs === null ? [] : [r.tpotMs]))),
    itl: distribution(perRequest.flatMap(r => r.itlsMs)),
    outputTokens,
    requestsPerSecond: ratePerSecond(counts.completed, windowMs),
    outputTokensPerSecond: ratePerSecond(outputTokens, windowMs),
    slo: {
      ...sloCounts,
      attainment: perRequest.length > 0 ? sloCounts.met / perRequest.length : null,
      goodputRequestsPerSecond: ratePerSecond(sloCounts.met, windowMs),
      goodputTokensPerSecond: ratePerSecond(goodTokens, windowMs),
    },
    busyMs,
    iterationsStarted: result.iterations.filter(it => it.startMs <= asOfMs).length,
  };
}
