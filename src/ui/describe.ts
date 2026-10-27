import type { BatchItem, Decision, IterationRecord, PolicyId, SimEvent, TraceRequest } from '../engine/types';
import { t } from '../i18n';
import { formatMs } from './format';

// Human-readable explanations built from engine records. Text lives in the i18n dictionary.

export function describeEvent(e: SimEvent, trace: readonly TraceRequest[]): string {
  const id = (req: number) => trace[req]?.id ?? `#${req}`;
  switch (e.type) {
    case 'arrival': return t.event.arrival(id(e.req));
    case 'admit': return t.event.admit(id(e.req), e.reservedBlocks);
    case 'admission-blocked': return e.reason === 'sequence-limit' ? t.event.blockedSeq(id(e.req), e.limit) : t.event.blockedKv(id(e.req), e.neededBlocks, e.freeBlocks);
    case 'infeasible': return t.event.infeasible(id(e.req), e.neededBlocks, e.totalBlocks);
    case 'iteration-start': return t.event.iterationStart(e.iteration.index + 1, e.iteration.items.length, e.iteration.tokensScheduled);
    case 'iteration-end': return t.event.iterationEnd(e.index + 1, e.emitted.length);
    case 'complete': return t.event.complete(id(e.req));
    case 'release': return t.event.release(id(e.req), e.blocks, e.reservedBlocks);
    case 'idle': return t.event.idle(formatMs(e.untilMs));
    case 'finished': return t.event.finished(e.status);
  }
}

export function eventRequest(e: SimEvent): number | null {
  return 'req' in e ? e.req : null;
}

export function describeDecision(d: Decision, item: BatchItem | undefined, trace: readonly TraceRequest[], policy: PolicyId, sequenceLimit: number): string {
  const id = (req: number | undefined) => (req === undefined ? '?' : trace[req]?.id ?? `#${req}`);
  switch (d.code) {
    case 'run-decode':
      return t.decision['run-decode'](item?.emitsToken ?? 0);
    case 'run-prefill-whole':
      return t.decision['run-prefill-whole'](d.tokens ?? 0);
    case 'run-prefill-chunk': {
      const from = item?.contextBefore ?? 0;
      const to = from + (item?.tokens ?? 0);
      const limit = item?.limitedBy ? t.decision.limited[item.limitedBy] : '';
      const base = t.decision['run-prefill-chunk'](from, to, trace[d.req]?.promptTokens ?? to, item?.finalChunk ?? false);
      return limit ? `${base} (${limit})` : base;
    }
    case 'defer-token-budget':
      if (d.tokens === 1 && policy === 'chunked-prefill') return t.decision.deferDecodeBudget;
      if (policy === 'whole-prefill' && (d.tokens ?? 0) > 1) return t.decision.deferPrefillBudget(d.tokens ?? 0, d.available ?? 0);
      if (policy === 'whole-prefill') return t.decision.deferDecodeBudget;
      return t.decision.deferChunkBudget;
    case 'defer-sequence-cap':
      return t.decision.deferSequenceCap;
    case 'defer-fifo':
      return t.decision.deferFifo(id(d.blockedBy));
    case 'queue-sequence-limit':
      return t.decision.queueSequence(sequenceLimit);
    case 'queue-kv-reservation':
      return t.decision.queueKv(d.neededBlocks ?? 0, d.available ?? 0);
    case 'queue-head-of-line':
      return t.decision.queueHol(id(d.blockedBy), (d.neededBlocks ?? Infinity) <= (d.available ?? 0));
  }
}

/** One-sentence explanation of why the batch looks the way it does. */
export function summarizeIteration(it: IterationRecord, policy: PolicyId, trace: readonly TraceRequest[]): string[] {
  const prefills = it.items.filter(i => i.kind === 'prefill');
  const decodes = it.items.filter(i => i.kind === 'decode');
  const lines: string[] = [];
  if (policy === 'whole-prefill') {
    if (prefills.length > 0) lines.push(t.summary.wholeRan(prefills.length, it.prefillTokens, decodes.length));
    else lines.push(t.summary.decodesOnly(decodes.length));
    const deferred = it.decisions.find(d => d.code === 'defer-token-budget' && (d.tokens ?? 0) > 1);
    if (deferred) lines.push(t.summary.wholeDeferred(trace[deferred.req]?.id ?? '?', deferred.tokens ?? 0, deferred.available ?? 0));
  } else {
    lines.push(prefills.length > 0 ? t.summary.chunked(decodes.length, it.prefillTokens, prefills.length) : t.summary.decodesOnly(decodes.length));
  }
  const starved = it.decisions.filter(d => d.code === 'defer-token-budget' && d.tokens === 1).length;
  if (starved > 0) lines.push(t.summary.decodeStarved(starved));
  return lines;
}
