import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { iterationAt, type RequestTimeline } from '../engine/replay';
import type { IterationRecord, PanelId, TraceRequest } from '../engine/types';
import { t } from '../i18n';
import { PanelTag } from './controls';
import type { PanelData } from './derived';
import { formatAxisMs, niceStep } from './format';
import { Icon } from './icons';

const AXIS_H = 26;
const HEADER_H = 30;
const STRIP_H = 30;
const LANE_H = 20;
const ERROR_H = 64;
const OVERSCAN = 240;

type Row =
  | { kind: 'header'; panel: PanelData; top: number; height: number }
  | { kind: 'strip'; panel: PanelData; top: number; height: number }
  | { kind: 'lane'; panel: PanelData; req: number; top: number; height: number }
  | { kind: 'error'; panel: PanelData; top: number; height: number };

interface Scale { plotW: number; domain: number }
const xOf = (ms: number, s: Scale) => (ms / s.domain) * s.plotW;

interface TimelineProps {
  panels: PanelData[];
  trace: TraceRequest[];
  endMs: number;
  time: number;
  playing: boolean;
  selectedReq: number | null;
  onSelectReq: (req: number) => void;
  onSeek: (ms: number) => void;
}

export function Timeline({ panels, trace, endMs, time, playing, selectedReq, onSelectReq, onSeek }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 420 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [zoom, setZoom] = useState(1);
  const labelW = size.width < 560 ? 84 : 128;
  const plotW = Math.max(240, (size.width - labelW - 12) * zoom);
  const scale: Scale = useMemo(() => ({ plotW, domain: Math.max(1, endMs * 1.015) }), [plotW, endMs]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let top = 0;
    for (const panel of panels) {
      out.push({ kind: 'header', panel, top, height: HEADER_H }); top += HEADER_H;
      if (!panel.valid) { out.push({ kind: 'error', panel, top, height: ERROR_H }); top += ERROR_H; continue; }
      out.push({ kind: 'strip', panel, top, height: STRIP_H }); top += STRIP_H;
      for (let req = 0; req < trace.length; req++) { out.push({ kind: 'lane', panel, req, top, height: LANE_H }); top += LANE_H; }
    }
    return { list: out, total: top };
  }, [panels, trace.length]);

  const viewTop = scroll.top - OVERSCAN;
  const viewBottom = scroll.top + size.height + OVERSCAN;
  const visible = rows.list.filter(r => r.top + r.height >= viewTop && r.top <= viewBottom);
  const cursorX = xOf(Math.min(time, scale.domain), scale);

  // Keep the cursor visible while playing, and after zoom changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || (!playing && zoom === 1)) return;
    const left = el.scrollLeft;
    const visibleW = el.clientWidth - labelW;
    if (cursorX < left || cursorX > left + visibleW - 24) el.scrollLeft = Math.max(0, cursorX - visibleW * 0.25);
  }, [cursorX, playing, zoom, labelW]);

  const ticks = useMemo(() => {
    const step = niceStep(scale.domain, Math.max(2, plotW / 110));
    const out: number[] = [];
    for (let v = 0; v <= scale.domain; v += step) out.push(v);
    return { step, values: out };
  }, [scale.domain, plotW]);

  const frame = useRef(0);
  function onScroll() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) setScroll({ top: Math.max(0, el.scrollTop - AXIS_H), left: el.scrollLeft });
    });
  }

  return (
    <section className="card timeline-card" aria-labelledby="timeline-title">
      <div className="card-head">
        <div>
          <h2 id="timeline-title">{t.timeline.title}</h2>
          <p className="caption">{t.timeline.caption}</p>
        </div>
        <div className="zoom-controls" role="group" aria-label="Timeline zoom">
          <button className="icon-button" onClick={() => setZoom(z => Math.max(1, z / 2))} disabled={zoom <= 1} aria-label={t.timeline.zoomOut} title={t.timeline.zoomOut}><Icon.zoomOut /></button>
          <button className="icon-button" onClick={() => setZoom(1)} disabled={zoom === 1} aria-label={t.timeline.fit} title={t.timeline.fit}><Icon.fit /></button>
          <button className="icon-button" onClick={() => setZoom(z => Math.min(64, z * 2))} disabled={zoom >= 64} aria-label={t.timeline.zoomIn} title={t.timeline.zoomIn}><Icon.zoomIn /></button>
          <span className="zoom-level" aria-live="polite">{zoom}×</span>
        </div>
      </div>
      <div className="tl-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Request timeline, scrollable">
        <div className="tl-content" style={{ width: labelW + plotW, height: AXIS_H + rows.total }}>
          <div className="tl-axis" style={{ height: AXIS_H }}>
            <div className="tl-label tl-axis-label" style={{ width: labelW }}>ms</div>
            <svg width={plotW} height={AXIS_H} aria-hidden="true">
              {ticks.values.map(v => (
                <g key={v} transform={`translate(${xOf(v, scale)},0)`}>
                  <line y1={AXIS_H - 6} y2={AXIS_H} className="tick-line" />
                  <text x={3} y={AXIS_H - 9} className="tick-text">{formatAxisMs(v, ticks.step)}</text>
                </g>
              ))}
              <path d={`M${cursorX - 5} 0 h10 l-5 7 z`} className="cursor-head" />
            </svg>
          </div>
          <div className="tl-rows" style={{ height: rows.total }}>
            {visible.map(row => {
              const style = { top: row.top, height: row.height, width: labelW + plotW };
              const key = `${row.panel.id}-${row.kind}-${'req' in row ? row.req : ''}`;
              if (row.kind === 'header') return <PanelHeaderRow key={key} panel={row.panel} style={style} labelW={labelW} />;
              if (row.kind === 'error') return (
                <div key={key} className="tl-row tl-error" style={style}>
                  <div className="tl-error-body" style={{ left: scroll.left }}>
                    <strong>{t.timeline.incompatible}.</strong> {row.panel.result.issues[0]?.message}
                  </div>
                </div>
              );
              if (row.kind === 'strip') return <IterationStrip key={key} panel={row.panel} style={style} labelW={labelW} scale={scale} onSeek={onSeek} />;
              return (
                <Lane
                  key={key}
                  panelId={row.panel.id}
                  lane={row.panel.timelines[row.req]}
                  request={trace[row.req]}
                  runEnd={row.panel.result.endMs}
                  style={style}
                  labelW={labelW}
                  scale={scale}
                  selected={selectedReq === row.req}
                  onSelect={onSelectReq}
                />
              );
            })}
            <div className="tl-future" style={{ left: labelW + cursorX, width: Math.max(0, plotW - cursorX) }} aria-hidden="true" />
            <div className="tl-cursor" style={{ left: labelW + cursorX }} aria-hidden="true" />
          </div>
        </div>
      </div>
      <TimelineLegend />
    </section>
  );
}

function PanelHeaderRow({ panel, style, labelW }: { panel: PanelData; style: CSSProperties; labelW: number }) {
  const r = panel.result;
  return (
    <div className="tl-row tl-panel-header" style={style}>
      <div className="tl-label tl-sticky" style={{ width: Math.max(labelW, 280) }}>
        <PanelTag panel={panel.id} />
        <span className="tl-panel-name">{t.policy.long[r.policy]}</span>
        {panel.valid && <span className="tl-panel-meta">{r.iterations.length} iterations</span>}
      </div>
    </div>
  );
}

const IterationStrip = memo(function IterationStrip({ panel, style, labelW, scale, onSeek }: { panel: PanelData; style: CSSProperties; labelW: number; scale: Scale; onSeek: (ms: number) => void }) {
  const iterations = panel.result.iterations;
  const paths = useMemo(() => stripPaths(iterations, scale), [iterations, scale]);
  function click(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ms = ((event.clientX - rect.left) / scale.plotW) * scale.domain;
    const index = iterationAt(iterations, ms);
    if (index !== null) onSeek(iterations[index].startMs);
  }
  return (
    <div className="tl-row tl-strip" style={style}>
      <div className="tl-label tl-sticky" style={{ width: labelW }} title={t.timeline.iterationStripHint}>{t.timeline.iterations}</div>
      <svg width={scale.plotW} height={STRIP_H} onClick={click} className="clickable" role="img" aria-label={`${iterations.length} iterations. Bar height shows scheduled tokens relative to the budget; orange is prefill, blue is decode. ${t.timeline.iterationStripHint}`}>
        <line x1={0} x2={scale.plotW} y1={STRIP_H - 2.5} y2={STRIP_H - 2.5} className="strip-base" />
        <path d={paths.decode} className="strip-decode" />
        <path d={paths.prefill} className="strip-prefill" />
      </svg>
    </div>
  );
});

function stripPaths(iterations: readonly IterationRecord[], scale: Scale) {
  const maxH = STRIP_H - 6;
  let prefill = '';
  let decode = '';
  for (const it of iterations) {
    const x = xOf(it.startMs, scale);
    const w = Math.max(0.6, xOf(it.endMs, scale) - x - (xOf(it.endMs, scale) - x > 3 ? 0.8 : 0));
    const total = Math.max(1, it.tokenBudget);
    const hp = (it.prefillTokens / total) * maxH;
    const hd = Math.max(it.decodeTokens > 0 ? 1.5 : 0, (it.decodeTokens / total) * maxH);
    const base = STRIP_H - 3;
    if (hd > 0) decode += `M${x.toFixed(2)} ${(base - hd).toFixed(2)}h${w.toFixed(2)}v${hd.toFixed(2)}h${(-w).toFixed(2)}z`;
    if (hp > 0) prefill += `M${x.toFixed(2)} ${(base - hd - hp).toFixed(2)}h${w.toFixed(2)}v${hp.toFixed(2)}h${(-w).toFixed(2)}z`;
  }
  return { prefill, decode };
}

interface LaneProps {
  panelId: PanelId;
  lane: RequestTimeline;
  request: TraceRequest;
  runEnd: number;
  style: CSSProperties;
  labelW: number;
  scale: Scale;
  selected: boolean;
  onSelect: (req: number) => void;
}

const Lane = memo(function Lane({ panelId, lane, request, runEnd, style, labelW, scale, selected, onSelect }: LaneProps) {
  const shapes = useMemo(() => laneShapes(lane, runEnd, scale), [lane, runEnd, scale]);
  return (
    <div className={`tl-row tl-lane ${selected ? 'is-selected' : ''}`} style={style}>
      <button
        className="tl-label tl-sticky tl-lane-label"
        style={{ width: labelW }}
        onClick={() => onSelect(lane.req)}
        aria-pressed={selected}
        aria-label={`Panel ${panelId}. ${t.timeline.laneLabel(request.id, request.promptTokens, request.outputTokens)}`}
      >
        <span className="lane-id">{request.id}</span>
        <span className="lane-dims">{request.promptTokens}/{request.outputTokens}</span>
      </button>
      <svg width={scale.plotW} height={LANE_H} onClick={() => onSelect(lane.req)} className="clickable" aria-hidden="true">
        {shapes.queue && <line {...shapes.queue} className="lane-queue" />}
        {shapes.idle && <line {...shapes.idle} className="lane-idle" />}
        <path d={shapes.decode} className="lane-decode" />
        {shapes.prefill.map((r, i) => <rect key={i} {...r} className="lane-prefill" rx={1} />)}
        <path d={shapes.ticks} className="lane-tick" />
        {shapes.arrival !== null && <circle cx={shapes.arrival} cy={LANE_H / 2} r={2.6} className="lane-arrival" />}
        {shapes.done !== null && <path d={`M${shapes.done - 4} ${LANE_H / 2} l3 3.5 l5 -7`} className="lane-done" />}
        {shapes.infeasible !== null && <path d={`M${shapes.infeasible - 3.5} 6.5 l7 7 M${shapes.infeasible + 3.5} 6.5 l-7 7`} className="lane-infeasible" />}
      </svg>
    </div>
  );
});

function laneShapes(lane: RequestTimeline, runEnd: number, scale: Scale) {
  const mid = LANE_H / 2;
  const x = (ms: number) => xOf(ms, scale);
  const arrival = lane.arrivalMs === null ? null : x(lane.arrivalMs);
  const queueEnd = lane.admittedMs ?? lane.infeasibleMs ?? runEnd;
  const queue = lane.arrivalMs === null || queueEnd <= lane.arrivalMs ? null : { x1: x(lane.arrivalMs), x2: x(queueEnd), y1: mid, y2: mid };
  const idleEnd = lane.completedMs ?? runEnd;
  const idle = lane.admittedMs === null ? null : { x1: x(lane.admittedMs), x2: x(idleEnd), y1: mid, y2: mid };
  const prefill = lane.segments.filter(s => s.kind === 'prefill').map(s => {
    const x1 = x(s.startMs);
    const w = x(s.endMs) - x1;
    return { x: x1, y: 4, width: Math.max(1, w > 3 ? w - 1 : w), height: LANE_H - 8 };
  });
  // Merge back-to-back decode iterations into continuous bars.
  let decode = '';
  let runStart = -1;
  let runEndX = -1;
  const flush = () => { if (runStart >= 0) decode += `M${runStart.toFixed(2)} 6.5h${Math.max(0.8, runEndX - runStart).toFixed(2)}v7h${(-Math.max(0.8, runEndX - runStart)).toFixed(2)}z`; };
  for (const s of lane.segments) {
    if (s.kind !== 'decode') continue;
    const sx = x(s.startMs);
    const ex = x(s.endMs);
    if (runStart >= 0 && sx - runEndX < 0.5) runEndX = ex;
    else { flush(); runStart = sx; runEndX = ex; }
  }
  flush();
  let ticks = '';
  for (const tm of lane.tokenTimes) ticks += `M${x(tm).toFixed(2)} 15.5v3.5`;
  return {
    arrival,
    queue,
    idle,
    prefill,
    decode,
    ticks,
    done: lane.completedMs === null ? null : x(lane.completedMs) + 5,
    infeasible: lane.infeasibleMs === null ? null : x(lane.infeasibleMs) + 4,
  };
}

function TimelineLegend() {
  return (
    <ul className="legend" aria-label="Timeline legend">
      <li><svg width="22" height="10" aria-hidden="true"><circle cx="4" cy="5" r="2.6" className="lane-arrival" /><line x1="8" x2="22" y1="5" y2="5" className="lane-queue" /></svg>{t.timeline.legendQueue}</li>
      <li><svg width="18" height="10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" className="lane-idle" /></svg>{t.timeline.legendAdmitted}</li>
      <li><svg width="14" height="12" aria-hidden="true"><rect x="0" y="0" width="14" height="12" rx="1" className="lane-prefill" /></svg>{t.timeline.legendPrefill}</li>
      <li><svg width="14" height="12" aria-hidden="true"><rect x="0" y="2.5" width="14" height="7" className="lane-decode" /></svg>{t.timeline.legendDecode}</li>
      <li><svg width="12" height="12" aria-hidden="true"><path d="M3 2v8M8 2v8" className="lane-tick" /></svg>{t.timeline.legendToken}</li>
      <li><svg width="12" height="12" aria-hidden="true"><path d="M2 6 l3 3.5 l5 -7" className="lane-done" /></svg>{t.timeline.legendDone}</li>
      <li><svg width="12" height="12" aria-hidden="true"><path d="M2.5 2.5 l7 7 M9.5 2.5 l-7 7" className="lane-infeasible" /></svg>{t.timeline.legendInfeasible}</li>
    </ul>
  );
}
