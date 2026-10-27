import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Comparison, Playhead } from '../sim/compare.ts';
import type { PanelId, SchedulerLimits } from '../sim/config.ts';
import type { PanelRun, RequestHistory } from '../sim/engine.ts';
import { usedBy } from '../sim/scheduler.ts';
import type { RequestState, SimState } from '../sim/state.ts';
import { S } from './strings.ts';

const LABEL_W = 92;
const ROW_H = 22;
const STRIP_H = 54;
const ROWS_MAX_H = 300;

export interface TimeRange {
  t0: number;
  t1: number;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function lowerBound(n: number, valueAt: (i: number) => number, target: number) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (valueAt(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function niceStep(spanUs: number, maxTicks: number) {
  const raw = spanUs / Math.max(1, maxTicks);
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return ([1, 2, 5, 10].find(m => m * pow >= raw) ?? 10) * pow;
}

export function overrideText(cmp: Comparison, panel: PanelId): string[] {
  const { policy, overrides: o } = cmp.config.panels[panel];
  const labels: Record<keyof SchedulerLimits, string> = { maxActiveSequences: S.config.maxActive, maxBatchTokens: S.config.maxBatch, maxPrefillChunkTokens: S.config.maxChunk };
  return (Object.keys(o) as (keyof SchedulerLimits)[])
    .filter(k => usedBy(policy, k) && o[k] !== undefined && o[k] !== cmp.config.scheduler[k])
    .map(k => `${labels[k]} ${o[k]} (shared ${cmp.config.scheduler[k]})`);
}

export function PanelHeading({ cmp, panel, children }: { cmp: Comparison; panel: PanelId; children?: ReactNode }) {
  const run = cmp.panels[panel];
  const overrides = overrideText(cmp, panel);
  return (
    <div className="card-head">
      <span className={`panel-tag ${panel.toLowerCase()}`}>{panel}</span>
      <span className="policy-name">{S.policy[run.policy].name}</span>
      {overrides.map(t => (
        <span key={t} className="override" data-testid={`override-note-${panel}`}>
          {t}
        </span>
      ))}
      {children}
    </div>
  );
}

interface Props {
  cmp: Comparison;
  panel: PanelId;
  state: Readonly<SimState>;
  at: Playhead;
  range: TimeRange;
  selectedRequest: number | null;
  selectedIteration: number | null;
  onSelectRequest: (request: number) => void;
  onSelectIteration: (iteration: number) => void;
}

export function Timeline({ cmp, panel, state, at, range, selectedRequest, selectedIteration, onSelectRequest, onSelectIteration }: Props) {
  const run = cmp.panels[panel];
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const plotW = Math.max(40, width - LABEL_W - 8);
  const span = Math.max(1, range.t1 - range.t0);
  const X = (t: number) => ((t - range.t0) / span) * plotW;
  const T = at.timeUs;
  const n = run.trace.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 2);
  const last = Math.min(n, first + Math.ceil(ROWS_MAX_H / ROW_H) + 4);
  const rows = Array.from({ length: last - first }, (_, k) => first + k);

  return (
    <section className="card" aria-label={`${S.panel(panel)} ${S.timeline.heading}`} data-testid={`timeline-${panel}`}>
      <PanelHeading cmp={cmp} panel={panel}>
        <span className="spacer muted small">{S.timeline.heading}</span>
      </PanelHeading>
      <div className="timeline-wrap" ref={wrapRef}>
        <IterationStrip run={run} state={state} X={X} T={T} range={range} plotW={plotW} width={width} selected={selectedIteration} onSelect={onSelectIteration} />
        <div className="tl-rows" style={{ maxHeight: ROWS_MAX_H }} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} tabIndex={-1}>
          <div className="tl-rows-inner" style={{ height: n * ROW_H }}>
            {rows.map(i => {
              const r = state.requests[i]!;
              const id = run.trace[i]!.id;
              return (
                <button
                  key={i}
                  type="button"
                  className="tl-row-label"
                  style={{ top: i * ROW_H }}
                  aria-pressed={selectedRequest === i}
                  aria-label={S.timeline.rowLabel(id, S.phase[r.phase])}
                  title={`${id} · ${S.phase[r.phase]}`}
                  onClick={() => onSelectRequest(i)}
                  data-testid={`row-${panel}-${id}`}
                >
                  <PhaseGlyph phase={r.phase} />
                  {id}
                </button>
              );
            })}
            <svg className="tl-svg" width={plotW} height={(last - first) * ROW_H} style={{ top: first * ROW_H }} aria-hidden="true">
              {rows.map((i, k) => (
                <g key={i} transform={`translate(0 ${k * ROW_H})`} onClick={() => onSelectRequest(i)} style={{ cursor: 'pointer' }}>
                  <rect width={plotW} height={ROW_H} fill={selectedRequest === i ? 'var(--raised)' : k % 2 ? 'transparent' : 'rgba(255,255,255,0.015)'} />
                  <RowMarks run={run} h={run.histories[i]!} r={state.requests[i]!} started={state.iterationsStarted} X={X} T={T} range={range} plotW={plotW} />
                </g>
              ))}
              {T >= range.t0 && T <= range.t1 && <line x1={X(T)} x2={X(T)} y1={0} y2={(last - first) * ROW_H} stroke="var(--accent)" strokeWidth={1.5} />}
            </svg>
          </div>
        </div>
        <p className="outcome-line">
          {state.ended ? S.outcome(state.ended) : `${S.phase.waiting}: ${state.requests.filter(r => r.phase === 'waiting').length} · ${S.phase.decoding}: ${state.requests.filter(r => r.phase === 'decoding').length} · ${S.phase.completed}: ${state.completedCount}`}
        </p>
      </div>
    </section>
  );
}

function IterationStrip({
  run, state, X, T, range, plotW, width, selected, onSelect,
}: { run: PanelRun; state: Readonly<SimState>; X: (t: number) => number; T: number; range: TimeRange; plotW: number; width: number; selected: number | null; onSelect: (i: number) => void }) {
  const its = run.iterations;
  const startedLimit = state.iterationsStarted;
  const from = Math.max(0, lowerBound(its.length, i => its[i]!.endUs, range.t0));
  const to = Math.min(startedLimit, lowerBound(its.length, i => its[i]!.startUs, range.t1 + 1));
  const step = niceStep(range.t1 - range.t0, Math.max(2, Math.floor(plotW / 90)));
  const ticks: number[] = [];
  for (let t = Math.ceil(range.t0 / step) * step; t <= range.t1; t += step) ticks.push(t);
  const pick = (clientX: number, rect: DOMRect) => {
    const t = range.t0 + ((clientX - rect.left - LABEL_W) / plotW) * (range.t1 - range.t0);
    const i = lowerBound(Math.min(startedLimit, its.length), k => its[k]!.endUs, t);
    if (i < startedLimit && its[i] && its[i]!.startUs <= t) onSelect(i);
  };
  const bars: ReactNode[] = [];
  for (let i = from; i < to; i++) {
    const it = its[i]!;
    const x0 = X(Math.max(it.startUs, range.t0));
    const x1 = X(Math.min(it.endUs, T, range.t1));
    const w = Math.max(1, x1 - x0);
    const total = it.prefillTokens + it.decodeTokens;
    const prefillH = total === 0 ? 0 : (28 * it.prefillTokens) / total;
    const executing = state.executing === i;
    bars.push(
      <g key={i}>
        <rect x={x0} y={4} width={w} height={prefillH} fill="var(--state-prefill)" />
        <rect x={x0} y={4 + prefillH} width={w} height={28 - prefillH} fill="var(--state-decode)" />
        {w > 3 && <line x1={x0 + w} x2={x0 + w} y1={4} y2={32} stroke="var(--panel)" strokeWidth={1} />}
        {(executing || selected === i) && (
          <rect x={x0 - 1} y={3} width={w + 2} height={30} fill="none" stroke={selected === i ? 'var(--text)' : 'var(--accent)'} strokeWidth={executing && selected !== i ? 1.5 : 2} />
        )}
      </g>,
    );
  }
  const current = startedLimit > 0 ? startedLimit - 1 : null;
  return (
    <svg
      className="tl-strip"
      width={width}
      height={STRIP_H}
      role="img"
      aria-label={S.timeline.iterations}
      onClick={e => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
    >
      <text x={8} y={22}>
        {S.timeline.iterations}
      </text>
      {current !== null && (
        <text x={8} y={34} className="mono">
          {S.timeline.current(current)}
        </text>
      )}
      <text x={8} y={48}>
        {S.timeline.axis}
      </text>
      <g transform={`translate(${LABEL_W} 0)`}>
        {bars}
        {ticks.map(t => (
          <g key={t} transform={`translate(${X(t)} 0)`}>
            <line y1={34} y2={38} stroke="var(--control)" />
            <text y={48} textAnchor={X(t) < 12 ? 'start' : 'middle'}>
              {(t / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}
            </text>
          </g>
        ))}
        {T >= range.t0 && T <= range.t1 && <line x1={X(T)} x2={X(T)} y1={0} y2={STRIP_H} stroke="var(--accent)" strokeWidth={1.5} />}
      </g>
    </svg>
  );
}

function RowMarks({ run, h, r, started, X, T, range, plotW }: { run: PanelRun; h: RequestHistory; r: Readonly<RequestState>; started: number; X: (t: number) => number; T: number; range: TimeRange; plotW: number }) {
  const mid = ROW_H / 2;
  if (r.phase === 'pending') return null;
  const right = Math.min(T, range.t1);
  const seg = (a: number, b: number) => {
    const lo = Math.max(a, range.t0);
    const hi = Math.min(b, right);
    return hi < lo ? null : { x: X(lo), w: Math.max(0, X(hi) - X(lo)) };
  };
  const out: ReactNode[] = [];
  if (r.phase === 'infeasible') {
    const x = X(h.arrivalUs);
    if (h.arrivalUs >= range.t0 && h.arrivalUs <= range.t1) {
      out.push(<path key="x" d={`M${x - 4} ${mid - 4}l8 8m0 -8l-8 8`} stroke="var(--state-error)" strokeWidth={2} />);
      out.push(
        <text key="xt" x={x + 8} y={mid + 4} fill="var(--state-error)" fontSize={11}>
          {S.phase.infeasible}
        </text>,
      );
    }
    return <>{out}</>;
  }
  const admitted = r.phase !== 'waiting';
  const waiting = seg(h.arrivalUs, admitted ? h.admittedUs! : Infinity);
  if (waiting) out.push(<rect key="w" x={waiting.x} y={mid - 5} width={Math.max(waiting.w, 1)} height={10} fill="none" stroke="var(--state-waiting)" strokeDasharray="3 2" />);
  const firstToken = r.generatedTokens > 0 ? h.tokenTimesUs[0]! : Infinity;
  if (admitted) {
    const adm = seg(h.admittedUs!, firstToken);
    if (adm) out.push(<rect key="a" x={adm.x} y={mid - 3} width={Math.max(adm.w, 1)} height={6} fill="none" stroke="var(--state-admitted)" />);
  }
  for (const c of h.prefills) {
    if (c.iteration >= started) break;
    const it = run.iterations[c.iteration]!;
    const s = seg(it.startUs, it.endUs);
    if (s) out.push(<rect key={`p${c.iteration}`} x={s.x} y={mid - 8} width={Math.max(s.w, 2)} height={16} fill="var(--state-prefill)" rx={1} />);
  }
  const decodes = h.decodeIterations;
  const decodesStarted = lowerBound(decodes.length, k => decodes[k]!, started);
  if (decodesStarted > 0) {
    const lastDecode = run.iterations[decodes[decodesStarted - 1]!]!;
    const line = seg(firstToken, lastDecode.endUs);
    const from = lowerBound(decodesStarted, k => run.iterations[decodes[k]!]!.endUs, range.t0);
    const to = Math.min(decodesStarted, lowerBound(decodesStarted, k => run.iterations[decodes[k]!]!.startUs, right + 1));
    const dense = (to - from) * 3 > plotW;
    if (line) out.push(<rect key="dl" x={line.x} y={mid - (dense ? 3 : 1)} width={line.w} height={dense ? 6 : 2} fill="var(--state-decode)" />);
    if (!dense) {
      for (let k = from; k < to; k++) {
        const it = run.iterations[decodes[k]!]!;
        const s = seg(it.startUs, it.endUs);
        if (s) out.push(<rect key={`d${k}`} x={s.x} y={mid - 4} width={Math.max(s.w - 1, 1)} height={8} fill="var(--state-decode)" />);
      }
    }
  }
  const tFrom = lowerBound(h.tokenTimesUs.length, k => h.tokenTimesUs[k]!, range.t0);
  const tTo = Math.min(r.generatedTokens, lowerBound(h.tokenTimesUs.length, k => h.tokenTimesUs[k]!, right + 1));
  const sparse = (tTo - tFrom) * 9 <= plotW;
  for (let k = tFrom; k < tTo; k++) {
    if (!sparse && k !== 0) continue;
    const x = X(h.tokenTimesUs[k]!);
    out.push(<path key={`t${k}`} d={`M${x} ${mid - 4}l3 4l-3 4l-3 -4z`} fill="var(--text)" />);
  }
  if (r.phase === 'completed' && h.releasedUs !== null && h.releasedUs >= range.t0 && h.releasedUs <= range.t1) {
    const x = X(h.releasedUs);
    out.push(<rect key="c" x={x} y={mid - 5} width={3} height={10} fill="var(--state-decode)" />);
    out.push(<path key="ck" d={`M${x + 6} ${mid}l2.5 3l5 -6`} stroke="var(--state-decode)" strokeWidth={1.6} fill="none" />);
  }
  return <>{out}</>;
}

export function PhaseGlyph({ phase }: { phase: RequestState['phase'] }) {
  const common = { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true } as const;
  switch (phase) {
    case 'waiting':
      return <svg {...common}><rect x={1} y={2} width={8} height={6} fill="none" stroke="var(--state-waiting)" strokeDasharray="2 1.5" /></svg>;
    case 'admitted':
      return <svg {...common}><rect x={1} y={3} width={8} height={4} fill="none" stroke="var(--state-admitted)" /></svg>;
    case 'prefilling':
      return <svg {...common}><rect x={2} y={0} width={6} height={10} fill="var(--state-prefill)" /></svg>;
    case 'decoding':
    case 'awaitingRelease':
      return <svg {...common}><rect x={0} y={4} width={10} height={2} fill="var(--state-decode)" /><rect x={4} y={2} width={2} height={6} fill="var(--state-decode)" /></svg>;
    case 'completed':
      return <svg {...common}><path d="M1 5l3 3l5 -6" stroke="var(--state-decode)" strokeWidth={1.6} fill="none" /></svg>;
    case 'infeasible':
      return <svg {...common}><path d="M1 1l8 8m0 -8l-8 8" stroke="var(--state-error)" strokeWidth={1.6} /></svg>;
    case 'pending':
      return <svg {...common}><circle cx={5} cy={5} r={2} fill="var(--control)" /></svg>;
  }
}

export function Legend() {
  const L = S.timeline.legend;
  const item = (label: string, shape: ReactNode) => (
    <span>
      <svg viewBox="0 0 22 12" aria-hidden="true">{shape}</svg>
      {label}
    </span>
  );
  return (
    <div className="legend" aria-label="Legend">
      {item(L.waiting, <rect x={1} y={1} width={20} height={10} fill="none" stroke="var(--state-waiting)" strokeDasharray="3 2" />)}
      {item(L.admitted, <rect x={1} y={3} width={20} height={6} fill="none" stroke="var(--state-admitted)" />)}
      {item(L.prefill, <rect x={4} y={0} width={14} height={12} fill="var(--state-prefill)" />)}
      {item(L.decode, <><rect x={0} y={5} width={22} height={2} fill="var(--state-decode)" /><rect x={6} y={2} width={4} height={8} fill="var(--state-decode)" /><rect x={13} y={2} width={4} height={8} fill="var(--state-decode)" /></>)}
      {item(L.token, <path d="M11 2l3 4l-3 4l-3 -4z" fill="var(--text)" />)}
      {item(L.completed, <><rect x={4} y={1} width={3} height={10} fill="var(--state-decode)" /><path d="M10 6l2.5 3l5 -6" stroke="var(--state-decode)" strokeWidth={1.6} fill="none" /></>)}
      {item(L.infeasible, <path d="M7 2l8 8m0 -8l-8 8" stroke="var(--state-error)" strokeWidth={2} />)}
    </div>
  );
}
