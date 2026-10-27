import { useLayoutEffect, useRef } from 'react';
import type { Comparison, Playhead } from '../sim/compare.ts';
import { PANEL_IDS, type PanelId } from '../sim/config.ts';
import { liveBlockIds, waitReason } from '../sim/inspect.ts';
import { requestMetrics } from '../sim/metrics.ts';
import type { SimEvent, SimState } from '../sim/state.ts';
import { formatMs } from './format.ts';
import { CostTerms, IterationExplanation } from './Inspectors.tsx';
import { S, explain } from './strings.ts';

export type Selection = { kind: 'request'; request: number } | { kind: 'iteration'; panel: PanelId; iteration: number } | null;

interface DetailsProps {
  cmp: Comparison;
  at: Playhead;
  states: Record<PanelId, Readonly<SimState>>;
  selection: Selection;
  onSelect: (s: Selection) => void;
}

export function DetailsPanel({ cmp, at, states, selection, onSelect }: DetailsProps) {
  return (
    <section className="card" aria-labelledby="details-heading" data-testid="details">
      <div className="card-head">
        <h2 id="details-heading">
          {selection?.kind === 'request' ? S.details.request(cmp.trace[selection.request]!.id)
          : selection?.kind === 'iteration' ? S.details.iteration(S.panel(selection.panel), selection.iteration)
          : S.details.heading}
        </h2>
        {selection && (
          <button type="button" className="btn ghost spacer" onClick={() => onSelect(null)}>
            {S.details.close}
          </button>
        )}
      </div>
      <div className="card-body">
        {selection === null && <p className="muted">{S.details.hint}</p>}
        {selection?.kind === 'request' && <RequestDetails cmp={cmp} at={at} states={states} request={selection.request} onSelect={onSelect} />}
        {selection?.kind === 'iteration' && <IterationDetails cmp={cmp} panel={selection.panel} iteration={selection.iteration} state={states[selection.panel]} onSelect={onSelect} />}
      </div>
    </section>
  );
}

function RequestDetails({ cmp, at, states, request, onSelect }: { cmp: Comparison; at: Playhead; states: DetailsProps['states']; request: number; onSelect: (s: Selection) => void }) {
  const item = cmp.trace[request]!;
  const rows = PANEL_IDS.map(panel => {
    const run = cmp.panels[panel];
    const s = states[panel];
    const r = s.requests[request]!;
    const h = run.histories[request]!;
    const m = requestMetrics(h, item.outputTokens, r, s.iterationsStarted, cmp.config.slo);
    const id = (i: number) => run.trace[i]?.id ?? String(i);
    const blocks = liveBlockIds(run, r, request);
    const note =
      r.phase === 'infeasible' && h.infeasible ? explain(S.infeasible, h.infeasible, id)
      : r.phase === 'waiting' ? explain(S.waitReason, waitReason(run, states[panel], request), id)
      : r.phase === 'completed' ? S.details.releasedNote(h.peakBlocks, item.promptTokens + item.outputTokens - 1)
      : null;
    return { panel, s, r, h, m, blocks, note, run };
  });
  const line = (label: string, f: (x: (typeof rows)[number]) => string, testId?: string) => (
    <tr>
      <th scope="row">{label}</th>
      {rows.map(x => (
        <td key={x.panel} className="num" data-testid={testId ? `${testId}-${x.panel}` : undefined}>
          {f(x)}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="stack">
      <dl className="kv">
        <dt>{S.details.prompt}</dt>
        <dd>{item.promptTokens}</dd>
        <dt>{S.details.output}</dt>
        <dd>{item.outputTokens}</dd>
        <dt>{S.details.arrival}</dt>
        <dd>{formatMs(item.arrivalUs)}</dd>
      </dl>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th />
              {rows.map(x => (
                <th key={x.panel} className="num">
                  {S.panel(x.panel)} · {S.policy[x.run.policy].short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {line(S.details.state, x => S.phase[x.r.phase], 'detail-state')}
            {line(S.details.generated, x => `${x.r.generatedTokens} / ${item.outputTokens}`, 'detail-generated')}
            {line(S.details.cachedTokens, x => (x.r.inflightTokens > 0 ? `${x.r.cachedTokens} + ${x.r.inflightTokens}` : String(x.r.cachedTokens)), 'detail-cached')}
            {line(S.details.allocatedBlocks, x => String(x.r.allocatedBlocks), 'detail-allocated')}
            {line(S.details.reservedBlocks, x => String(x.r.reservedBlocks), 'detail-reserved')}
            {line(S.details.blockIds, x => (x.blocks.length === 0 ? '–' : x.blocks.length > 8 ? `${x.blocks.slice(0, 8).join(', ')}, …` : x.blocks.join(', ')))}
            {line(S.details.admitted, x => (x.h.admittedUs !== null && x.r.phase !== 'pending' && x.r.phase !== 'waiting' ? formatMs(x.h.admittedUs) : S.common.na))}
            {line(S.details.queueDelay, x => formatMs(x.m.queueDelayUs))}
            {line(S.details.ttft, x => formatMs(x.m.ttftUs), 'detail-ttft')}
            {line(S.details.tpot, x => formatMs(x.m.tpotUs))}
            {line(S.details.e2e, x => formatMs(x.m.e2eUs))}
            {line(S.details.maxItl, x => (x.m.itlUs.length === 0 ? S.common.na : formatMs(Math.max(...x.m.itlUs))))}
            {line(S.details.chunks, x => String(x.h.prefills.filter(c => c.iteration < x.s.iterationsStarted).length))}
            {line(S.details.decodes, x => String(x.h.decodeIterations.filter(i => i < x.s.iterationsStarted).length))}
          </tbody>
        </table>
      </div>
      {rows.map(x =>
        x.note ? (
          <p key={x.panel} className="small">
            <strong>{S.panel(x.panel)}.</strong> {x.note}
          </p>
        ) : null,
      )}
      <p className="muted small">
        {S.details.reason}:{' '}
        {rows.map(x => {
          const it = x.h.prefills[0]?.iteration ?? x.h.decodeIterations[0];
          return it === undefined ? null : (
            <button key={x.panel} type="button" className="link" style={{ marginRight: 12 }} onClick={() => onSelect({ kind: 'iteration', panel: x.panel, iteration: it })}>
              {S.details.iteration(S.panel(x.panel), it)}
            </button>
          );
        })}
      </p>
    </div>
  );
}

function IterationDetails({ cmp, panel, iteration, state, onSelect }: { cmp: Comparison; panel: PanelId; iteration: number; state: Readonly<SimState>; onSelect: (s: Selection) => void }) {
  const run = cmp.panels[panel];
  const it = run.iterations[iteration];
  if (!it) return null;
  return (
    <div className="stack">
      <div className="row-between small mono">
        <span>
          {formatMs(it.startUs)} → {formatMs(it.endUs)}
        </span>
        <span>{S.batch.tokenBudget(it.prefillTokens + it.decodeTokens, run.limits.maxBatchTokens)}</span>
        <span>{S.batch.sequences(it.entries.length, run.limits.maxActiveSequences)}</span>
      </div>
      <IterationExplanation run={run} it={it} state={state} onSelectRequest={request => onSelect({ kind: 'request', request })} />
      <h4 className="small">{S.details.cost}</h4>
      <CostTerms it={it} />
      <div className="row-between">
        <button type="button" className="btn" disabled={iteration === 0} onClick={() => onSelect({ kind: 'iteration', panel, iteration: iteration - 1 })}>
          ← {iteration - 1}
        </button>
        <button type="button" className="btn" disabled={iteration + 1 >= run.iterations.length} onClick={() => onSelect({ kind: 'iteration', panel, iteration: iteration + 1 })}>
          {iteration + 1} →
        </button>
      </div>
    </div>
  );
}

export function describeEvent(cmp: Comparison, panel: PanelId, e: SimEvent): string {
  const run = cmp.panels[panel];
  const D = S.events.describe;
  const id = (i: number) => run.trace[i]!.id;
  switch (e.kind) {
    case 'arrived':
      return D.arrived(id(e.request));
    case 'rejected':
      return D.rejected(id(e.request));
    case 'admitted':
      return D.admitted(id(e.request), e.reservedBlocks);
    case 'iterationStarted':
      return D.iterationStarted(e.iteration, run.iterations[e.iteration]!.entries.length);
    case 'iterationCompleted':
      return D.iterationCompleted(e.iteration);
    case 'released':
      return D.released(id(e.request), e.freedBlocks);
    case 'runEnded':
      return D.runEnded();
  }
}

export function EventLog({ cmp, at, onSeekStep }: { cmp: Comparison; at: Playhead; onSeekStep: (applied: number) => void }) {
  const total = cmp.steps.timeUs.length;
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = listRef.current;
    const current = box?.querySelector<HTMLElement>('li.current');
    if (box && current) box.scrollTop = current.offsetTop - box.clientHeight / 2;
  }, [at.applied]);
  const from = Math.max(0, at.applied - 40);
  const to = Math.min(total, at.applied + 12);
  const items = [];
  for (let k = from; k < to; k++) {
    const panel = cmp.steps.panel[k]!;
    const e = cmp.panels[panel].events[cmp.steps.event[k]!]!;
    const cls = k === at.applied - 1 ? 'current' : k >= at.applied ? 'future' : '';
    items.push(
      <li key={k} className={cls} aria-current={k === at.applied - 1 ? 'step' : undefined}>
        <button type="button" onClick={() => onSeekStep(k + 1)} title={S.events.jump}>
          <span className="mono">{formatMs(e.timeUs)}</span>
          <span className={`panel-tag ${panel.toLowerCase()}`}>{panel}</span>
          <span>{describeEvent(cmp, panel, e)}</span>
        </button>
      </li>,
    );
  }
  return (
    <section className="card" aria-labelledby="events-heading" data-testid="event-log">
      <div className="card-head">
        <h2 id="events-heading">{S.events.heading}</h2>
        <span className="spacer muted small mono">{S.playback.event(at.applied, total)}</span>
      </div>
      <div className="events" ref={listRef}>
        <ol>{items}</ol>
      </div>
    </section>
  );
}
