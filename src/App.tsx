import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { panelDifferences } from './engine/compare';
import { validateConfig, validateTrace } from './engine/config';
import { DEFAULT_SCENARIO, SCENARIO_IDS, SCENARIOS, scenarioConfig, type ScenarioId } from './engine/scenarios';
import { buildExport, decodeShareParams, digestEvents, encodeShareParams, MAX_IMPORT_BYTES, parseImport } from './engine/serialization';
import { simulateBoth } from './engine/simulator';
import type { SimConfig } from './engine/types';
import { buildTrace } from './engine/workload';
import { t } from './i18n';
import { BatchInspector } from './ui/BatchInspector';
import { Charts } from './ui/Charts';
import { ConfigPanel } from './ui/ConfigPanel';
import { derivePanel, mergeMoments, nextMoment, prevMoment } from './ui/derived';
import { Details } from './ui/Details';
import { Icon } from './ui/icons';
import { MemoryInspector } from './ui/MemoryInspector';
import { Metrics } from './ui/Metrics';
import { ModelPanel } from './ui/ModelPanel';
import { Playback, SPEEDS, type ViewMode } from './ui/Playback';
import { DiffBar, ScenarioBrief } from './ui/ScenarioBrief';
import { Timeline } from './ui/Timeline';

function loadInitial(): { config: SimConfig; warning: string | null } {
  const decoded = decodeShareParams(window.location.search);
  if (decoded.kind === 'scenario' || decoded.kind === 'config') return { config: decoded.config, warning: null };
  return { config: scenarioConfig(DEFAULT_SCENARIO), warning: decoded.kind === 'error' ? t.toast.sharedInvalid(decoded.error) : null };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

export default function App() {
  const [initial] = useState(loadInitial);
  const [config, setConfig] = useState<SimConfig>(initial.config);
  const [basedOn, setBasedOn] = useState<ScenarioId>((initial.config.scenarioId as ScenarioId | null) ?? DEFAULT_SCENARIO);
  const [rate, setRate] = useState<number>(SCENARIOS[basedOn].playbackRate);
  const [view, setView] = useState<ViewMode>('AB');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedReq, setSelectedReq] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(initial.warning);
  const [configOpen, setConfigOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const blockSize = config.memory.blockSizeTokens;
  const results = useMemo(() => simulateBoth(config), [config]);
  const panelData = useMemo(() => ({ A: derivePanel('A', results.A, blockSize), B: derivePanel('B', results.B, blockSize) }), [results, blockSize]);
  const visible = useMemo(() => (view === 'AB' ? [panelData.A, panelData.B] : [panelData[view]]), [view, panelData]);
  const validVisible = visible.filter(p => p.valid);
  const endMs = Math.max(0, ...validVisible.map(p => p.result.endMs));
  const moments = useMemo(() => mergeMoments(visible.filter(p => p.valid).map(p => p.moments)), [visible]);
  const trace = results.A.trace;
  const sharedIssues = useMemo(() => [...validateConfig(config), ...validateTrace(buildTrace(config), config.architecture.maxContextLength)], [config]);
  const diffs = useMemo(() => panelDifferences(config), [config]);

  const cursor = Math.min(time, endMs);
  const countA = panelData.A.replayer?.countAt(cursor) ?? 0;
  const countB = panelData.B.replayer?.countAt(cursor) ?? 0;
  const snapA = useMemo(() => panelData.A.replayer?.snapshotAfter(countA), [panelData.A, countA]);
  const snapB = useMemo(() => panelData.B.replayer?.snapshotAfter(countB), [panelData.B, countB]);
  const snapshots = { A: snapA, B: snapB };

  // Keep the cursor and selection inside the new run after configuration changes.
  useEffect(() => { if (time > endMs) setTime(endMs); }, [endMs, time]);
  useEffect(() => { if (selectedReq !== null && selectedReq >= trace.length) setSelectedReq(null); }, [trace.length, selectedReq]);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 4500); return () => clearTimeout(id); }, [toast]);

  // Keep the address bar shareable.
  useEffect(() => {
    const encoded = encodeShareParams(config);
    const url = new URL(window.location.href);
    url.search = encoded.ok ? encoded.value.toString() : '';
    window.history.replaceState(null, '', url);
  }, [config]);

  // Playback advances modeled time from wall-clock deltas. Simulation results never depend on it.
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - last)); // clamp after hidden tabs or stalls
      last = now;
      const next = timeRef.current + (dt / 1000) * rate;
      if (next >= endMs) { setTime(endMs); setPlaying(false); return; }
      setTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, endMs]);

  const seek = useCallback((ms: number) => { setPlaying(false); setTime(Math.max(0, Math.min(ms, endMs))); }, [endMs]);
  const togglePlay = useCallback(() => {
    if (endMs <= 0) return;
    if (!playing && timeRef.current >= endMs) setTime(0);
    setPlaying(p => !p);
  }, [playing, endMs]);
  const stepNext = useCallback(() => { const n = nextMoment(moments, timeRef.current); if (n !== null) seek(n); }, [moments, seek]);
  const stepPrev = useCallback(() => { const p = prevMoment(moments, timeRef.current); seek(p ?? 0); }, [moments, seek]);

  function chooseScenario(id: ScenarioId) {
    setConfig(scenarioConfig(id));
    setBasedOn(id);
    setRate(SCENARIOS[id].playbackRate);
    setTime(0);
    setPlaying(false);
    setSelectedReq(null);
  }

  function changeRate(direction: 1 | -1) {
    const index = SPEEDS.findIndex(s => s >= rate);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (index === -1 ? SPEEDS.length - 1 : index) + direction))];
    setRate(next);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const onControl = event.target instanceof HTMLElement && ['BUTTON', 'A', 'SUMMARY'].includes(event.target.tagName);
      switch (event.key) {
        case ' ':
          if (onControl) return; // let the focused control handle Space
          event.preventDefault(); togglePlay(); break;
        case 'ArrowRight': event.preventDefault(); stepNext(); break;
        case 'ArrowLeft': event.preventDefault(); stepPrev(); break;
        case 'Home': event.preventDefault(); seek(0); break;
        case 'End': event.preventDefault(); seek(endMs); break;
        case '+': case '=': changeRate(1); break;
        case '-': case '_': changeRate(-1); break;
        case 'Escape':
          if (showShortcuts) setShowShortcuts(false);
          else if (configOpen) setConfigOpen(false);
          else setSelectedReq(null);
          break;
        case '?': setShowShortcuts(s => !s); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function share() {
    const encoded = encodeShareParams(config);
    if (!encoded.ok) { setToast(encoded.error); return; }
    const url = new URL(window.location.href);
    url.search = encoded.value.toString();
    try {
      await navigator.clipboard.writeText(url.toString());
      setToast(t.toast.linkCopied);
    } catch {
      setToast(t.toast.clipboardUnavailable);
    }
  }

  function exportJson() {
    const doc = buildExport(config, results);
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inference-lab-${config.scenarioId ?? 'custom'}-seed${config.seed}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast(t.toast.exported);
  }

  async function importFile(file: File) {
    if (file.size > MAX_IMPORT_BYTES) { setToast('The file is larger than 8 MiB.'); return; }
    const text = await file.text();
    const parsed = parseImport(text);
    if (!parsed.ok) { setToast(`Import failed: ${parsed.error}`); return; }
    const next = parsed.value.config;
    const replay = simulateBoth(next);
    const mismatch = (['A', 'B'] as const).some(p => parsed.value.digests[p] !== undefined && parsed.value.digests[p] !== digestEvents(replay[p].events));
    setConfig(next);
    if (next.scenarioId) setBasedOn(next.scenarioId as ScenarioId);
    setTime(0);
    setPlaying(false);
    setSelectedReq(null);
    setToast(mismatch ? t.toast.importMismatch : t.toast.imported);
  }

  const selectReq = useCallback((req: number) => setSelectedReq(prev => (prev === req ? null : req)), []);

  return (
    <div className="app">
      <a className="skip-link" href="#main">{t.app.skip}</a>
      <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="logo">
            <rect x="2" y="15" width="6" height="9" rx="1.5" /><rect x="10" y="9" width="6" height="15" rx="1.5" /><rect x="18" y="3" width="6" height="21" rx="1.5" />
          </svg>
          <div>
            <h1>{t.app.name}</h1>
            <p className="tagline">{t.app.tagline}</p>
          </div>
        </div>
        <div className="topbar-controls">
          <label className="scenario-select">
            <span className="sr-only">{t.scenario.label}</span>
            <select value={config.scenarioId ?? ''} onChange={e => e.target.value && chooseScenario(e.target.value as ScenarioId)} aria-label={t.scenario.label}>
              {config.scenarioId === null && <option value="">{t.scenario.custom}</option>}
              {SCENARIO_IDS.map(id => <option key={id} value={id}>{t.scenarios[id].title}</option>)}
            </select>
          </label>
          <button className="button config-toggle" onClick={() => setConfigOpen(true)} aria-expanded={configOpen} aria-controls="config-sidebar" aria-label={t.actions.config}><Icon.sliders /><span>{t.actions.config}</span></button>
          <button className="button" onClick={share} title={t.actions.share} aria-label={t.actions.share}><Icon.share /><span>{t.actions.share}</span></button>
          <button className="button" onClick={exportJson} title={t.actions.exportJson} aria-label={t.actions.exportJson}><Icon.download /><span>{t.actions.exportJson}</span></button>
          <button className="button" onClick={() => fileInput.current?.click()} title={t.actions.importJson} aria-label={t.actions.importJson}><Icon.upload /><span>{t.actions.importJson}</span></button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} data-testid="import-input" />
          <button className="icon-button" onClick={() => setShowShortcuts(true)} aria-label={t.actions.shortcuts} title={`${t.actions.shortcuts} (?)`}><Icon.keyboard /></button>
        </div>
      </header>

      <div className="layout">
        <aside id="config-sidebar" className={`sidebar ${configOpen ? 'is-open' : ''}`} aria-label={t.config.title}>
          <div className="sidebar-head">
            <h2>{t.config.title}</h2>
            <div className="sidebar-actions">
              <button className="button small-button" onClick={() => chooseScenario(basedOn)} disabled={config.scenarioId !== null} title={t.actions.resetScenario}>{t.actions.resetScenario}</button>
              <button className="icon-button sidebar-close" onClick={() => setConfigOpen(false)} aria-label={t.actions.closeConfig}><Icon.close /></button>
            </div>
          </div>
          <ConfigPanel config={config} onChange={next => { setConfig(next); }} />
          <p className="sidebar-foot small muted">{t.app.local}</p>
        </aside>
        {configOpen && <button className="scrim" aria-label={t.actions.closeConfig} onClick={() => setConfigOpen(false)} />}

        <main id="main" tabIndex={-1}>
          <ScenarioBrief scenarioId={config.scenarioId as ScenarioId | null} basedOn={basedOn} />
          {sharedIssues.length > 0 && (
            <div className="issue-banner" role="alert">
              <strong>Configuration not runnable.</strong>
              <ul>{sharedIssues.slice(0, 4).map((issue, i) => <li key={i}>{issue.message}</li>)}</ul>
            </div>
          )}
          <div className="sticky-controls">
            <Playback
              time={cursor}
              endMs={endMs}
              playing={playing}
              rate={rate}
              view={view}
              canPrev={cursor > 0}
              canNext={nextMoment(moments, cursor) !== null}
              onToggle={togglePlay}
              onPrev={stepPrev}
              onNext={stepNext}
              onReset={() => seek(0)}
              onEnd={() => seek(endMs)}
              onSeek={seek}
              onRate={setRate}
              onView={setView}
            />
          </div>
          {view === 'AB' && <DiffBar diffs={diffs} />}
          <Timeline panels={visible} trace={trace} endMs={endMs} time={cursor} playing={playing} selectedReq={selectedReq} onSelectReq={selectReq} onSeek={seek} />
          <div className={`panel-columns cols-${validVisible.length}`}>
            {validVisible.map(panel => {
              const snapshot = snapshots[panel.id]!;
              return (
                <div key={panel.id} className="panel-column">
                  <BatchInspector panel={panel} snapshot={snapshot} selectedReq={selectedReq} onSelectReq={selectReq} onSeek={seek} />
                  <MemoryInspector panel={panel} snapshot={snapshot} config={config} selectedReq={selectedReq} onSelectReq={selectReq} />
                </div>
              );
            })}
          </div>
          {validVisible.length > 0 && (
            <Details panels={visible} snapshots={snapshots} time={cursor} slo={config.slo} selectedReq={selectedReq} onClearReq={() => setSelectedReq(null)} onSelectReq={selectReq} onSeek={seek} />
          )}
          <Metrics panels={visible} time={cursor} slo={config.slo} selectedReq={selectedReq} onSelectReq={selectReq} />
          <Charts panels={visible} endMs={endMs} time={cursor} />
          <ModelPanel config={config} />
          <footer className="footer small muted">
            <span>{t.app.educational}</span>
            <span>{t.app.local}</span>
          </footer>
        </main>
      </div>

      <div className="toast-region" aria-live="polite">{toast && <div className="toast" role="status">{toast}</div>}</div>

      {showShortcuts && (
        <div className="dialog-backdrop" onClick={() => setShowShortcuts(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={e => e.stopPropagation()}>
            <div className="card-head compact">
              <h2 id="shortcuts-title">{t.shortcuts.title}</h2>
              <button className="icon-button" onClick={() => setShowShortcuts(false)} aria-label="Close" autoFocus><Icon.close /></button>
            </div>
            <table className="shortcut-table">
              <tbody>{t.shortcuts.rows.map(([key, action]) => <tr key={key}><th scope="row"><kbd>{key}</kbd></th><td>{action}</td></tr>)}</tbody>
            </table>
            <p className="small muted">{t.shortcuts.note}</p>
          </div>
        </div>
      )}
    </div>
  );
}
