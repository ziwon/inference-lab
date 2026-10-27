import type { IntRange, TraceRequest, TraceSpec } from './config.ts';
import { msToUs } from './units.ts';

/** A request after normalization. `index` is its position in (arrival, input order), which is also FIFO order. */
export interface TraceItem {
  index: number;
  id: string;
  arrivalUs: number;
  promptTokens: number;
  outputTokens: number;
}

/** mulberry32: 32-bit integer state, identical output in every JavaScript engine. */
export function createRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (range: IntRange) => range.min + Math.floor(next() * (range.max - range.min + 1)),
  };
}

/** Turns a trace spec into the explicit request list. Generated traces depend only on the spec and seed. */
export function materializeTrace(spec: TraceSpec, seed: number): TraceRequest[] {
  if (spec.kind === 'explicit') return spec.requests.map(r => ({ ...r }));
  const rng = createRng(seed);
  const step = spec.count > 1 ? spec.spanMs / (spec.count - 1) : 0;
  const arrivals = Array.from({ length: spec.count }, (_, i) => {
    const ms =
      spec.pattern === 'uniform' ? i * step
      : spec.pattern === 'jittered' ? i * step + (rng.next() - 0.5) * step
      : rng.next() * spec.spanMs;
    return Math.min(spec.spanMs, Math.max(0, Math.round(ms * 1000) / 1000));
  }).sort((x, y) => x - y);
  return arrivals.map((arrivalMs, i) => ({
    id: `R${i + 1}`,
    arrivalMs,
    promptTokens: rng.int(spec.promptTokens),
    outputTokens: rng.int(spec.outputTokens),
  }));
}

export function normalizeTrace(requests: readonly TraceRequest[]): TraceItem[] {
  return requests
    .map((r, input) => ({ r, input, arrivalUs: msToUs(r.arrivalMs) }))
    .sort((x, y) => x.arrivalUs - y.arrivalUs || x.input - y.input)
    .map(({ r, arrivalUs }, index) => ({ index, id: r.id, arrivalUs, promptTokens: r.promptTokens, outputTokens: r.outputTokens }));
}
