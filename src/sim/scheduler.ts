import type { PolicyId, SchedulerLimits } from './config.ts';
import type { RequestState } from './state.ts';
import type { TraceItem } from './trace.ts';

export type EntryReason =
  | { code: 'wholePrompt' }
  | { code: 'decodeWithRemainingBudget'; rank: number }
  | { code: 'decodeFirst'; rank: number }
  | { code: 'prefillChunk'; limitedBy: 'promptEnd' | 'chunkLimit' | 'tokenBudget' };

export type SkipReason =
  | { code: 'tokenBudgetExhausted'; rank?: number }
  | { code: 'sequenceLimitReached'; limit: number }
  | { code: 'wholePromptDoesNotFit'; promptTokens: number; remainingTokens: number }
  | { code: 'behindDeferredPrefill'; head: number };

export type AdmissionBlock =
  | { code: 'activeLimitReached'; active: number; limit: number }
  | { code: 'reservationDoesNotFit'; needBlocks: number; unreservedBlocks: number };

export interface PlannedEntry {
  request: number;
  kind: 'prefill' | 'decode';
  tokens: number;
  cachedBefore: number;
  /** A final prefill chunk emits the first output token. */
  final: boolean;
  reason: EntryReason;
}

export interface Skip {
  request: number;
  kind: 'prefill' | 'decode';
  reason: SkipReason;
}

export interface Plan {
  entries: PlannedEntry[];
  skipped: Skip[];
}

export interface PlanInput {
  requests: readonly RequestState[];
  trace: readonly TraceItem[];
  /** Admitted, unfinished requests in admission (FIFO) order. */
  active: readonly number[];
  limits: SchedulerLimits;
}

/**
 * Shared decode order for both policies: least recently served first, ties by admission order.
 * When the token budget cannot serve every decode, this rotates service across iterations.
 */
export function decodeOrder(input: PlanInput): number[] {
  return input.active
    .filter(i => {
      const r = input.requests[i]!;
      return r.phase === 'decoding';
    })
    .sort((x, y) => input.requests[x]!.lastServedIteration - input.requests[y]!.lastServedIteration || x - y);
}

const prefillQueue = (input: PlanInput) =>
  input.active.filter(i => {
    const p = input.requests[i]!.phase;
    return p === 'admitted' || p === 'prefilling';
  });

class Budget {
  tokens: number;
  seqs: number;
  constructor(limits: SchedulerLimits) {
    this.tokens = limits.maxBatchTokens;
    this.seqs = limits.maxActiveSequences;
  }
  take(tokens: number) {
    this.tokens -= tokens;
    this.seqs -= 1;
  }
}

function scheduleDecodes(input: PlanInput, budget: Budget, plan: Plan, code: 'decodeFirst' | 'decodeWithRemainingBudget') {
  decodeOrder(input).forEach((request, rank) => {
    if (budget.seqs === 0) {
      plan.skipped.push({ request, kind: 'decode', reason: { code: 'sequenceLimitReached', limit: input.limits.maxActiveSequences } });
    } else if (budget.tokens === 0) {
      plan.skipped.push({ request, kind: 'decode', reason: { code: 'tokenBudgetExhausted', rank } });
    } else {
      budget.take(1);
      plan.entries.push({ request, kind: 'decode', tokens: 1, cachedBefore: input.requests[request]!.cachedTokens, final: false, reason: { code, rank } });
    }
  });
}

/** Policy A: FIFO whole prompts first, never split. Stop at the first prompt that does not fit, then fill with decodes. */
function planWholePrefill(input: PlanInput): Plan {
  const plan: Plan = { entries: [], skipped: [] };
  const budget = new Budget(input.limits);
  let head: number | null = null;
  for (const request of prefillQueue(input)) {
    const promptTokens = input.trace[request]!.promptTokens;
    if (head !== null) {
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'behindDeferredPrefill', head } });
    } else if (budget.seqs === 0) {
      head = request;
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'sequenceLimitReached', limit: input.limits.maxActiveSequences } });
    } else if (promptTokens > budget.tokens) {
      head = request;
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'wholePromptDoesNotFit', promptTokens, remainingTokens: budget.tokens } });
    } else {
      budget.take(promptTokens);
      plan.entries.push({ request, kind: 'prefill', tokens: promptTokens, cachedBefore: 0, final: true, reason: { code: 'wholePrompt' } });
    }
  }
  scheduleDecodes(input, budget, plan, 'decodeWithRemainingBudget');
  return plan;
}

/** Policy B: decodes first, then FIFO prefill chunks that continue from each prompt's cached prefix. */
function planChunkedPrefill(input: PlanInput): Plan {
  const plan: Plan = { entries: [], skipped: [] };
  const budget = new Budget(input.limits);
  scheduleDecodes(input, budget, plan, 'decodeFirst');
  for (const request of prefillQueue(input)) {
    const cachedBefore = input.requests[request]!.cachedTokens;
    const remainingPrompt = input.trace[request]!.promptTokens - cachedBefore;
    if (budget.seqs === 0) {
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'sequenceLimitReached', limit: input.limits.maxActiveSequences } });
      continue;
    }
    if (budget.tokens === 0) {
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'tokenBudgetExhausted' } });
      continue;
    }
    const tokens = Math.min(remainingPrompt, input.limits.maxPrefillChunkTokens, budget.tokens);
    const limitedBy = tokens === remainingPrompt ? 'promptEnd' : tokens === input.limits.maxPrefillChunkTokens ? 'chunkLimit' : 'tokenBudget';
    budget.take(tokens);
    plan.entries.push({ request, kind: 'prefill', tokens, cachedBefore, final: tokens === remainingPrompt, reason: { code: 'prefillChunk', limitedBy } });
  }
  return plan;
}

/** Extension point: a third policy is one entry here plus its strings. */
export const POLICIES: Record<PolicyId, (input: PlanInput) => Plan> = {
  'whole-prefill': planWholePrefill,
  'chunked-prefill': planChunkedPrefill,
};

export interface AdmissionInput {
  waiting: readonly number[];
  trace: readonly TraceItem[];
  activeCount: number;
  reservedBlocks: number;
  totalBlocks: number;
  limits: SchedulerLimits;
  reservationOf: (request: number) => number;
}

/** Strict FIFO. The head is admitted only with a free sequence slot and a completion reservation that fits. */
export function decideAdmission(input: AdmissionInput): { admit: number[]; blocked: { request: number; reason: AdmissionBlock } | null } {
  const admit: number[] = [];
  let active = input.activeCount;
  let reserved = input.reservedBlocks;
  for (const request of input.waiting) {
    if (active >= input.limits.maxActiveSequences) {
      return { admit, blocked: { request, reason: { code: 'activeLimitReached', active, limit: input.limits.maxActiveSequences } } };
    }
    const need = input.reservationOf(request);
    const unreserved = input.totalBlocks - reserved;
    if (need > unreserved) {
      return { admit, blocked: { request, reason: { code: 'reservationDoesNotFit', needBlocks: need, unreservedBlocks: unreserved } } };
    }
    admit.push(request);
    active += 1;
    reserved += need;
  }
  return { admit, blocked: null };
}
