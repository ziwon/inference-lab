import type { Snapshot } from '../engine/replay';
import type { Decision, IterationRecord } from '../engine/types';
import { t } from '../i18n';
import { PanelTag, PhaseGlyph } from './controls';
import type { PanelData } from './derived';
import { describeDecision, summarizeIteration } from './describe';
import { formatMs } from './format';
import { Icon } from './icons';

interface Props {
  panel: PanelData;
  snapshot: Snapshot;
  selectedReq: number | null;
  onSelectReq: (req: number) => void;
  onSeek: (ms: number) => void;
}

type View =
  | { kind: 'iteration'; it: IterationRecord; running: boolean }
  | { kind: 'idle'; until: number }
  | { kind: 'not-started' };

function viewFor(panel: PanelData, snap: Snapshot): View {
  const { iterations, events } = panel.result;
  if (snap.runningIteration !== null) return { kind: 'iteration', it: iterations[snap.runningIteration], running: true };
  const last = snap.eventCount > 0 ? events[snap.eventCount - 1] : null;
  if (last?.type === 'idle') return { kind: 'idle', until: last.untilMs };
  if (snap.lastIteration !== null) return { kind: 'iteration', it: iterations[snap.lastIteration], running: false };
  return { kind: 'not-started' };
}

const GROUPS: { key: 'ran' | 'deferred' | 'queued'; match: (d: Decision) => boolean }[] = [
  { key: 'ran', match: d => d.code.startsWith('run-') },
  { key: 'deferred', match: d => d.code.startsWith('defer-') },
  { key: 'queued', match: d => d.code.startsWith('queue-') },
];

export function BatchInspector({ panel, snapshot, selectedReq, onSelectReq, onSeek }: Props) {
  const { result } = panel;
  const view = viewFor(panel, snapshot);
  const policy = result.policy;
  return (
    <section className="card inspector" aria-label={`Panel ${panel.id} ${t.batch.title}`}>
      <div className="card-head compact">
        <h3><PanelTag panel={panel.id} /> {t.batch.title}</h3>
        <span className="muted small">{t.policy.short[policy]}</span>
      </div>
      {view.kind === 'not-started' && (
        <div className="empty-state"><strong>{t.batch.notStarted}</strong><p>{t.batch.notStartedBody}</p></div>
      )}
      {view.kind === 'idle' && (
        <div className="empty-state"><strong>{t.batch.idle}</strong><p>{t.batch.idleBody(formatMs(view.until))}</p></div>
      )}
      {view.kind === 'iteration' && (
        <IterationView panel={panel} it={view.it} running={view.running} finished={snapshot.finished !== null} selectedReq={selectedReq} onSelectReq={onSelectReq} onSeek={onSeek} />
      )}
    </section>
  );
}

function IterationView({ panel, it, running, finished, selectedReq, onSelectReq, onSeek }: { panel: PanelData; it: IterationRecord; running: boolean; finished: boolean; selectedReq: number | null; onSelectReq: (req: number) => void; onSeek: (ms: number) => void }) {
  const { result } = panel;
  const trace = result.trace;
  const itemsByReq = new Map(it.items.map(i => [i.req, i]));
  const budgetLeft = it.tokenBudget - it.tokensScheduled;
  const pct = (n: number, d: number) => `${Math.min(100, (n / Math.max(1, d)) * 100)}%`;
  const lines = summarizeIteration(it, result.policy, trace);
  const total = result.iterations.length;
  return (
    <div className="iteration-view">
      <div className="iter-nav">
        <button className="icon-button" onClick={() => onSeek(result.iterations[it.index - 1].startMs)} disabled={it.index === 0} aria-label={t.batch.prevIteration} title={t.batch.prevIteration}><Icon.prev /></button>
        <div className="iter-title">
          <strong>{t.batch.iteration(it.index + 1)}</strong>
          <span className="muted mono small"> / {total}</span>
          <div className="mono small muted">{formatMs(it.startMs)} → {formatMs(it.endMs)} · {formatMs(it.endMs - it.startMs)}</div>
        </div>
        <button className="icon-button" onClick={() => onSeek(result.iterations[it.index + 1].startMs)} disabled={it.index >= total - 1} aria-label={t.batch.nextIteration} title={t.batch.nextIteration}><Icon.next /></button>
      </div>
      {!running && <p className="status-note">{finished ? t.batch.finished : t.batch.between} · showing the last iteration</p>}
      <div className="iter-summary">{lines.map((line, i) => <p key={i}>{line}</p>)}</div>

      <div className="budget">
        <div className="budget-row">
          <span className="budget-label">{t.batch.tokens}</span>
          <div className="meter" role="img" aria-label={`${it.prefillTokens} prefill and ${it.decodeTokens} decode tokens of ${it.tokenBudget}`}>
            <span className="meter-prefill" style={{ width: pct(it.prefillTokens, it.tokenBudget) }} />
            <span className="meter-decode" style={{ width: pct(it.decodeTokens, it.tokenBudget) }} />
          </div>
          <span className="budget-value mono">{it.tokensScheduled}/{it.tokenBudget}</span>
        </div>
        <div className="budget-legend small muted">
          <span><i className="dot dot-prefill" />{it.prefillTokens} {t.batch.prefill}</span>
          <span><i className="dot dot-decode" />{it.decodeTokens} {t.batch.decode}</span>
          <span><i className="dot dot-free" />{budgetLeft} {t.batch.left}</span>
        </div>
        <div className="budget-row">
          <span className="budget-label">{t.batch.sequences}</span>
          <div className="meter" role="img" aria-label={`${it.sequencesScheduled} of ${it.sequenceLimit} sequences`}>
            <span className="meter-seq" style={{ width: pct(it.sequencesScheduled, it.sequenceLimit) }} />
          </div>
          <span className="budget-value mono">{it.sequencesScheduled}/{it.sequenceLimit}</span>
        </div>
      </div>

      <div className="cost-line small">
        <span className="muted">{t.batch.cost}</span>{' '}
        <span className="mono">
          {formatMs(it.cost.overheadMs)} {t.batch.costParts.overhead} + {formatMs(it.cost.linearMs)} {t.batch.costParts.linear}
          {it.cost.prefillAttentionMs > 0 && <> + {formatMs(it.cost.prefillAttentionMs)} {t.batch.costParts.prefillAttention}</>}
          {it.cost.decodeAttentionMs > 0 && <> + {formatMs(it.cost.decodeAttentionMs)} {t.batch.costParts.decodeAttention}</>}
          {' '}= <strong>{formatMs(it.cost.totalMs)}</strong>
        </span>
      </div>

      <div className="decisions" tabIndex={0} aria-label="Scheduling decisions">
        {GROUPS.map(group => {
          const decisions = it.decisions.filter(group.match);
          if (decisions.length === 0) return null;
          return (
            <div key={group.key} className="decision-group">
              <h4>{t.batch[group.key]} <span className="muted">({decisions.length + (group.key === 'queued' ? it.omittedQueued : 0)})</span></h4>
              <ul>
                {decisions.map(d => {
                  const item = itemsByReq.get(d.req);
                  const glyph = d.code === 'run-decode' ? 'decode' : d.code.startsWith('run-prefill') ? 'prefill' : d.code.startsWith('defer') ? 'admitted' : 'waiting';
                  return (
                    <li key={`${d.req}-${d.code}`} className={selectedReq === d.req ? 'is-selected' : ''}>
                      <PhaseGlyph phase={glyph} />
                      <button className="link-button mono" onClick={() => onSelectReq(d.req)}>{trace[d.req].id}</button>
                      <span>{describeDecision(d, item, trace, result.policy, it.sequenceLimit)}</span>
                    </li>
                  );
                })}
              </ul>
              {group.key === 'queued' && it.omittedQueued > 0 && <p className="small muted">{t.batch.moreQueued(it.omittedQueued)}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
