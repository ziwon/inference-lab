import type { Slo } from './config.ts';
import type { PanelRun, RequestHistory } from './engine.ts';
import type { Phase, RequestState, SimState } from './state.ts';
import { msToUs, nearestRank } from './units.ts';

export type RequestStatus = 'pending' | 'waiting' | 'active' | 'completed' | 'infeasible';

export interface RequestMetrics {
  status: RequestStatus;
  emittedTokens: number;
  queueDelayUs: number | null;
  ttftUs: number | null;
  e2eUs: number | null;
  tpotUs: number | null;
  itlUs: number[];
  meetsSlo: boolean;
}

export interface Distribution {
  n: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface Summary {
  horizonUs: number;
  counts: Record<RequestStatus, number> & { total: number };
  queueDelay: Distribution;
  ttft: Distribution;
  tpot: Distribution;
  e2e: Distribution;
  itl: Distribution;
  interval: { startUs: number; endUs: number };
  completedPerSec: number | null;
  outputTokensPerSec: number | null;
  sloMetPerSec: number | null;
  slo: { met: number; counted: number; attainment: number | null; notMet: number };
}

const STATUS: Record<Phase, RequestStatus> = {
  pending: 'pending',
  waiting: 'waiting',
  infeasible: 'infeasible',
  admitted: 'active',
  prefilling: 'active',
  decoding: 'active',
  awaitingRelease: 'active',
  completed: 'completed',
};

export function requestMetrics(h: RequestHistory, outputTokens: number, r: Readonly<RequestState>, iterationsStarted: number, slo: Slo): RequestMetrics {
  const times = h.tokenTimesUs.slice(0, r.generatedTokens);
  const status = STATUS[r.phase];
  const started = h.firstExecUs !== null && h.prefills[0]!.iteration < iterationsStarted;
  const first = times[0];
  const last = times[times.length - 1];
  const done = status === 'completed';
  const ttftUs = first === undefined ? null : first - h.arrivalUs;
  const tpotUs = done && outputTokens > 1 && first !== undefined && last !== undefined ? (last - first) / (outputTokens - 1) : null;
  const itlUs = times.slice(1).map((t, i) => t - times[i]!);
  return {
    status,
    emittedTokens: times.length,
    queueDelayUs: started ? h.firstExecUs! - h.arrivalUs : null,
    ttftUs,
    e2eUs: done && last !== undefined ? last - h.arrivalUs : null,
    tpotUs,
    itlUs,
    meetsSlo: done && ttftUs !== null && ttftUs <= msToUs(slo.ttftMs) && (outputTokens === 1 || (tpotUs !== null && tpotUs <= msToUs(slo.tpotMs))),
  };
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, mean: null, p50: null, p90: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    p99: nearestRank(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

const perSec = (count: number, us: number) => (us > 0 ? count / (us / 1e6) : null);

export function summarize(run: PanelRun, state: Readonly<SimState>, slo: Slo): Summary {
  const h = state.timeUs;
  const per = run.histories.map((hist, i) => requestMetrics(hist, run.trace[i]!.outputTokens, state.requests[i]!, state.iterationsStarted, slo));
  const counts = { total: per.length, pending: 0, waiting: 0, active: 0, completed: 0, infeasible: 0 };
  for (const m of per) counts[m.status] += 1;
  const pick = (f: (m: RequestMetrics) => number | null) => per.map(f).filter((v): v is number => v !== null);
  const startUs = run.trace[0]?.arrivalUs ?? 0;
  const intervalUs = Math.max(0, h - startUs);
  const counted = state.ended ? per.length : per.length - counts.pending;
  const met = per.filter(m => m.meetsSlo).length;
  return {
    horizonUs: h,
    counts,
    queueDelay: distribution(pick(m => m.queueDelayUs)),
    ttft: distribution(pick(m => m.ttftUs)),
    tpot: distribution(pick(m => m.tpotUs)),
    e2e: distribution(pick(m => m.e2eUs)),
    itl: distribution(per.flatMap(m => m.itlUs)),
    interval: { startUs, endUs: h },
    completedPerSec: perSec(counts.completed, intervalUs),
    outputTokensPerSec: perSec(per.reduce((s, m) => s + m.emittedTokens, 0), intervalUs),
    sloMetPerSec: perSec(met, intervalUs),
    slo: { met, counted, attainment: counted > 0 ? met / counted : null, notMet: counted - met },
  };
}
