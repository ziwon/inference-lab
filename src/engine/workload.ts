import type { GeneratorParams, SimConfig, TraceRequest } from './types';

// Seeded, engine-independent workload generation. Only IEEE-754 basic arithmetic is used
// (no Math.log/Math.exp), so the same seed yields the same trace in every JavaScript engine.

/** mulberry32: small deterministic 32-bit PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Natural log using only +, -, *, / so results are bit-identical across engines. */
export function deterministicLn(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new RangeError('ln requires a positive finite input');
  let exponent = 0;
  let m = x;
  while (m >= 2) { m /= 2; exponent++; }
  while (m < 1) { m *= 2; exponent--; }
  // m in [1, 2): ln(m) = 2 * atanh((m - 1) / (m + 1)).
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let k = 1; k < 60; k += 2) {
    sum += term / k;
    term *= z2;
  }
  const LN2 = 0.6931471805599453;
  return 2 * sum + exponent * LN2;
}

function uniformInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function requestId(index: number): string {
  return `R${index + 1}`;
}

export function generateTrace(params: GeneratorParams, seed: number): TraceRequest[] {
  const rng = createRng(seed);
  const requests: TraceRequest[] = [];
  let t = params.startMs;
  for (let i = 0; i < params.count; i++) {
    if (i > 0 && params.meanInterArrivalMs > 0) {
      const u = 1 - rng(); // (0, 1]
      t += -params.meanInterArrivalMs * deterministicLn(u);
    }
    const promptTokens = uniformInt(rng, params.promptMin, params.promptMax);
    const outputTokens = uniformInt(rng, params.outputMin, params.outputMax);
    // Round to 0.1 ms so traces are easy to read and stable in exports.
    requests.push({ id: requestId(i), arrivalMs: Math.round(t * 10) / 10, promptTokens, outputTokens });
  }
  return requests;
}

/** Stable arrival order: by arrival time, ties broken by original trace position. */
export function orderTrace(requests: readonly TraceRequest[]): TraceRequest[] {
  return requests
    .map((request, index) => ({ request, index }))
    .sort((a, b) => a.request.arrivalMs - b.request.arrivalMs || a.index - b.index)
    .map(entry => ({ ...entry.request }));
}

export function buildTrace(config: Pick<SimConfig, 'workload' | 'seed'>): TraceRequest[] {
  const raw = config.workload.kind === 'explicit' ? config.workload.requests : generateTrace(config.workload.params, config.seed);
  return orderTrace(raw);
}
