import { useMemo } from 'react';
import type { Comparison } from '../sim/compare.ts';
import { PANEL_IDS } from '../sim/config.ts';
import { type Distribution, type Summary, requestMetrics, summarize } from '../sim/metrics.ts';
import { formatMs, formatPercent, formatRate } from './format.ts';
import { S } from './strings.ts';

type Row = { label: string; value: (s: Summary) => number | null; show: (v: number | null, s: Summary) => string; n?: (s: Summary) => number; better?: 'lower' | 'higher'; unit: 'ms' | 'rate' | 'count' | 'pct' };

const ms = (pick: (d: Summary) => Distribution, key: 'p50' | 'p90' | 'p99' | 'max', label: string): Row => ({
  label,
  value: s => pick(s)[key],
  show: v => formatMs(v),
  n: s => pick(s).n,
  better: 'lower',
  unit: 'ms',
});

const R = S.results.rows;
const ROWS: Row[] = [
  { label: R.completed, value: s => s.counts.completed, show: v => String(v), better: 'higher', unit: 'count' },
  { label: R.infeasible, value: s => s.counts.infeasible, show: v => String(v), unit: 'count' },
  { label: R.unfinished, value: s => s.counts.active + s.counts.waiting, show: v => String(v), better: 'lower', unit: 'count' },
  ms(s => s.queueDelay, 'p50', R.queueDelay),
  ms(s => s.ttft, 'p50', R.ttftP50),
  ms(s => s.ttft, 'p90', R.ttftP90),
  ms(s => s.tpot, 'p50', R.tpotP50),
  ms(s => s.itl, 'p99', R.itlP99),
  ms(s => s.itl, 'max', R.itlMax),
  ms(s => s.e2e, 'p50', R.e2eP50),
  ms(s => s.e2e, 'p90', R.e2eP90),
  { label: R.throughput, better: 'higher', value: s => s.completedPerSec, show: formatRate, unit: 'rate' },
  { label: R.tokens, better: 'higher', value: s => s.outputTokensPerSec, show: formatRate, unit: 'rate' },
  { label: R.slo, value: s => s.slo.attainment, show: (v, s) => `${formatPercent(v)} (${s.slo.met}/${s.slo.arrived})`, better: 'higher', unit: 'pct' },
  { label: R.goodput, better: 'higher', value: s => s.sloMetPerSec, show: formatRate, unit: 'rate' },
  { label: R.makespan, value: s => s.horizonUs, show: v => formatMs(v), better: 'lower', unit: 'ms' },
];

function delta(row: Row, a: Summary, b: Summary) {
  const va = row.value(a);
  const vb = row.value(b);
  if (va === null || vb === null) return { text: S.common.na, cls: '' };
  const d = vb - va;
  if (Math.abs(d) < (row.unit === 'ms' ? 5 : row.unit === 'pct' ? 0.005 : row.unit === 'rate' ? 0.05 : 0.5)) return { text: '0', cls: '' };
  const better = row.better === undefined ? null : row.better === 'lower' ? d < 0 : d > 0;
  const sign = d > 0 ? '+' : '−';
  const abs = Math.abs(d);
  const text = row.unit === 'ms' ? `${sign}${formatMs(abs)}` : row.unit === 'rate' ? `${sign}${formatRate(abs)}` : row.unit === 'pct' ? `${sign}${(abs * 100).toFixed(0)} pt` : `${sign}${abs}`;
  return { text, cls: better === null ? '' : better ? 'delta-good' : 'delta-bad' };
}

export function Results({ cmp, selected, onSelectRequest }: { cmp: Comparison; selected: number | null; onSelectRequest: (i: number) => void }) {
  const slo = cmp.config.slo;
  const summaries = useMemo(() => ({ A: summarize(cmp.panels.A, cmp.panels.A.endUs, slo), B: summarize(cmp.panels.B, cmp.panels.B.endUs, slo) }), [cmp, slo]);
  const perRequest = useMemo(
    () =>
      cmp.trace.map((item, i) => ({
        item,
        A: requestMetrics(cmp.panels.A.histories[i]!, item.outputTokens, cmp.panels.A.endUs, slo),
        B: requestMetrics(cmp.panels.B.histories[i]!, item.outputTokens, cmp.panels.B.endUs, slo),
      })),
    [cmp, slo],
  );
  return (
    <section className="card" aria-labelledby="results-heading" data-testid="results">
      <div className="card-head">
        <h2 id="results-heading">{S.results.heading}</h2>
      </div>
      <div className="card-body stack">
        <p className="muted small">{S.results.note}</p>
        <p className="muted small">{S.results.sloNote(slo.ttftMs, slo.tpotMs)}</p>
        <div className="table-scroll">
          <table className="data" data-testid="results-table">
            <thead>
              <tr>
                <th>{S.results.metric}</th>
                {PANEL_IDS.map(p => (
                  <th key={p} className="num">
                    {p} · {S.policy[cmp.panels[p].policy].short}
                  </th>
                ))}
                <th className="num">{S.results.delta}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(row => {
                const d = delta(row, summaries.A, summaries.B);
                return (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {PANEL_IDS.map(p => (
                      <td key={p} className="num mono">
                        {row.show(row.value(summaries[p]), summaries[p])}
                        {row.n && <span className="muted"> n={row.n(summaries[p])}</span>}
                      </td>
                    ))}
                    <td className={`num mono ${d.cls}`}>{d.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">{S.results.interval(formatMs(summaries.A.interval.startUs), `${formatMs(summaries.A.interval.endUs)} / ${formatMs(summaries.B.interval.endUs)}`)}</p>

        <h3>{S.results.perRequest}</h3>
        <div className="table-scroll" style={{ maxHeight: 320 }}>
          <table className="data" data-testid="request-outcomes">
            <thead>
              <tr>
                <th>{S.results.columns.id}</th>
                <th className="num">P</th>
                <th className="num">G</th>
                <th>{S.results.columns.status}</th>
                <th className="num">{S.results.columns.ttft} A</th>
                <th className="num">{S.results.columns.ttft} B</th>
                <th className="num">{S.results.columns.e2e} A</th>
                <th className="num">{S.results.columns.e2e} B</th>
                <th>{S.results.columns.slo} A / B</th>
              </tr>
            </thead>
            <tbody>
              {perRequest.map(({ item, A, B }) => (
                <tr key={item.index} className={selected === item.index ? 'sel' : undefined}>
                  <td>
                    <button type="button" className="link mono" onClick={() => onSelectRequest(item.index)}>
                      {item.id}
                    </button>
                  </td>
                  <td className="num mono">{item.promptTokens}</td>
                  <td className="num mono">{item.outputTokens}</td>
                  <td>{A.status === B.status ? S.status[A.status] : `${S.status[A.status]} / ${S.status[B.status]}`}</td>
                  <td className="num mono">{formatMs(A.ttftUs)}</td>
                  <td className="num mono">{formatMs(B.ttftUs)}</td>
                  <td className="num mono">{formatMs(A.e2eUs)}</td>
                  <td className="num mono">{formatMs(B.e2eUs)}</td>
                  <td>
                    {A.meetsSlo ? S.results.met : S.results.missed} / {B.meetsSlo ? S.results.met : S.results.missed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
