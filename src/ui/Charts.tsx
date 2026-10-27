import { useMemo } from 'react';
import type { SimResult } from '../engine/types';
import { t } from '../i18n';
import { PanelTag } from './controls';
import type { PanelData } from './derived';
import { formatInt, formatMs } from './format';

// Secondary time-series charts. Paths use a fixed viewBox stretched to the container width.

const W = 1000;
const H = 90;

interface Series { kvAlloc: string; kvReserved: string; batch: string; queue: string; maxQueue: number }

function buildSeries(result: SimResult, domain: number, kvMax: number, countMax: number): Series {
  const x = (ms: number) => ((ms / domain) * W).toFixed(1);
  const y = (v: number, max: number) => (H - (v / Math.max(1, max)) * (H - 4)).toFixed(1);
  let kvAlloc = `M0 ${H}`;
  let kvReserved = `M0 ${y(0, kvMax)}`;
  let batch = `M0 ${H}`;
  let prevEnd = 0;
  for (const it of result.iterations) {
    if (it.startMs > prevEnd + 1e-9) {
      kvAlloc += `L${x(prevEnd)} ${H}L${x(it.startMs)} ${H}`;
      kvReserved += `L${x(prevEnd)} ${y(0, kvMax)}L${x(it.startMs)} ${y(0, kvMax)}`;
      batch += `L${x(prevEnd)} ${H}L${x(it.startMs)} ${H}`;
    }
    kvAlloc += `L${x(it.startMs)} ${y(it.allocatedBlocks, kvMax)}L${x(it.endMs)} ${y(it.allocatedBlocks, kvMax)}`;
    kvReserved += `L${x(it.startMs)} ${y(it.reservedBlocks, kvMax)}L${x(it.endMs)} ${y(it.reservedBlocks, kvMax)}`;
    batch += `L${x(it.startMs)} ${y(it.sequencesScheduled, countMax)}L${x(it.endMs)} ${y(it.sequencesScheduled, countMax)}`;
    prevEnd = it.endMs;
  }
  kvAlloc += `L${x(prevEnd)} ${H}Z`;
  batch += `L${x(prevEnd)} ${H}Z`;
  // Queue length (arrived, not yet admitted or rejected), from events.
  let queue = `M0 ${y(0, countMax)}`;
  let q = 0;
  let maxQueue = 0;
  for (const e of result.events) {
    const before = q;
    if (e.type === 'arrival') q++;
    else if (e.type === 'admit' || e.type === 'infeasible') q--;
    else continue;
    queue += `L${x(e.t)} ${y(before, countMax)}L${x(e.t)} ${y(q, countMax)}`;
    maxQueue = Math.max(maxQueue, q);
  }
  queue += `L${W} ${y(q, countMax)}`;
  return { kvAlloc, kvReserved, batch, queue, maxQueue };
}

function queuePeak(result: SimResult): number {
  let q = 0;
  let peak = 0;
  for (const e of result.events) {
    if (e.type === 'arrival') q++;
    else if (e.type === 'admit' || e.type === 'infeasible') q--;
    peak = Math.max(peak, q);
  }
  return peak;
}

export function Charts({ panels, endMs, time }: { panels: PanelData[]; endMs: number; time: number }) {
  const valid = panels.filter(p => p.valid);
  const domain = Math.max(1, endMs * 1.015);
  // Scale KV to the observed peak unless the pool itself is the binding limit.
  const pool = Math.max(1, ...valid.map(p => p.result.memory?.totalBlocks ?? 1));
  const peak = Math.max(1, ...valid.map(p => Math.max(p.result.peakReservedBlocks, p.result.peakAllocatedBlocks)));
  const kvMax = peak > pool * 0.6 ? pool : Math.ceil(peak * 1.25);
  const countMax = Math.max(1, ...valid.map(p => Math.max(p.result.scheduler.maxActiveSequences, queuePeak(p.result))));
  const series = useMemo(() => valid.map(p => ({ panel: p, s: buildSeries(p.result, domain, kvMax, countMax) })), [panels, domain, kvMax, countMax]); // eslint-disable-line react-hooks/exhaustive-deps
  if (valid.length === 0) return null;
  const cursor = `${Math.min(100, (time / domain) * 100)}%`;
  return (
    <section className="card charts-card" aria-labelledby="charts-title">
      <div className="card-head">
        <h2 id="charts-title">{t.charts.title}</h2>
        <span className="caption">0 – {formatMs(endMs)}</span>
      </div>
      <div className={`charts-grid cols-${series.length}`}>
        {series.map(({ panel, s }) => (
          <div key={panel.id} className="chart-pair">
            <div className="chart">
              <div className="chart-head"><PanelTag panel={panel.id} /> {t.charts.kv} <span className="muted small">axis 0–{formatInt(kvMax)} · pool {formatInt(pool)}</span></div>
              <div className="chart-plot">
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Panel ${panel.id} KV blocks allocated and reserved over time`}>
                  <path d={s.kvAlloc} className="ch-kv-alloc" />
                  <path d={s.kvReserved} className="ch-kv-reserved" vectorEffect="non-scaling-stroke" />
                  {kvMax === pool && <line x1={0} x2={W} y1={4} y2={4} className="ch-limit" vectorEffect="non-scaling-stroke" />}
                </svg>
                <div className="chart-cursor" style={{ left: cursor }} />
              </div>
              <div className="chart-legend small"><span><i className="swatch seg-kv" />{t.charts.kvAllocated}</span><span><i className="swatch line-reserved" />{t.charts.kvReserved}</span></div>
            </div>
            <div className="chart">
              <div className="chart-head"><PanelTag panel={panel.id} /> Batch size and queue <span className="muted small">max {countMax}</span></div>
              <div className="chart-plot">
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Panel ${panel.id} scheduled requests per iteration and queue length over time`}>
                  <path d={s.batch} className="ch-batch" />
                  <path d={s.queue} className="ch-queue" vectorEffect="non-scaling-stroke" />
                </svg>
                <div className="chart-cursor" style={{ left: cursor }} />
              </div>
              <div className="chart-legend small"><span><i className="swatch seg-batch" />requests in the iteration</span><span><i className="swatch line-queue" />queued (peak {s.maxQueue})</span></div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
