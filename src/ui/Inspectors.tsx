import type { Comparison } from '../sim/compare.ts';
import type { PanelId } from '../sim/config.ts';
import type { Iteration, PanelRun } from '../sim/engine.ts';
import { type IterationWaiter, type WaitReason, currentIteration, iterationWaiters, memoryView } from '../sim/inspect.ts';
import type { SimState } from '../sim/state.ts';
import { formatBytes, formatInt, formatMs } from './format.ts';
import { S, explain } from './strings.ts';
import { PanelHeading } from './Timeline.tsx';

const idOf = (run: PanelRun) => (i: number) => run.trace[i]?.id ?? `#${i}`;

function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} />;
}

function BudgetMeter({ it, budget }: { it: Iteration; budget: number }) {
  const pct = (n: number) => `${(100 * n) / budget}%`;
  return (
    <div className="meter" role="img" aria-label={S.batch.tokenBudget(it.prefillTokens + it.decodeTokens, budget)}>
      <div style={{ width: pct(it.prefillTokens), background: 'var(--state-prefill)' }} />
      <div style={{ width: pct(it.decodeTokens), background: 'var(--state-decode)' }} />
    </div>
  );
}

function groupWaiters(queued: IterationWaiter[]) {
  const groups: { requests: number[]; reason: WaitReason }[] = [];
  for (const q of queued) {
    const last = groups[groups.length - 1];
    if (last && JSON.stringify(last.reason) === JSON.stringify(q.reason)) last.requests.push(q.request);
    else groups.push({ requests: [q.request], reason: q.reason });
  }
  return groups;
}

export function IterationExplanation({ run, it, onSelectRequest }: { run: PanelRun; it: Iteration; onSelectRequest: (i: number) => void }) {
  const id = idOf(run);
  const { queued, arrivedDuring } = iterationWaiters(run, it);
  const reqButton = (i: number) => (
    <button type="button" className="link mono" onClick={() => onSelectRequest(i)}>
      {id(i)}
    </button>
  );
  return (
    <div className="stack">
      <div className="table-scroll">
        <table className="data">
          <caption className="visually-hidden">{S.details.ran}</caption>
          <thead>
            <tr>
              <th>{S.batch.request}</th>
              <th>{S.batch.work}</th>
              <th>{S.batch.why}</th>
            </tr>
          </thead>
          <tbody>
            {it.entries.map(e => (
              <tr key={`e${e.request}`}>
                <td>{reqButton(e.request)}</td>
                <td>
                  <span className="kind">
                    <Swatch color={e.kind === 'prefill' ? 'var(--state-prefill)' : 'var(--state-decode)'} />
                    {e.kind === 'prefill' ? S.batch.prefillWork(e.tokens, e.cachedBefore, e.emitsFirstToken) : S.batch.decodeWork(e.cachedBefore + 1)}
                  </span>
                  <div className="muted">{S.batch.newBlocks(e.newBlocks)}</div>
                </td>
                <td>{explain(S.entryReason, e.reason, id)}</td>
              </tr>
            ))}
            {it.skipped.map(s => (
              <tr key={`s${s.request}`}>
                <td>{reqButton(s.request)}</td>
                <td className="muted">{s.kind === 'prefill' ? S.timeline.legend.prefill : S.timeline.legend.decode}: {S.batch.notRun}</td>
                <td>{explain(S.skipReason, s.reason, id)}</td>
              </tr>
            ))}
            {groupWaiters(queued).map(group => (
              <tr key={`q${group.requests[0]}`}>
                <td>
                  {group.requests.slice(0, 6).map(i => (
                    <div key={i}>{reqButton(i)}</div>
                  ))}
                  {group.requests.length > 6 && <div className="muted">{S.batch.more(group.requests.length - 6)}</div>}
                </td>
                <td className="muted">{S.batch.waitingWork}</td>
                <td>{explain(S.waitReason, group.reason, id)}</td>
              </tr>
            ))}
            {arrivedDuring.map(i => (
              <tr key={`a${i}`}>
                <td>{reqButton(i)}</td>
                <td className="muted">{S.batch.waitingWork}</td>
                <td>{S.batch.arrivedDuring}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CostTerms({ it }: { it: Iteration }) {
  const c = it.cost;
  const terms = [
    ['overheadMs', c.overheadMs],
    ['prefillTokenMs', c.prefillTokenMs],
    ['prefillAttentionMs', c.prefillAttentionMs],
    ['decodeSequenceMs', c.decodeSequenceMs],
    ['decodeContextMs', c.decodeContextMs],
  ] as const;
  return (
    <dl className="kv">
      {terms.map(([key, ms]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{S.batch.costTerms[key]}</dt>
          <dd>{ms.toFixed(2)} ms</dd>
        </div>
      ))}
      <dt>{S.batch.duration}</dt>
      <dd>{formatMs(it.endUs - it.startUs)}</dd>
    </dl>
  );
}

export function BatchInspector({ cmp, panel, state, onSelectRequest, onSelectIteration }: { cmp: Comparison; panel: PanelId; state: Readonly<SimState>; onSelectRequest: (i: number) => void; onSelectIteration: (i: number) => void }) {
  const run = cmp.panels[panel];
  const it = currentIteration(run, state);
  return (
    <section className="card" aria-label={`${S.panel(panel)} ${S.batch.heading}`} data-testid={`batch-${panel}`}>
      <PanelHeading cmp={cmp} panel={panel}>
        <h3 className="spacer">{S.batch.heading}</h3>
      </PanelHeading>
      <div className="card-body stack">
        {!it ? (
          <p className="muted">{S.batch.idle}</p>
        ) : (
          <>
            <div className="row-between">
              <strong data-testid={`batch-title-${panel}`}>{state.executing === it.index ? S.batch.executing(it.index) : S.batch.finished(it.index)}</strong>
              <button type="button" className="link small" onClick={() => onSelectIteration(it.index)}>
                {S.batch.showDetails}
              </button>
            </div>
            <BudgetMeter it={it} budget={run.limits.maxBatchTokens} />
            <div className="row-between small mono">
              <span>{S.batch.tokenBudget(it.prefillTokens + it.decodeTokens, run.limits.maxBatchTokens)}</span>
              <span>{S.batch.remaining(it.remainingTokens)}</span>
              <span>{S.batch.sequences(it.entries.length, run.limits.maxActiveSequences)}</span>
              <span>{formatMs(it.endUs - it.startUs)}</span>
            </div>
            <IterationExplanation run={run} it={it} onSelectRequest={onSelectRequest} />
          </>
        )}
      </div>
    </section>
  );
}

export function MemoryInspector({ cmp, panel, state, onSelectRequest }: { cmp: Comparison; panel: PanelId; state: Readonly<SimState>; onSelectRequest: (i: number) => void }) {
  const run = cmp.panels[panel];
  const m = cmp.memory;
  const v = memoryView(run, state);
  const id = idOf(run);
  const total = m.deviceBytes;
  const pct = (bytes: number) => `${Math.max(0, (100 * bytes) / total)}%`;
  const bpct = (blocks: number) => `${Math.max(0, (100 * blocks) / Math.max(1, v.totalBlocks))}%`;
  const fragPct = v.allocatedBlocks === 0 ? 0 : (100 * v.fragmentationTokens) / (v.allocatedBlocks * m.blockSizeTokens);
  return (
    <section className="card" aria-label={`${S.panel(panel)} ${S.memory.heading}`} data-testid={`memory-${panel}`}>
      <PanelHeading cmp={cmp} panel={panel}>
        <h3 className="spacer">{S.memory.heading}</h3>
      </PanelHeading>
      <div className="card-body stack">
        <div className="stack">
          <div className="row-between small">
            <span>{S.memory.device}</span>
            <span className="mono">{formatBytes(m.deviceBytes)}</span>
          </div>
          <div className="meter" role="img" aria-label={`${S.memory.weights} ${formatBytes(m.weightBytes)}, ${S.memory.runtime} ${formatBytes(m.runtimeAllowanceBytes)}, ${S.memory.kvPool} ${formatBytes(m.kvPoolBytes)}`}>
            <div style={{ width: pct(m.weightBytes), background: 'var(--weights)' }} />
            <div style={{ width: pct(m.runtimeAllowanceBytes), background: 'var(--runtime)' }} />
            <div style={{ width: pct(v.allocatedBlocks * m.kvBlockBytes), background: 'var(--state-decode)' }} />
            <div style={{ width: pct(m.kvPoolBytes - v.allocatedBlocks * m.kvBlockBytes), background: 'rgba(178, 232, 121, 0.18)' }} />
          </div>
          <div className="legend" style={{ border: 0, padding: 0 }}>
            <span><Swatch color="var(--weights)" />{S.memory.weights} {formatBytes(m.weightBytes)}</span>
            <span><Swatch color="var(--runtime)" />{S.memory.runtime} {formatBytes(m.runtimeAllowanceBytes)}</span>
            <span><Swatch color="var(--state-decode)" />{S.memory.kvPool} {formatBytes(m.kvPoolBytes)}</span>
          </div>
          {!m.metadataDeclared && <p className="small" style={{ color: 'var(--state-waiting)' }}>{S.memory.metadataMissing}</p>}
        </div>

        <div className="stack">
          <div className="row-between small">
            <span>{S.memory.blocks}</span>
            <span className="mono" data-testid={`kv-blocks-${panel}`}>
              {formatInt(v.allocatedBlocks)} / {formatInt(v.totalBlocks)}
            </span>
          </div>
          <div className="meter" role="img" aria-label={`${S.memory.allocated} ${v.allocatedBlocks}, ${S.memory.headroom} ${v.reservedUnallocatedBlocks}, ${S.memory.unreserved} ${v.unreservedBlocks}`}>
            <div style={{ width: bpct(v.allocatedBlocks), background: 'var(--state-decode)' }} />
            <div className="hatch" style={{ width: bpct(v.reservedUnallocatedBlocks) }} />
          </div>
          <div className="legend" style={{ border: 0, padding: 0 }}>
            <span><Swatch color="var(--state-decode)" />{S.memory.allocated}</span>
            <span><span className="swatch hatch" style={{ border: '1px solid var(--state-decode)' }} />{S.memory.headroom}</span>
            <span><span className="swatch" style={{ border: '1px solid var(--separator)' }} />{S.memory.unreserved}</span>
          </div>
          <dl className="kv">
            <dt>{S.memory.perToken}</dt>
            <dd>{formatBytes(m.kvBytesPerToken)}</dd>
            <dt>{S.memory.perBlock}</dt>
            <dd>{m.blockSizeTokens} tokens · {formatBytes(m.kvBlockBytes)}</dd>
            <dt>{S.memory.allocated}</dt>
            <dd data-testid={`allocated-${panel}`}>{S.memory.blockUnit(v.allocatedBlocks)} · {formatBytes(v.allocatedBlocks * m.kvBlockBytes)}</dd>
            <dt>{S.memory.headroom}</dt>
            <dd data-testid={`headroom-${panel}`}>{S.memory.blockUnit(v.reservedUnallocatedBlocks)}</dd>
            <dt>{S.memory.unreserved}</dt>
            <dd>{S.memory.blockUnit(v.unreservedBlocks)}</dd>
            <dt>{S.memory.free}</dt>
            <dd>{S.memory.blockUnit(v.freeBlocks)}</dd>
            <dt>{S.memory.cached}</dt>
            <dd>{S.memory.tokenUnit(v.cachedTokens)}</dd>
            <dt>{S.memory.inflight}</dt>
            <dd>{S.memory.tokenUnit(v.inflightTokens)}</dd>
            <dt>{S.memory.fragmentation}</dt>
            <dd>{S.memory.tokenUnit(v.fragmentationTokens)} · {fragPct.toFixed(1)}%</dd>
            <dt>{S.memory.peak}</dt>
            <dd>{S.memory.blockUnit(v.peakAllocatedBlocks)}</dd>
            <dt>{S.memory.tail}</dt>
            <dd>{formatBytes(m.unusableTailBytes)}</dd>
          </dl>
          <p className="muted small">{S.memory.headroomNote}</p>
        </div>

        <div className="stack">
          <h4 className="small">{S.memory.rowsHeading}</h4>
          {v.rows.length === 0 ? (
            <p className="muted small">{S.memory.noRows}</p>
          ) : (
            <div className="mem-rows">
              {v.rows.map(row => {
                const width = (n: number) => `${(100 * n) / Math.max(1, row.reservedBlocks)}%`;
                return (
                  <div key={row.request} className="mem-row" title={S.memory.rowSummary(row.cachedTokens, row.inflightTokens, row.allocatedBlocks, row.reservedBlocks)}>
                    <button type="button" className="link mono" onClick={() => onSelectRequest(row.request)}>
                      {id(row.request)}
                    </button>
                    <div>
                      <div className="bar" aria-hidden="true">
                        <div className="hatch" style={{ width: '100%' }} />
                        <div style={{ width: width(row.allocatedBlocks), background: 'var(--state-decode)' }} />
                      </div>
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {S.memory.rowSummary(row.cachedTokens, row.inflightTokens, row.allocatedBlocks, row.reservedBlocks)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
