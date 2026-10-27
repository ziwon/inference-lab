import type { CostModel } from './config.ts';

export interface PrefillWork {
  tokens: number;
  cachedBefore: number;
}

export interface DecodeWork {
  cachedBefore: number;
}

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

export function prefillAttentionPairs(q: number, c: number) {
  const againstCache = q * c;
  const causalAmongNew = (q * (q + 1)) / 2;
  return againstCache + causalAmongNew;
}

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

export function zeroDurationWork(model: CostModel): ('prefill' | 'decode')[] {
  const out: ('prefill' | 'decode')[] = [];
  if (iterationCost(model, [{ tokens: 1, cachedBefore: 0 }], []).totalMs <= 0) out.push('prefill');
  if (iterationCost(model, [], [{ cachedBefore: 0 }]).totalMs <= 0) out.push('decode');
  return out;
}
