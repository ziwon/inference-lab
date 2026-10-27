import type { BatchItem, Decision, PolicyId, SchedulerConfig } from './types';

// Two simplified educational scheduling policies. Neither is a replay of a specific
// vLLM version. Both share the same decode order: round-robin by admission sequence,
// starting after the request served last in the previous iteration.

export interface ActiveRequestView {
  req: number;
  /** Admission order, strictly increasing. */
  admitSeq: number;
  promptTokens: number;
  prefilledTokens: number;
  cachedTokens: number;
  generatedTokens: number;
  outputTokens: number;
}

export interface Selection {
  items: Omit<BatchItem, 'newBlocks'>[];
  decisions: Decision[];
  /** admitSeq of the last decode served, or the previous cursor if none ran. */
  rrCursor: number;
}

export function needsPrefill(r: ActiveRequestView): boolean {
  return r.prefilledTokens < r.promptTokens;
}

export function decodeEligible(r: ActiveRequestView): boolean {
  return !needsPrefill(r) && r.generatedTokens >= 1 && r.generatedTokens < r.outputTokens;
}

/** Decode-eligible requests rotated so the first one follows the round-robin cursor. */
export function roundRobinOrder(active: readonly ActiveRequestView[], rrCursor: number): ActiveRequestView[] {
  const eligible = active.filter(decodeEligible).sort((a, b) => a.admitSeq - b.admitSeq);
  const start = eligible.findIndex(r => r.admitSeq > rrCursor);
  return start <= 0 ? eligible : [...eligible.slice(start), ...eligible.slice(0, start)];
}

function decodeItem(r: ActiveRequestView): Omit<BatchItem, 'newBlocks'> {
  return { req: r.req, kind: 'decode', tokens: 1, contextBefore: r.cachedTokens, finalChunk: false, emitsToken: r.generatedTokens + 1 };
}

/**
 * Policy A, whole-prefill baseline.
 * 1. Admitted requests awaiting prefill go first, in FIFO admission order, each as one whole prompt.
 *    The first prompt that does not fit the remaining budget is deferred, and so is every prompt behind it.
 * 2. Remaining token and sequence capacity goes to decodes in round-robin order.
 */
function selectWholePrefill(active: readonly ActiveRequestView[], scheduler: SchedulerConfig, rrCursor: number): Selection {
  const items: Selection['items'] = [];
  const decisions: Decision[] = [];
  let remaining = scheduler.tokenBudget;
  let slots = scheduler.maxActiveSequences;
  let blocker: number | null = null;
  const prefillQueue = active.filter(needsPrefill).sort((a, b) => a.admitSeq - b.admitSeq);
  for (const r of prefillQueue) {
    const need = r.promptTokens - r.prefilledTokens;
    if (blocker !== null) {
      decisions.push({ req: r.req, code: 'defer-fifo', tokens: need, blockedBy: blocker });
    } else if (slots === 0) {
      decisions.push({ req: r.req, code: 'defer-sequence-cap', tokens: need });
      blocker = r.req;
    } else if (need <= remaining) {
      items.push({ req: r.req, kind: 'prefill', tokens: need, contextBefore: r.cachedTokens, finalChunk: true, emitsToken: 1, limitedBy: 'whole-prompt' });
      decisions.push({ req: r.req, code: 'run-prefill-whole', tokens: need, available: remaining });
      remaining -= need;
      slots -= 1;
    } else {
      decisions.push({ req: r.req, code: 'defer-token-budget', tokens: need, available: remaining });
      blocker = r.req;
    }
  }
  const cursor = scheduleDecodes(active, rrCursor, items, decisions, () => remaining, () => slots, () => { remaining -= 1; slots -= 1; });
  return { items, decisions, rrCursor: cursor };
}

/**
 * Policy B, decode-first chunked prefill.
 * 1. Decodes go first in round-robin order.
 * 2. Remaining capacity goes to FIFO prefill chunks of at most maxPrefillChunk tokens,
 *    continuing each prompt from its actual cached prefix.
 */
function selectChunkedPrefill(active: readonly ActiveRequestView[], scheduler: SchedulerConfig, rrCursor: number): Selection {
  const items: Selection['items'] = [];
  const decisions: Decision[] = [];
  let remaining = scheduler.tokenBudget;
  let slots = scheduler.maxActiveSequences;
  const cursor = scheduleDecodes(active, rrCursor, items, decisions, () => remaining, () => slots, () => { remaining -= 1; slots -= 1; });
  const prefillQueue = active.filter(needsPrefill).sort((a, b) => a.admitSeq - b.admitSeq);
  for (const r of prefillQueue) {
    const left = r.promptTokens - r.prefilledTokens;
    if (slots === 0) {
      decisions.push({ req: r.req, code: 'defer-sequence-cap', tokens: Math.min(left, scheduler.maxPrefillChunk) });
      continue;
    }
    if (remaining === 0) {
      decisions.push({ req: r.req, code: 'defer-token-budget', tokens: Math.min(left, scheduler.maxPrefillChunk), available: 0 });
      continue;
    }
    const q = Math.min(left, scheduler.maxPrefillChunk, remaining);
    const limitedBy: BatchItem['limitedBy'] = q === left ? (r.prefilledTokens === 0 ? 'whole-prompt' : 'remaining-prompt') : q === scheduler.maxPrefillChunk ? 'chunk-cap' : 'token-budget';
    const finalChunk = q === left;
    items.push({ req: r.req, kind: 'prefill', tokens: q, contextBefore: r.cachedTokens, finalChunk, emitsToken: finalChunk ? 1 : 0, limitedBy });
    decisions.push({ req: r.req, code: finalChunk && r.prefilledTokens === 0 ? 'run-prefill-whole' : 'run-prefill-chunk', tokens: q, available: remaining });
    remaining -= q;
    slots -= 1;
  }
  return { items, decisions, rrCursor: cursor };
}

function scheduleDecodes(
  active: readonly ActiveRequestView[],
  rrCursor: number,
  items: Selection['items'],
  decisions: Decision[],
  remaining: () => number,
  slots: () => number,
  consume: () => void,
): number {
  let cursor = rrCursor;
  for (const r of roundRobinOrder(active, rrCursor)) {
    if (remaining() >= 1 && slots() >= 1) {
      items.push(decodeItem(r));
      decisions.push({ req: r.req, code: 'run-decode', tokens: 1, available: remaining() });
      consume();
      cursor = r.admitSeq;
    } else if (remaining() < 1) {
      decisions.push({ req: r.req, code: 'defer-token-budget', tokens: 1, available: remaining() });
    } else {
      decisions.push({ req: r.req, code: 'defer-sequence-cap', tokens: 1 });
    }
  }
  return cursor;
}

const SELECTORS: Record<PolicyId, typeof selectWholePrefill> = {
  'whole-prefill': selectWholePrefill,
  'chunked-prefill': selectChunkedPrefill,
};

export function selectBatch(policy: PolicyId, active: readonly ActiveRequestView[], scheduler: SchedulerConfig, rrCursor: number): Selection {
  return SELECTORS[policy](active, scheduler, rrCursor);
}
