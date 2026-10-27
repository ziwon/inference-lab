import { useMemo, useState, type ReactNode } from 'react';
import { compareRequests } from '../engine/compare';
import { requestMetrics, summarize, type Distribution, type RequestMetrics, type SummaryMetrics } from '../engine/metrics';
import type { PanelId, SloConfig } from '../engine/types';
import { t } from '../i18n';
import { PanelTag } from './controls';
import type { PanelData } from './derived';
import { formatMs, formatPct, formatRate, formatSignedMs, NA } from './format';

interface Props {
  panels: PanelData[];
  time: number;
  slo: SloConfig;
  selectedReq: number | null;
  onSelectReq: (req: number) => void;
}

type Mode = 'cursor' | 'final';

export function Metrics({ panels, time, slo, selectedReq, onSelectReq }: Props) {
  const [mode, setMode] = useState<Mode>('cursor');
  const asOf = mode === 'final' ? Infinity : time;
  const data = useMemo(
    () => panels.filter(p => p.valid).map(p => {
      const requests = requestMetrics(p.result, slo, asOf, p.timelines);
      return { panel: p, requests, summary: summarize(p.result, slo, asOf, p.timelines, requests) };
    }),
    [panels, slo, asOf],
  );
  if (data.length === 0) return null;
  const pair = data.length === 2;

  return (
    <section className="card metrics-card" aria-labelledby="metrics-title">
      <div className="card-head">
        <div>
          <h2 id="metrics-title">{t.metrics.title}</h2>
          <p className="caption">{t.metrics.caption} {t.metrics.sloTargets(formatMs(slo.ttftMs), formatMs(slo.tpotMs))}.</p>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Metrics time">
          <button role="radio" aria-checked={mode === 'cursor'} onClick={() => setMode('cursor')}>{t.metrics.atCursor}</button>
          <button role="radio" aria-checked={mode === 'final'} onClick={() => setMode('final')}>{t.metrics.final}</button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th scope="col">{t.metrics.metric}</th>
              {data.map(d => <th scope="col" key={d.panel.id}><PanelTag panel={d.panel.id} /> {t.policy.short[d.panel.result.policy]}</th>)}
              {pair && <th scope="col">{t.metrics.difference}</th>}
            </tr>
          </thead>
          <tbody>
            <CountRow label={t.metrics.completed} data={data} pick={s => `${s.counts.completed} / ${s.counts.total}`} />
            <CountRow label={t.metrics.running} data={data} pick={s => String(s.counts.running)} />
            <CountRow label={t.metrics.waiting} data={data} pick={s => String(s.counts.waiting)} />
            <CountRow label={t.metrics.unfinished} data={data} pick={s => String(s.counts.unfinished)} />
            <CountRow label={t.metrics.infeasible} data={data} pick={s => String(s.counts.infeasible)} />
            <DistRow label={`${t.metrics.ttft} p50 / p90 / p99`} data={data} pick={s => s.ttft} />
            <DistRow label={`${t.metrics.tpot} p50 / p90 / p99`} data={data} pick={s => s.tpot} />
            <DistRow label={`${t.metrics.itl} p50 / p90 / p99`} data={data} pick={s => s.itl} extra={d => `max ${formatMs(d.max)}`} />
            <DistRow label={`${t.metrics.e2e} p50 / p90 / p99`} data={data} pick={s => s.e2e} />
            <DistRow label={`${t.metrics.queueDelay} p50 / p90 / p99`} data={data} pick={s => s.queueDelay} />
            <ValueRow label={t.metrics.throughput} data={data} pick={s => s.outputTokensPerSecond} fmt={v => formatRate(v, 'tok/s')} higherBetter />
            <ValueRow label={t.metrics.requestRate} data={data} pick={s => s.requestsPerSecond} fmt={v => formatRate(v, 'req/s')} higherBetter />
            <tr>
              <th scope="row" title={t.metrics.sloHint}>{t.metrics.slo}</th>
              {data.map(d => (
                <td key={d.panel.id} className="mono">
                  {formatPct(d.summary.slo.attainment)} <small>({d.summary.slo.met}/{d.summary.counts.total})</small>
                  <SloBreakdown s={d.summary} />
                </td>
              ))}
              {pair && <td className="mono">{diffCount(data[0].summary.slo.met, data[1].summary.slo.met)}</td>}
            </tr>
            <ValueRow label={t.metrics.goodput} data={data} pick={s => s.slo.goodputTokensPerSecond} fmt={v => formatRate(v, 'tok/s')} higherBetter
              note={d => t.metrics.failed(d.counts.total - d.slo.met)} />
            <ValueRow label={t.metrics.window} hint={t.metrics.windowHint} data={data} pick={s => s.windowMs} fmt={formatMs} />
            <ValueRow label={t.metrics.busy} hint={t.metrics.busyHint} data={data} pick={s => s.busyMs} fmt={formatMs} />
          </tbody>
        </table>
      </div>
      <RequestTable data={data} selectedReq={selectedReq} onSelectReq={onSelectReq} />
    </section>
  );
}

interface Row { panel: PanelData; summary: SummaryMetrics; requests: RequestMetrics[] }

function CountRow({ label, data, pick }: { label: string; data: Row[]; pick: (s: SummaryMetrics) => string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {data.map(d => <td key={d.panel.id} className="mono">{pick(d.summary)}</td>)}
      {data.length === 2 && <td />}
    </tr>
  );
}

function DistRow({ label, data, pick, extra }: { label: string; data: Row[]; pick: (s: SummaryMetrics) => Distribution; extra?: (d: Distribution) => string }) {
  const dists = data.map(d => pick(d.summary));
  return (
    <tr>
      <th scope="row">{label}</th>
      {dists.map((d, i) => (
        <td key={data[i].panel.id} className="mono">
          {d.count === 0 ? NA : `${formatMs(d.p50)} / ${formatMs(d.p90)} / ${formatMs(d.p99)}`}
          <small className="n"> n={d.count}{extra && d.count > 0 ? ` · ${extra(d)}` : ''}</small>
        </td>
      ))}
      {dists.length === 2 && <td className="mono">{deltaCell(dists[0].p50, dists[1].p50, 'p50')}</td>}
    </tr>
  );
}

function ValueRow({ label, data, pick, fmt, higherBetter, hint, note }: { label: string; data: Row[]; pick: (s: SummaryMetrics) => number | null; fmt: (v: number | null) => string; higherBetter?: boolean; hint?: string; note?: (s: SummaryMetrics) => string }) {
  const values = data.map(d => pick(d.summary));
  return (
    <tr>
      <th scope="row" title={hint}>{label}</th>
      {values.map((v, i) => <td key={data[i].panel.id} className="mono">{fmt(v)}{note && <small className="n"> · {note(data[i].summary)}</small>}</td>)}
      {values.length === 2 && <td className="mono">{values[0] === null || values[1] === null ? NA : <span className={trendClass(values[1] - values[0], higherBetter)}>{higherBetter ? `${values[1] - values[0] >= 0 ? '+' : '−'}${fmt(Math.abs(values[1] - values[0]))}` : formatSignedMs(values[1] - values[0])}</span>}</td>}
    </tr>
  );
}

function SloBreakdown({ s }: { s: SummaryMetrics }) {
  const parts: string[] = [];
  if (s.slo.missedTtft) parts.push(`${s.slo.missedTtft} TTFT`);
  if (s.slo.missedTpot) parts.push(`${s.slo.missedTpot} TPOT`);
  if (s.slo.missedBoth) parts.push(`${s.slo.missedBoth} both`);
  if (s.slo.unfinished) parts.push(`${s.slo.unfinished} unfinished`);
  if (s.slo.infeasible) parts.push(`${s.slo.infeasible} infeasible`);
  return (
    <>
      {parts.length > 0 && <small className="n block">not met: {parts.join(', ')}</small>}
      {s.slo.pending > 0 && <small className="n block">{s.slo.pending} still in progress</small>}
    </>
  );
}

function trendClass(delta: number, higherBetter?: boolean) {
  if (Math.abs(delta) < 0.05) return 'trend-flat';
  const better = higherBetter ? delta > 0 : delta < 0;
  return better ? 'trend-better' : 'trend-worse';
}

function deltaCell(a: number | null, b: number | null, label: string): ReactNode {
  if (a === null || b === null) return NA;
  return <span className={trendClass(b - a)}>{formatSignedMs(b - a)} <small>{label}</small></span>;
}

function diffCount(a: number, b: number) {
  const d = b - a;
  return <span className={trendClass(d, true)}>{d === 0 ? '±0' : d > 0 ? `+${d}` : `−${-d}`}</span>;
}

function RequestTable({ data, selectedReq, onSelectReq }: { data: Row[]; selectedReq: number | null; onSelectReq: (req: number) => void }) {
  const pair = data.length === 2;
  const rows = pair ? compareRequests(data[0].requests, data[1].requests) : null;
  const ids: PanelId[] = data.map(d => d.panel.id);
  return (
    <div className="request-table-wrap">
      <h3>{t.metrics.requestsTitle}</h3>
      <p className="caption">{t.metrics.requestsCaption}</p>
      <div className="table-scroll request-table-scroll" tabIndex={0} aria-label={t.metrics.requestsTitle}>
        <table className="request-table">
          <thead>
            <tr>
              <th scope="col">{t.metrics.request}</th>
              <th scope="col" className="num">P / G</th>
              {[t.metrics.ttft, `Max ${t.metrics.itl}`, t.metrics.tpot, t.metrics.e2e].map(h => (
                <th key={h} scope="colgroup" colSpan={ids.length + (pair ? 1 : 0)} className="group">{h}</th>
              ))}
              <th scope="colgroup" colSpan={ids.length}>{t.metrics.sloStatus}</th>
            </tr>
            <tr className="sub">
              <th /><th />
              {[0, 1, 2, 3].map(g => (
                <SubHeads key={g} ids={ids} pair={pair} />
              ))}
              {ids.map(id => <th key={id} scope="col">{id}</th>)}
            </tr>
          </thead>
          <tbody>
            {data[0].requests.map((ra, i) => {
              const all = data.map(d => d.requests[i]);
              const cmp = rows?.[i];
              return (
                <tr key={ra.req} className={selectedReq === ra.req ? 'is-selected' : ''}>
                  <th scope="row"><button className="link-button mono" onClick={() => onSelectReq(ra.req)}>{ra.id}</button></th>
                  <td className="num mono">{ra.promptTokens}/{ra.outputTokens}</td>
                  {all.map((m, k) => <td key={`ttft${k}`} className="num mono">{statusOr(m, m.ttftMs)}</td>)}
                  {pair && <td className="num mono delta">{deltaSpan(cmp!.ttftDeltaMs)}</td>}
                  {all.map((m, k) => <td key={`itl${k}`} className="num mono">{statusOr(m, m.maxItlMs)}</td>)}
                  {pair && <td className="num mono delta">{deltaSpan(cmp!.maxItlDeltaMs)}</td>}
                  {all.map((m, k) => <td key={`tpot${k}`} className="num mono">{statusOr(m, m.tpotMs)}</td>)}
                  {pair && <td className="num mono delta">{deltaSpan(all[0].tpotMs !== null && all[1].tpotMs !== null ? all[1].tpotMs - all[0].tpotMs : null)}</td>}
                  {all.map((m, k) => <td key={`e2e${k}`} className="num mono">{statusOr(m, m.e2eMs)}</td>)}
                  {pair && <td className="num mono delta">{deltaSpan(cmp!.e2eDeltaMs)}</td>}
                  {all.map((m, k) => <td key={`slo${k}`} className={`slo slo-${m.slo}`}>{t.metrics.sloOutcome[m.slo]}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SubHeads({ ids, pair }: { ids: PanelId[]; pair: boolean }) {
  return <>{ids.map(id => <th key={id} scope="col" className="num">{id}</th>)}{pair && <th scope="col" className="num">Δ</th>}</>;
}

function statusOr(m: RequestMetrics, value: number | null) {
  if (value !== null) return formatMs(value);
  if (m.status === 'infeasible') return <span className="muted">infeasible</span>;
  return <span className="muted">{NA}</span>;
}

function deltaSpan(d: number | null) {
  if (d === null) return <span className="muted">{NA}</span>;
  return <span className={trendClass(d)}>{formatSignedMs(d)}</span>;
}

