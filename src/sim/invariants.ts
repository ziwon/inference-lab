import { type PanelRun, reducerContext } from './engine.ts';
import { blocksFor } from './memory.ts';
import { LIVE_PHASES, type SimState, applyEvent, initialState } from './state.ts';

/** Checks one state against the token, allocator, and reservation rules. Returns human-readable violations. */
export function auditState(run: PanelRun, s: Readonly<SimState>): string[] {
  const out: string[] = [];
  const bs = run.memory.blockSizeTokens;
  const owner = new Map<number, number>();
  let allocated = 0;
  let reserved = 0;
  let active = 0;
  s.requests.forEach((r, i) => {
    const { promptTokens: P, outputTokens: G } = run.trace[i]!;
    const live = LIVE_PHASES.includes(r.phase);
    if (!live) {
      if (r.allocatedBlocks !== 0 || r.reservedBlocks !== 0 || r.cachedTokens !== 0) out.push(`r${i} ${r.phase} still holds memory`);
      return;
    }
    active += 1;
    allocated += r.allocatedBlocks;
    reserved += r.reservedBlocks;
    if (r.allocatedBlocks !== blocksFor(r.cachedTokens + r.inflightTokens, bs)) out.push(`r${i} allocated ${r.allocatedBlocks} != ceil(${r.cachedTokens}+${r.inflightTokens} / ${bs})`);
    if (r.allocatedBlocks > r.reservedBlocks) out.push(`r${i} occupies ${r.allocatedBlocks} > reserved ${r.reservedBlocks}`);
    if (r.cachedTokens + r.inflightTokens > P + G - 1) out.push(`r${i} KV ${r.cachedTokens + r.inflightTokens} > P+G-1 = ${P + G - 1}`);
    const expectedGenerated = r.cachedTokens < P ? 0 : r.cachedTokens - P + 1;
    if (r.generatedTokens !== expectedGenerated) out.push(`r${i} generated ${r.generatedTokens}, expected ${expectedGenerated}`);
    if (r.phase === 'finished' && (r.generatedTokens !== G || r.cachedTokens !== P + G - 1)) out.push(`r${i} finished early`);
    for (const id of run.blockIds[i]!.slice(0, r.allocatedBlocks)) {
      if (id < 0 || id >= run.memory.totalBlocks) out.push(`block ${id} outside pool`);
      const prev = owner.get(id);
      if (prev !== undefined) out.push(`block ${id} owned by r${prev} and r${i}`);
      owner.set(id, i);
    }
  });
  if (allocated !== s.allocatedBlocks) out.push(`allocated total ${s.allocatedBlocks} != sum ${allocated}`);
  if (reserved !== s.reservedBlocks) out.push(`reserved total ${s.reservedBlocks} != sum ${reserved}`);
  if (active !== s.activeCount) out.push(`active ${s.activeCount} != live ${active}`);
  if (s.reservedBlocks > run.memory.totalBlocks) out.push(`reserved ${s.reservedBlocks} > pool ${run.memory.totalBlocks}`);
  if (s.activeCount > run.limits.maxActiveSequences) out.push(`active ${s.activeCount} > limit ${run.limits.maxActiveSequences}`);
  return out;
}

/** Replays the run and audits the state after every event. */
export function auditRun(run: PanelRun): string[] {
  const ctx = reducerContext(run);
  const s = initialState(run.trace.length);
  const out = auditState(run, s);
  run.events.forEach((e, i) => {
    applyEvent(s, e, ctx);
    for (const v of auditState(run, s)) out.push(`after event ${i} (${e.kind}): ${v}`);
  });
  return out;
}
