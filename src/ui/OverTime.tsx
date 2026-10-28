import { useMemo, useState } from 'react';
import type { Comparison } from '../sim/compare.ts';
import { PANEL_IDS, type PanelId } from '../sim/config.ts';
import { type PanelSeries, panelSeries, sampleAt } from '../sim/series.ts';
import { formatMs } from './format.ts';
import { S } from './strings.ts';
import { LABEL_W, PanelTag, type TimeRange, lowerBound, niceStep, useWidth } from './Timeline.tsx';

const CHART_H = 44;
const AXIS_H = 18;

type Measure = Exclude<keyof PanelSeries, 'startUs' | 'endUs'>;

interface ChartSpec {
  id: 'kv' | 'batch';
  title: string;
  area: { measure: Measure; label: string; className: string };
  line: { measure: Measure; label: string; className: string };
}

const CHARTS: readonly ChartSpec[] = [
  { id: 'kv', title: S.overTime.kv, area: { measure: 'allocated', label: S.overTime.allocated, className: 'ot-allocated' }, line: { measure: 'reserved', label: S.overTime.reserved, className: 'ot-reserved' } },
  { id: 'batch', title: S.overTime.batch, area: { measure: 'entries', label: S.overTime.inBatch, className: 'ot-batch' }, line: { measure: 'waiting', label: S.overTime.waiting, className: 'ot-waiting' } },
];

function peak(series: PanelSeries, measure: Measure) {
  const values = series[measure];
  let at = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[at]!) at = i;
  return { value: values[at] ?? 0, atUs: series.startUs[at] ?? 0 };
}

const peaksOf = (s: PanelSeries) => ({ allocated: peak(s, 'allocated'), reserved: peak(s, 'reserved'), entries: peak(s, 'entries'), waiting: peak(s, 'waiting') });

function niceCeil(v: number) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * pow >= v) ?? 10) * pow;
}

function stepPath(series: PanelSeries, measure: Measure, X: (t: number) => number, Y: (v: number) => number, range: TimeRange) {
  const { startUs, endUs } = series;
  const values = series[measure];
  const from = lowerBound(endUs.length, i => endUs[i]!, range.t0);
  const to = lowerBound(startUs.length, i => startUs[i]!, range.t1 + 1);
  if (from >= to) return '';
  const base = Y(0).toFixed(1);
  const parts = [`M${X(startUs[from]!).toFixed(1)} ${base}`];
  for (let i = from; i < to; i++) {
    const x0 = X(startUs[i]!).toFixed(1);
    if (i > from && startUs[i]! > endUs[i - 1]!) parts.push(`L${X(endUs[i - 1]!).toFixed(1)} ${base}L${x0} ${base}`);
    const y = Y(values[i]!).toFixed(1);
    parts.push(`L${x0} ${y}L${X(endUs[i]!).toFixed(1)} ${y}`);
  }
  parts.push(`L${X(endUs[to - 1]!).toFixed(1)} ${base}`);
  return parts.join('');
}

interface Props {
  cmp: Comparison;
  atUs: number;
  range: TimeRange;
  onSeekTime: (timeUs: number) => void;
}

export function OverTime({ cmp, atUs, range, onSeekTime }: Props) {
  const series = useMemo((): Record<PanelId, PanelSeries> => ({ A: panelSeries(cmp.panels.A), B: panelSeries(cmp.panels.B) }), [cmp.panels.A, cmp.panels.B]);
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hoverUs, setHoverUs] = useState<number | null>(null);
  const plotW = Math.max(40, width - LABEL_W - 16);
  const span = Math.max(1, range.t1 - range.t0);
  const X = (t: number) => ((t - range.t0) / span) * plotW;
  const timeAt = (clientX: number, rect: DOMRect) => range.t0 + (Math.max(0, Math.min(plotW, clientX - rect.left)) / plotW) * span;

  const pool = cmp.memory.totalBlocks;
  const peaks = useMemo(() => ({ A: peaksOf(series.A), B: peaksOf(series.B) }), [series]);
  const kvPeak = Math.max(1, ...PANEL_IDS.map(p => peaks[p].reserved.value));
  const kvMax = kvPeak * 2 > pool ? pool : Math.min(pool, niceCeil(kvPeak * 1.1));
  const countMax = Math.max(1, ...PANEL_IDS.flatMap(p => [peaks[p].entries.value, peaks[p].waiting.value]));
  const maxOf = (chart: ChartSpec) => (chart.id === 'kv' ? kvMax : countMax);

  const paths = useMemo(() => {
    const out: Record<string, { area: string; line: string }> = {};
    for (const chart of CHARTS) {
      const max = maxOf(chart);
      const Y = (v: number) => CHART_H - (v / max) * (CHART_H - 2);
      for (const p of PANEL_IDS) out[`${chart.id}-${p}`] = { area: `${stepPath(series[p], chart.area.measure, X, Y, range)}Z`, line: stepPath(series[p], chart.line.measure, X, Y, range) };
    }
    return out;
  }, [series, range.t0, range.t1, plotW, kvMax, countMax]);

  const summary = (chart: ChartSpec, p: PanelId) =>
    chart.id === 'kv'
      ? S.overTime.kvSummary(p, peaks[p].allocated.value, formatMs(peaks[p].allocated.atUs), peaks[p].reserved.value, pool)
      : S.overTime.batchSummary(p, peaks[p].entries.value, peaks[p].waiting.value, formatMs(peaks[p].waiting.atUs));

  const readUs = hoverUs ?? atUs;
  const readout = (p: PanelId) => {
    const s = series[p];
    const i = sampleAt(s, readUs);
    if (i === null) return S.overTime.idle;
    return `${S.overTime.kvReadout(s.allocated[i]!, s.reserved[i]!)} · ${S.overTime.batchReadout(s.entries[i]!, s.waiting[i]!)}`;
  };

  const step = niceStep(span, Math.max(2, Math.floor(plotW / 90)));
  const ticks: number[] = [];
  for (let t = Math.ceil(range.t0 / step) * step; t <= range.t1; t += step) ticks.push(t);
  const vline = (t: number, className: string) => (t >= range.t0 && t <= range.t1 ? <line className={className} x1={X(t)} x2={X(t)} y1={0} y2={CHART_H} /> : null);

  return (
    <section className="card" aria-labelledby="over-time-heading" data-testid="over-time">
      <div className="card-head">
        <h2 id="over-time-heading">{S.overTime.heading}</h2>
        <span className="spacer muted small">{S.overTime.note}</span>
      </div>
      <div className="over-time" ref={wrapRef}>
        <div className="ot-readout small" data-testid="over-time-readout">
          <span className="mono">{S.overTime.at(formatMs(readUs))}</span>
          {PANEL_IDS.map(p => (
            <span key={p}>
              <PanelTag panel={p} /> <span className="mono">{readout(p)}</span>
            </span>
          ))}
        </div>
        {CHARTS.map(chart => (
          <div key={chart.id} className="ot-group">
            <div className="ot-head">
              <h3>{chart.title}</h3>
              <span>
                <svg viewBox="0 0 16 10" aria-hidden="true">
                  <rect className={chart.area.className} x={0} y={2} width={16} height={8} />
                </svg>
                {chart.area.label}
              </span>
              <span>
                <svg viewBox="0 0 16 10" aria-hidden="true">
                  <path className={chart.line.className} d="M0 5H16" />
                </svg>
                {chart.line.label}
              </span>
              <span className="muted">{chart.id === 'kv' ? `${S.overTime.scaleTo(kvMax)} · ${S.overTime.pool(pool)}` : S.overTime.scaleTo(countMax)}</span>
            </div>
            {PANEL_IDS.map(p => (
              <div key={p} className="ot-row">
                <div className="ot-gutter">
                  <PanelTag panel={p} />
                </div>
                <svg
                  className="ot-plot"
                  width={plotW}
                  height={CHART_H}
                  role="img"
                  aria-label={summary(chart, p)}
                  data-testid={`chart-${chart.id}-${p}`}
                  onPointerMove={e => setHoverUs(timeAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
                  onPointerLeave={() => setHoverUs(null)}
                  onClick={e => onSeekTime(timeAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
                >
                  <line className="ot-grid" x1={0} x2={plotW} y1={2} y2={2} />
                  <line className="ot-grid" x1={0} x2={plotW} y1={CHART_H - 0.5} y2={CHART_H - 0.5} />
                  <path className={`ot-area ${chart.area.className}`} d={paths[`${chart.id}-${p}`]!.area} />
                  <path className={`ot-line ${chart.line.className}`} d={paths[`${chart.id}-${p}`]!.line} />
                  {hoverUs !== null && vline(hoverUs, 'ot-crosshair')}
                  {vline(atUs, 'ot-playhead')}
                </svg>
              </div>
            ))}
          </div>
        ))}
        <svg className="ot-axis axis" width={plotW + LABEL_W} height={AXIS_H} aria-hidden="true">
          <text x={8} y={12}>
            {S.timeline.axis}
          </text>
          <g transform={`translate(${LABEL_W} 0)`}>
            {ticks.map(t => (
              <g key={t} transform={`translate(${X(t)} 0)`}>
                <line y1={0} y2={4} stroke="var(--control)" />
                <text y={14} textAnchor={X(t) < 12 ? 'start' : 'middle'}>
                  {(t / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </section>
  );
}
