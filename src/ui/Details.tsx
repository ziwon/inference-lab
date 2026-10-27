import { useEffect, useMemo, useRef, useState } from 'react';
import { requestMetrics } from '../engine/metrics';
import type { Snapshot } from '../engine/replay';
import type { PanelId, SimEvent, SloConfig } from '../engine/types';
import { t } from '../i18n';
import { PanelTag, PhaseBadge } from './controls';
import type { PanelData } from './derived';
import { describeEvent, eventRequest } from './describe';
import { formatInt, formatMs } from './format';
import { Icon } from './icons';

interface Props {
  panels: PanelData[];
  snapshots: Partial<Record<PanelId, Snapshot>>;
  time: number;
  slo: SloConfig;
  selectedReq: number | null;
  onClearReq: () => void;
  onSelectReq: (req: number) => void;
  onSeek: (ms: number) => void;
}

export function Details({ panels, snapshots, time, slo, selectedReq, onClearReq, onSelectReq, onSeek }: Props) {
  const valid = panels.filter(p => p.valid);
  const trace = panels[0]?.result.trace ?? [];
  return (
    <section className="card details-card" aria-labelledby="details-title">
      <div className="card-head">
        <h2 id="details-title">{t.details.title}{selectedReq !== null && trace[selectedReq] ? ` · ${t.details.request(trace[selectedReq].id)}` : ''}</h2>
        {selectedReq !== null && <button className="icon-button" onClick={onClearReq} aria-label={t.details.clear} title={t.details.clear}><Icon.close /></button>}
      </div>
      {selectedReq === null || !trace[selectedReq] ? (
        <p className="caption">{t.details.empty}</p>
      ) : (
        <div className="request-details">
          {valid.map(panel => (
            <RequestDetails key={panel.id} panel={panel} snapshot={snapshots[panel.id]!} req={selectedReq} time={time} slo={slo} onSeek={onSeek} />
          ))}
        </div>
      )}
      <EventLog panels={valid} snapshots={snapshots} selectedReq={selectedReq} onSeek={onSeek} onSelectReq={onSelectReq} />
    </section>
  );
}

function RequestDetails({ panel, snapshot, req, time, slo, onSeek }: { panel: PanelData; snapshot: Snapshot; req: number; time: number; slo: SloConfig; onSeek: (ms: number) => void }) {
  const r = snapshot.requests[req];
  const request = panel.result.trace[req];
  const lane = panel.timelines[req];
  const m = requestMetrics(panel.result, slo, time, [lane])[0];
  const prefillSegs = lane.segments.filter(s => s.kind === 'prefill');
  const decodeSegs = lane.segments.filter(s => s.kind === 'decode');
  const history: { t: number; text: string }[] = [];
  if (lane.arrivalMs !== null) history.push({ t: lane.arrivalMs, text: 'Arrived' });
  const admitEvent = panel.result.events.find((e): e is Extract<SimEvent, { type: 'admit' }> => e.type === 'admit' && e.req === req);
  if (lane.admittedMs !== null) history.push({ t: lane.admittedMs, text: `Admitted, reserved ${admitEvent?.reservedBlocks ?? '?'} blocks` });
  if (lane.infeasibleMs !== null) history.push({ t: lane.infeasibleMs, text: 'Marked infeasible: reservation exceeds the whole pool' });
  if (prefillSegs.length > 0) history.push({ t: prefillSegs[0].startMs, text: prefillSegs.length === 1 ? `Prefill: ${prefillSegs[0].tokens} tokens in iteration ${prefillSegs[0].iteration + 1}` : `Prefill: ${prefillSegs.length} chunks (${prefillSegs.map(s => s.tokens).join(' + ')} tokens), iterations ${prefillSegs[0].iteration + 1}–${prefillSegs[prefillSegs.length - 1].iteration + 1}` });
  if (lane.tokenTimes.length > 0) history.push({ t: lane.tokenTimes[0], text: 'First output token emitted' });
  if (decodeSegs.length > 0) history.push({ t: decodeSegs[0].startMs, text: `Decode: ${decodeSegs.length} iteration${decodeSegs.length === 1 ? '' : 's'}` });
  if (lane.completedMs !== null) history.push({ t: lane.completedMs, text: `Completed; released ${r.peakAllocatedBlocks} blocks` });
  history.sort((a, b) => a.t - b.t);

  return (
    <div className="request-detail">
      <div className="request-detail-head">
        <PanelTag panel={panel.id} />
        <PhaseBadge phase={r.phase} running={r.running} />
      </div>
      <dl className="kv-grid">
        <div><dt>{t.details.prompt}</dt><dd className="mono">{formatInt(request.promptTokens)}</dd></div>
        <div><dt>{t.details.output}</dt><dd className="mono">{formatInt(request.outputTokens)}</dd></div>
        <div><dt>{t.details.generated}</dt><dd className="mono">{formatInt(r.generatedTokens)} / {formatInt(request.outputTokens)}</dd></div>
        <div><dt>{t.details.cached}</dt><dd className="mono">{formatInt(r.cachedTokens)}{r.inFlightTokens > 0 && <small> +{r.inFlightTokens} writing</small>} <small>/ {formatInt(request.promptTokens + request.outputTokens - 1)} max</small></dd></div>
        <div><dt>{t.details.allocated}</dt><dd className="mono">{formatInt(r.allocatedBlocks)}</dd></div>
        <div><dt>{t.details.reserved}</dt><dd className="mono">{formatInt(r.reservedBlocks)}</dd></div>
        <div><dt>{t.details.peakBlocks}</dt><dd className="mono">{formatInt(r.peakAllocatedBlocks)}</dd></div>
        <div><dt>{t.details.queueDelay}</dt><dd className="mono">{formatMs(m.queueDelayMs)}</dd></div>
        <div><dt>{t.details.ttft}</dt><dd className="mono">{formatMs(m.ttftMs)}</dd></div>
        <div><dt>{t.details.tpot}</dt><dd className="mono">{formatMs(m.tpotMs)}</dd></div>
        <div><dt>{t.details.maxItl}</dt><dd className="mono">{formatMs(m.maxItlMs)}</dd></div>
        <div><dt>{t.details.e2e}</dt><dd className="mono">{formatMs(m.e2eMs)}</dd></div>
      </dl>
      <h4 className="small">{t.details.history}</h4>
      <ol className="history">
        {history.map((h, i) => (
          <li key={i} className={h.t <= time ? '' : 'is-future'}>
            <button className="link-button mono small" onClick={() => onSeek(h.t)}>{formatMs(h.t)}</button>
            <span>{h.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EventLog({ panels, snapshots, selectedReq, onSeek, onSelectReq }: { panels: PanelData[]; snapshots: Partial<Record<PanelId, Snapshot>>; selectedReq: number | null; onSeek: (ms: number) => void; onSelectReq: (req: number) => void }) {
  const [tab, setTab] = useState<PanelId>(panels[0]?.id ?? 'A');
  const panel = panels.find(p => p.id === tab) ?? panels[0];
  const [onlySelected, setOnlySelected] = useState(false);
  const snap = panel ? snapshots[panel.id] : undefined;
  const count = snap?.eventCount ?? 0;
  const windowed = useMemo(() => {
    if (!panel) return [];
    const events = panel.result.events.map((e, index) => ({ e, index }));
    const filtered = onlySelected && selectedReq !== null ? events.filter(x => eventRequest(x.e) === selectedReq || (x.e.type === 'iteration-start' && x.e.iteration.items.some(i => i.req === selectedReq))) : events;
    const pivot = filtered.findIndex(x => x.index >= count);
    const center = pivot === -1 ? filtered.length : pivot;
    return filtered.slice(Math.max(0, center - 14), center + 10);
  }, [panel, count, onlySelected, selectedReq]);
  const listRef = useRef<HTMLOListElement>(null);
  // Keep the cursor's events visible inside the list without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const target = list.querySelector<HTMLElement>('li.is-current') ?? list.querySelector<HTMLElement>('li.is-future');
    if (target) list.scrollTop = Math.max(0, target.offsetTop - list.clientHeight / 2);
  }, [windowed]);
  if (!panel) return null;
  const currentT = count > 0 ? panel.result.events[count - 1].t : -1;
  return (
    <div className="event-log">
      <div className="event-log-head">
        <h3>{t.details.events}</h3>
        {panels.length > 1 && (
          <div className="segmented" role="tablist" aria-label="Event log panel">
            {panels.map(p => (
              <button key={p.id} role="tab" aria-selected={p.id === panel.id} onClick={() => setTab(p.id)}>Panel {p.id}</button>
            ))}
          </div>
        )}
        {selectedReq !== null && (
          <label className="check small"><input type="checkbox" checked={onlySelected} onChange={e => setOnlySelected(e.target.checked)} /> Only {panel.result.trace[selectedReq]?.id}</label>
        )}
      </div>
      <p className="caption">{t.details.eventsCaption}</p>
      {windowed.length === 0 ? <p className="small muted">{t.details.noEvents}</p> : (
        <ol className="events" ref={listRef} aria-label={`Panel ${panel.id} events`}>
          {windowed.map(({ e, index }) => {
            const req = eventRequest(e);
            const applied = index < count;
            return (
              <li key={index} className={`${applied ? '' : 'is-future'} ${applied && e.t === currentT ? 'is-current' : ''} ev-${e.type}`}>
                <button className="link-button mono small ev-time" onClick={() => onSeek(e.t)} aria-label={`Move cursor to ${formatMs(e.t)}`}>{formatMs(e.t)}</button>
                <span className="ev-text">{describeEvent(e, panel.result.trace)}</span>
                {req !== null && <button className="link-button small" onClick={() => onSelectReq(req)}>inspect</button>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
