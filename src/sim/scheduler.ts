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
  emitsFirstToken: boolean;
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
  activeInAdmissionOrder: readonly number[];
  limits: SchedulerLimits;
}

const leastRecentlyServedFirst = (requests: readonly RequestState[]) => (x: number, y: number) =>
  requests[x]!.lastServedIteration - requests[y]!.lastServedIteration || x - y;

export function decodeOrder(input: PlanInput): number[] {
  return input.activeInAdmissionOrder.filter(i => input.requests[i]!.phase === 'decoding').sort(leastRecentlyServedFirst(input.requests));
}

const prefillQueue = (input: PlanInput) =>
  input.activeInAdmissionOrder.filter(i => {
    const p = input.requests[i]!.phase;
    return p === 'admitted' || p === 'prefilling';
  });

interface Budget {
  tokens: number;
}

function scheduleDecodes(input: PlanInput, budget: Budget, plan: Plan, code: 'decodeFirst' | 'decodeWithRemainingBudget') {
  decodeOrder(input).forEach((request, rank) => {
    if (budget.tokens === 0) {
      plan.skipped.push({ request, kind: 'decode', reason: { code: 'tokenBudgetExhausted', rank } });
    } else {
      budget.tokens -= 1;
      plan.entries.push({ request, kind: 'decode', tokens: 1, cachedBefore: input.requests[request]!.cachedTokens, emitsFirstToken: false, reason: { code, rank } });
    }
  });
}

function planWholePrefill(input: PlanInput): Plan {
  const plan: Plan = { entries: [], skipped: [] };
  const budget: Budget = { tokens: input.limits.maxBatchTokens };
  let head: number | null = null;
  for (const request of prefillQueue(input)) {
    const promptTokens = input.trace[request]!.promptTokens;
    if (head !== null) {
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'behindDeferredPrefill', head } });
    } else if (promptTokens > budget.tokens) {
      head = request;
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'wholePromptDoesNotFit', promptTokens, remainingTokens: budget.tokens } });
    } else {
      budget.tokens -= promptTokens;
      plan.entries.push({ request, kind: 'prefill', tokens: promptTokens, cachedBefore: 0, emitsFirstToken: true, reason: { code: 'wholePrompt' } });
    }
  }
  scheduleDecodes(input, budget, plan, 'decodeWithRemainingBudget');
  return plan;
}

function planChunkedPrefill(input: PlanInput): Plan {
  const plan: Plan = { entries: [], skipped: [] };
  const budget: Budget = { tokens: input.limits.maxBatchTokens };
  scheduleDecodes(input, budget, plan, 'decodeFirst');
  for (const request of prefillQueue(input)) {
    const cachedBefore = input.requests[request]!.cachedTokens;
    const remainingPrompt = input.trace[request]!.promptTokens - cachedBefore;
    if (budget.tokens === 0) {
      plan.skipped.push({ request, kind: 'prefill', reason: { code: 'tokenBudgetExhausted' } });
      continue;
    }
    const tokens = Math.min(remainingPrompt, input.limits.maxPrefillChunkTokens, budget.tokens);
    const limitedBy = tokens === remainingPrompt ? 'promptEnd' : tokens === input.limits.maxPrefillChunkTokens ? 'chunkLimit' : 'tokenBudget';
    budget.tokens -= tokens;
    plan.entries.push({ request, kind: 'prefill', tokens, cachedBefore, emitsFirstToken: tokens === remainingPrompt, reason: { code: 'prefillChunk', limitedBy } });
  }
  return plan;
}

export const usedBy = (policy: PolicyId, limit: keyof SchedulerLimits) => !(policy === 'whole-prefill' && limit === 'maxPrefillChunkTokens');

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
