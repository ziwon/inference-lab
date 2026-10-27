import type { BatchItem, CostBreakdown, CostConfig } from './types';

// Educational execution-cost model, in modeled milliseconds (not hardware measurements).
//
// duration = overhead
//          + linear      * (prefill tokens + decode tokens)
//          + prefillAttn * sum over prefill chunks of (q*c + q*(q+1)/2) / 1e6
//          + decodeAttn  * sum over decodes of (c + 1) / 1e3
//
// q = new tokens in a chunk, c = populated KV positions before it. q*c + q*(q+1)/2 counts
// causal query-key pairs including each token's attention to itself. A decode is the q = 1
// case (c + 1 positions), priced with its own coefficient because decode attention reads
// the KV cache rather than doing dense compute. Work in a mixed batch is summed: the model
// assumes no overlap between prefill compute and decode memory traffic.

export function prefillAttentionPairs(newTokens: number, contextBefore: number): number {
  return newTokens * contextBefore + (newTokens * (newTokens + 1)) / 2;
}

export function decodeAttendedPositions(contextBefore: number): number {
  return contextBefore + 1;
}

export function iterationCost(items: readonly Pick<BatchItem, 'kind' | 'tokens' | 'contextBefore'>[], cost: CostConfig): CostBreakdown {
  let tokens = 0;
  let prefillPairs = 0;
  let decodePositions = 0;
  for (const item of items) {
    tokens += item.tokens;
    if (item.kind === 'prefill') prefillPairs += prefillAttentionPairs(item.tokens, item.contextBefore);
    else decodePositions += decodeAttendedPositions(item.contextBefore);
  }
  if (items.length === 0) {
    return { overheadMs: 0, linearMs: 0, prefillAttentionMs: 0, decodeAttentionMs: 0, totalMs: 0, prefillPairs: 0, decodePositions: 0 };
  }
  const overheadMs = cost.iterationOverheadMs;
  const linearMs = cost.linearMsPerToken * tokens;
  const prefillAttentionMs = cost.prefillAttentionMsPerMillionPairs * prefillPairs / 1e6;
  const decodeAttentionMs = cost.decodeAttentionMsPerThousandPositions * decodePositions / 1e3;
  return {
    overheadMs,
    linearMs,
    prefillAttentionMs,
    decodeAttentionMs,
    totalMs: overheadMs + linearMs + prefillAttentionMs + decodeAttentionMs,
    prefillPairs,
    decodePositions,
  };
}

/**
 * True when every nonempty iteration is guaranteed a strictly positive duration.
 * Any nonempty iteration schedules at least one token, so a positive overhead or linear
 * term suffices; otherwise both attention terms must be positive (pairs and positions are >= 1).
 */
export function costGuaranteesProgress(cost: CostConfig): boolean {
  if (cost.iterationOverheadMs > 0 || cost.linearMsPerToken > 0) return true;
  return cost.prefillAttentionMsPerMillionPairs > 0 && cost.decodeAttentionMsPerThousandPositions > 0;
}
