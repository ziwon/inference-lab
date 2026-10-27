import type { CostModel } from './config.ts';

export interface PrefillWork {
  tokens: number;
  cachedBefore: number;
}

export interface DecodeWork {
  cachedBefore: number;
}

/** Modeled milliseconds per term. The terms add up with no overlap between prefill and decode work. */
export interface CostBreakdown {
  overheadMs: number;
  prefillTokenMs: number;
  prefillAttentionMs: number;
  decodeSequenceMs: number;
  decodeContextMs: number;
  totalMs: number;
  prefillTokens: number;
  attentionPairs: number;
  decodeSequences: number;
  decodeContextTokens: number;
}

/** Causal attention work for q new tokens after c cached ones: each new token attends to the cache and to itself and earlier new tokens. */
export const prefillAttentionPairs = (q: number, c: number) => q * c + (q * (q + 1)) / 2;

export function iterationCost(model: CostModel, prefills: readonly PrefillWork[], decodes: readonly DecodeWork[]): CostBreakdown {
  let prefillTokens = 0;
  let attentionPairs = 0;
  for (const p of prefills) {
    prefillTokens += p.tokens;
    attentionPairs += prefillAttentionPairs(p.tokens, p.cachedBefore);
  }
  let decodeContextTokens = 0;
  for (const d of decodes) decodeContextTokens += d.cachedBefore + 1;
  const terms = {
    overheadMs: model.overheadMs,
    prefillTokenMs: model.prefillTokenMs * prefillTokens,
    prefillAttentionMs: (model.attentionMsPerMillionPairs * attentionPairs) / 1e6,
    decodeSequenceMs: model.decodeSequenceMs * decodes.length,
    decodeContextMs: (model.decodeContextMsPerThousandTokens * decodeContextTokens) / 1000,
  };
  return {
    ...terms,
    totalMs: terms.overheadMs + terms.prefillTokenMs + terms.prefillAttentionMs + terms.decodeSequenceMs + terms.decodeContextMs,
    prefillTokens,
    attentionPairs,
    decodeSequences: decodes.length,
    decodeContextTokens,
  };
}

/**
 * Every nonempty iteration must take positive time. A prefill-only batch costs at least
 * overhead + prefillToken + attention(1 pair); a decode-only batch at least overhead + decodeSequence + decodeContext(1 token).
 */
export function zeroDurationWork(model: CostModel): ('prefill' | 'decode')[] {
  const out: ('prefill' | 'decode')[] = [];
  if (model.overheadMs + model.prefillTokenMs + model.attentionMsPerMillionPairs <= 0) out.push('prefill');
  if (model.overheadMs + model.decodeSequenceMs + model.decodeContextMsPerThousandTokens <= 0) out.push('decode');
  return out;
}
