import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Comparison, type Playhead, buildComparison, panelApplied, seekStep, seekTime, startPlayhead } from '../sim/compare.ts';
import { type Issue, PANEL_IDS, type PanelId, type SimConfig, parseConfig } from '../sim/config.ts';
import { stateAt } from '../sim/engine.ts';
import { DEFAULT_SCENARIO, SCENARIO_IDS, type ScenarioId, scenario } from '../sim/scenarios.ts';
import { MAX_IMPORT_BYTES, decodeShare, encodeShare, exportRun, importText } from '../sim/serialize.ts';
import { ConfigPanel, ScenarioPanel } from './ConfigPanel.tsx';
import { DetailsPanel, EventLog, type Selection } from './Details.tsx';
import { BatchInspector, MemoryInspector } from './Inspectors.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { PlaybackBar } from './PlaybackBar.tsx';
import { Results } from './Results.tsx';
import { S, issueText } from './strings.ts';
import { Legend, type TimeRange, Timeline } from './Timeline.tsx';

type Notice = { tone: 'info' | 'error'; text: string; details?: string[] };

interface Loaded {
  config: SimConfig;
  cmp: Comparison;
  scenarioId: ScenarioId | null;
  speed: number;
  notice: Notice | null;
}

function mustBuild(config: SimConfig): Comparison {
  const built = buildComparison(config);
  if (!built.ok) throw new Error(`preset failed validation: ${built.error.map(issueText).join('; ')}`);
  return built.value;
}

function fromScenario(id: ScenarioId, notice: Notice | null = null): Loaded {
  const s = scenario(id);
  return { config: s.config, cmp: mustBuild(s.config), scenarioId: id, speed: s.playbackMsPerSec, notice };
}

/** Reads `#c=<config>` or `#scenario=<id>`. A bad link falls back to the default scenario with a notice. */
function loadFromHash(hash: string): Loaded {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const preset = params.get('scenario');
  if (preset && (SCENARIO_IDS as readonly string[]).includes(preset)) return fromScenario(preset as ScenarioId);
  const encoded = params.get('c');
  if (!encoded) return fromScenario(DEFAULT_SCENARIO);
  const decoded = decodeShare(encoded);
  const built = decoded.ok ? buildComparison(decoded.value) : decoded;
  if (!decoded.ok || !built.ok) {
    const issues = !decoded.ok ? decoded.error : !built.ok ? built.error : [];
    return fromScenario(DEFAULT_SCENARIO, { tone: 'error', text: S.app.shareInvalid, details: issues.slice(0, 6).map(issueText) });
  }
  return { config: decoded.value, cmp: built.value, scenarioId: null, speed: 100, notice: null };
}

function windowRange(cmp: Comparison, t: number, windowMs: number | null): TimeRange {
  if (windowMs === null) return { t0: 0, t1: Math.max(1, cmp.endUs) };
  const w = windowMs * 1000;
  let t0 = Math.max(0, t - 0.75 * w);
  let t1 = t0 + w;
  if (t1 > cmp.endUs) {
    t1 = Math.max(cmp.endUs, w);
    t0 = Math.max(0, t1 - w);
  }
  return { t0, t1 };
}

function useNarrow() {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function App() {
  const initial = useMemo(() => loadFromHash(location.hash), []);
  const [draft, setDraft] = useState(initial.config);
  const [cmp, setCmp] = useState(initial.cmp);
  const [scenarioId, setScenarioId] = useState(initial.scenarioId);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [notice, setNotice] = useState<Notice | null>(initial.notice);
  const [at, setAt] = useState<Playhead>(() => startPlayhead(initial.cmp));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(initial.speed);
  const [windowMs, setWindowMs] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [mobilePanel, setMobilePanel] = useState<PanelId>('A');
  const narrow = useNarrow();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const atRef = useRef(at);
  atRef.current = at;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const adopt = useCallback((next: Comparison, opts: { scenarioId: ScenarioId | null; reset: boolean }) => {
    setCmp(next);
    setDraft(next.config);
    setIssues([]);
    setScenarioId(opts.scenarioId);
    setAt(opts.reset ? startPlayhead(next) : seekTime(next, atRef.current.timeUs));
    setSelection(s => {
      if (s?.kind === 'request' && s.request >= next.trace.length) return null;
      if (s?.kind === 'iteration' && s.iteration >= next.panels[s.panel].iterations.length) return null;
      return opts.reset ? null : s;
    });
  }, []);

  const editConfig = useCallback(
    (next: SimConfig) => {
      setDraft(next);
      const parsed = parseConfig(next);
      const built = parsed.ok ? buildComparison(parsed.value) : parsed;
      if (!built.ok) {
        setIssues(built.error);
        return;
      }
      adopt(built.value, { scenarioId: null, reset: false });
    },
    [adopt],
  );

  const pickScenario = useCallback(
    (id: ScenarioId) => {
      const s = fromScenario(id);
      setPlaying(false);
      setSpeed(s.speed);
      adopt(s.cmp, { scenarioId: id, reset: true });
      history.replaceState(null, '', `${location.pathname}${location.search}#scenario=${id}`);
    },
    [adopt],
  );

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dtMs = Math.min(100, now - last);
      last = now;
      const t = atRef.current.timeUs + dtMs * speedRef.current;
      if (t >= cmp.endUs) {
        setAt(seekTime(cmp, cmp.endUs));
        setPlaying(false);
        return;
      }
      setAt(seekTime(cmp, t));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, cmp]);

  const total = cmp.steps.timeUs.length;
  const toggle = useCallback(() => {
    setPlaying(p => {
      if (!p && atRef.current.timeUs >= cmp.endUs) setAt(startPlayhead(cmp));
      return !p;
    });
  }, [cmp]);
  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setAt(prev => seekStep(cmp, prev.applied + delta));
    },
    [cmp],
  );
  const reset = useCallback(() => {
    setPlaying(false);
    setAt(startPlayhead(cmp));
  }, [cmp]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"], dialog[open]')) return;
      if (e.key === ' ' && target?.closest('button, a, summary')) return;
      if (e.key === ' ') toggle();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'Home') reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step, reset]);

  const states = { A: stateAt(cmp.panels.A, panelApplied(cmp, at, 'A')), B: stateAt(cmp.panels.B, panelApplied(cmp, at, 'B')) };
  const range = windowRange(cmp, at.timeUs, windowMs);
  const selectRequest = (request: number) => setSelection({ kind: 'request', request });
  const selectIteration = (panel: PanelId) => (iteration: number) => setSelection({ kind: 'iteration', panel, iteration });

  const share = async () => {
    const encoded = encodeShare(cmp.config);
    if (!encoded.ok) {
      setNotice({ tone: 'error', text: issueText(encoded.error) });
      return;
    }
    const url = `${location.origin}${location.pathname}${location.search}#c=${encoded.value}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ tone: 'info', text: S.app.shareCopied });
    } catch {
      setNotice({ tone: 'info', text: S.app.shareUpdated });
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(exportRun(cmp), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inference-lab-${scenarioId ?? 'custom'}-seed${cmp.config.seed}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice({ tone: 'info', text: S.app.exported });
  };

  const importFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setNotice({ tone: 'error', text: S.app.importFailed, details: [issueText({ path: 'import', code: 'tooLarge', params: { length: file.size, max: MAX_IMPORT_BYTES } })] });
      return;
    }
    const result = importText(await file.text());
    if (!result.ok) {
      setNotice({ tone: 'error', text: S.app.importFailed, details: result.error.slice(0, 8).map(issueText) });
      return;
    }
    setPlaying(false);
    adopt(result.value.comparison, { scenarioId: null, reset: true });
    setNotice({ tone: 'info', text: S.app.importOk(result.value.history) });
  };

  return (
    <>
      <header className="header">
        <div className="brand">
          <h1>{S.app.title}</h1>
          <span className="tag">{S.app.tagline}</span>
        </div>
        <span className="disclaimer">{S.app.disclaimer}</span>
        <div className="actions">
          <button type="button" className="btn" onClick={() => dialogRef.current?.showModal()} data-testid="open-model">
            {S.app.modelButton}
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="import">
            {S.app.importButton}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            data-testid="import-file"
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <button type="button" className="btn" onClick={exportJson} data-testid="export">
            {S.app.exportButton}
          </button>
          <button type="button" className="btn" onClick={() => void share()} data-testid="share">
            {S.app.shareButton}
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice${notice.tone === 'error' ? ' error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="notice">
          <div>
            <p>{notice.text}</p>
            {notice.details && (
              <ul>
                {notice.details.map(d => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="btn ghost" onClick={() => setNotice(null)}>
            {S.app.dismiss}
          </button>
        </div>
      )}
      {issues.length > 0 && (
        <div className="notice error" role="alert" data-testid="config-issues">
          <div>
            <p>{S.app.invalidConfig}</p>
            <ul>
              {issues.slice(0, 8).map(i => (
                <li key={`${i.path}-${i.code}`}>{issueText(i)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <ScenarioPanel active={scenarioId} onPick={pickScenario} />
          <ConfigPanel config={draft} onChange={editConfig} compact={narrow} />
        </aside>
        <main className="main">
          <PlaybackBar
            cmp={cmp}
            at={at}
            playing={playing}
            speed={speed}
            windowMs={windowMs}
            onToggle={toggle}
            onStep={step}
            onReset={reset}
            onSeekTime={t => {
              setPlaying(false);
              setAt(seekTime(cmp, t));
            }}
            onSpeed={setSpeed}
            onWindow={setWindowMs}
          />
          {PANEL_IDS.map(panel => (
            <Timeline
              key={panel}
              cmp={cmp}
              panel={panel}
              state={states[panel]}
              at={at}
              range={range}
              selectedRequest={selection?.kind === 'request' ? selection.request : null}
              selectedIteration={selection?.kind === 'iteration' && selection.panel === panel ? selection.iteration : null}
              onSelectRequest={selectRequest}
              onSelectIteration={selectIteration(panel)}
            />
          ))}
          <div className="card">
            <Legend />
          </div>

          <div className="segmented" role="group" aria-label="Inspector panel">
            {PANEL_IDS.map(p => (
              <button key={p} type="button" aria-pressed={mobilePanel === p} onClick={() => setMobilePanel(p)} data-testid={`show-${p}`}>
                {S.panel(p)}
              </button>
            ))}
          </div>
          <div className="inspectors" data-show={mobilePanel}>
            {PANEL_IDS.map(panel => (
              <div key={panel} className="inspector-col" data-panel={panel}>
                <BatchInspector cmp={cmp} panel={panel} state={states[panel]} onSelectRequest={selectRequest} onSelectIteration={selectIteration(panel)} />
                <MemoryInspector cmp={cmp} panel={panel} state={states[panel]} onSelectRequest={selectRequest} />
              </div>
            ))}
          </div>

          <div className="bottom">
            <DetailsPanel cmp={cmp} at={at} states={states} selection={selection} onSelect={setSelection} />
            <EventLog
              cmp={cmp}
              at={at}
              onSeekStep={k => {
                setPlaying(false);
                setAt(seekStep(cmp, k));
              }}
            />
          </div>
          <Results cmp={cmp} selected={selection?.kind === 'request' ? selection.request : null} onSelectRequest={selectRequest} />
          <p className="muted small" data-testid="totals">
            {S.playback.event(at.applied, total)}
          </p>
        </main>
      </div>
      <ModelDialog ref={dialogRef} cost={cmp.config.cost} />
    </>
  );
}
