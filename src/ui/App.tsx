import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Comparison, type Playhead, buildComparison, panelApplied, seekStep, seekTime, startPlayhead } from '../sim/compare.ts';
import { type Issue, PANEL_IDS, type PanelId, type SimConfig, parseConfig } from '../sim/config.ts';
import { stateAt } from '../sim/engine.ts';
import { DEFAULT_SCENARIO, SCENARIO_IDS, type ScenarioId, scenario } from '../sim/scenarios.ts';
import { MAX_IMPORT_BYTES, decodeShare, encodeShare, exportRun, importText } from '../sim/serialize.ts';
import { ConfigPanel, ScenarioPanel } from './ConfigPanel.tsx';
import { DetailsPanel, EventLog, type Selection } from './Details.tsx';
import { HeaderIcon, type HeaderIconName } from './HeaderIcon.tsx';
import { Differences } from './Differences.tsx';
import { BatchInspector, MemoryInspector } from './Inspectors.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { OverTime } from './OverTime.tsx';
import { PlaybackBar, speedOptions } from './PlaybackBar.tsx';
import { Results } from './Results.tsx';
import { type Command, SHORTCUTS, ShortcutsDialog } from './Shortcuts.tsx';
import { S, issueText } from './strings.ts';
import { Legend, type TimeRange, Timeline } from './Timeline.tsx';

type Notice = { tone: 'info' | 'error'; text: string; issues?: Issue[] };

interface Loaded {
  config: SimConfig;
  cmp: Comparison;
  scenarioId: ScenarioId | null;
  speed: number;
  notice: Notice | null;
}

function mustBuild(config: SimConfig): Comparison {
  const built = buildComparison(config);
  if (!built.ok) throw new Error(`preset failed validation: ${built.error.map(i => `${i.path} ${i.code}`).join('; ')}`);
  return built.value;
}

function fromScenario(id: ScenarioId, notice: Notice | null = null): Loaded {
  const s = scenario(id);
  return { config: s.config, cmp: mustBuild(s.config), scenarioId: id, speed: s.playbackMsPerSec, notice };
}

function syncHash(config: SimConfig) {
  const encoded = encodeShare(config);
  history.replaceState(null, '', `${location.pathname}${location.search}${encoded.ok ? `#c=${encoded.value}` : ''}`);
}

type LinkSource =
  | { kind: 'none' }
  | { kind: 'scenario'; id: ScenarioId }
  | { kind: 'shared'; encoded: string }
  | { kind: 'earlierVersion' };

interface LinkLoad extends Loaded {
  address: string | null;
}

const isScenarioId = (s: string | null): s is ScenarioId => s !== null && (SCENARIO_IDS as readonly string[]).includes(s);

function fragmentSource(hash: string): LinkSource {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const preset = params.get('scenario');
  if (isScenarioId(preset)) return { kind: 'scenario', id: preset };
  const encoded = params.get('c');
  return encoded ? { kind: 'shared', encoded } : { kind: 'none' };
}

function querySource(search: string): LinkSource {
  const params = new URLSearchParams(search);
  const preset = params.get('scenario');
  if (params.has('cfg') || (preset !== null && !isScenarioId(preset))) return { kind: 'earlierVersion' };
  return isScenarioId(preset) ? { kind: 'scenario', id: preset } : { kind: 'none' };
}

function fromSource(source: LinkSource): { loaded: Loaded; hash: string | null } {
  switch (source.kind) {
    case 'none':
      return { loaded: fromScenario(DEFAULT_SCENARIO), hash: null };
    case 'scenario':
      return { loaded: fromScenario(source.id), hash: `#scenario=${source.id}` };
    case 'earlierVersion':
      return { loaded: fromScenario(DEFAULT_SCENARIO, { tone: 'info', text: S.app.earlierVersionLink }), hash: `#scenario=${DEFAULT_SCENARIO}` };
    case 'shared': {
      const decoded = decodeShare(source.encoded);
      const built = decoded.ok ? buildComparison(decoded.value) : decoded;
      if (!built.ok) {
        return { loaded: fromScenario(DEFAULT_SCENARIO, { tone: 'error', text: S.app.shareInvalid, issues: built.error.slice(0, 6) }), hash: `#scenario=${DEFAULT_SCENARIO}` };
      }
      return { loaded: { config: built.value.config, cmp: built.value, scenarioId: null, speed: 100, notice: null }, hash: `#c=${source.encoded}` };
    }
  }
}

function loadLink(search: string, hash: string): LinkLoad {
  const fragment = fragmentSource(hash);
  const query = querySource(search);
  const { loaded, hash: canonical } = fromSource(fragment.kind === 'none' ? query : fragment);
  const next = `${query.kind === 'none' ? search : ''}${canonical ?? hash}`;
  return { ...loaded, address: next === `${search}${hash}` ? null : next };
}

function showAddress(loaded: LinkLoad) {
  if (loaded.address !== null) history.replaceState(null, '', `${location.pathname}${loaded.address}`);
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

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <ul>
      {issues.map((issue, i) => (
        <li key={`${i}-${issue.path}-${issue.code}`} data-issue-path={issue.path}>
          {issueText(issue)}
        </li>
      ))}
    </ul>
  );
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
  const initial = useMemo(() => loadLink(location.search, location.hash), []);
  useEffect(() => showAddress(initial), [initial]);
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
  const shortcutsRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const atRef = useRef(at);
  atRef.current = at;
  const cmpRef = useRef(cmp);
  cmpRef.current = cmp;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const adopt = useCallback((next: Comparison, opts: { scenarioId: ScenarioId | null; reset: boolean }) => {
    setCmp(next);
    setDraft(next.config);
    setIssues([]);
    setScenarioId(opts.scenarioId);
    setAt(opts.reset ? startPlayhead(next) : seekTime(next, atRef.current.timeUs));
    const previousTrace = cmpRef.current.trace;
    setSelection(s => {
      if (opts.reset || s?.kind !== 'request') return null;
      const request = next.trace.findIndex(t => t.id === previousTrace[s.request]?.id);
      return request < 0 ? null : { kind: 'request', request };
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
      syncHash(built.value.config);
    },
    [adopt],
  );

  useEffect(() => {
    const onHashChange = () => {
      const loaded = loadLink(location.search, location.hash);
      showAddress(loaded);
      setPlaying(false);
      setSpeed(loaded.speed);
      adopt(loaded.cmp, { scenarioId: loaded.scenarioId, reset: true });
      setNotice(loaded.notice);
    };
    addEventListener('hashchange', onHashChange);
    return () => removeEventListener('hashchange', onHashChange);
  }, [adopt]);

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
    const changeSpeed = (delta: number) =>
      setSpeed(current => {
        const options = speedOptions(current);
        return options[Math.max(0, Math.min(options.length - 1, options.indexOf(current) + delta))]!;
      });
    const commands: Record<Command, () => void> = {
      toggle,
      previous: () => step(-1),
      next: () => step(1),
      reset,
      end: () => {
        setPlaying(false);
        setAt(seekStep(cmp, total));
      },
      slower: () => changeSpeed(-1),
      faster: () => changeSpeed(1),
      shortcuts: () => shortcutsRef.current?.showModal(),
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"], dialog[open]')) return;
      if (e.key === ' ' && target?.closest('button, a, summary')) return;
      const command = SHORTCUTS.get(e.key);
      if (!command) return;
      commands[command]();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step, reset, cmp, total]);

  const states = { A: stateAt(cmp.panels.A, panelApplied(cmp, at, 'A')), B: stateAt(cmp.panels.B, panelApplied(cmp, at, 'B')) };
  const range = windowRange(cmp, at.timeUs, windowMs);
  const seekToTime = (t: number) => {
    setPlaying(false);
    setAt(seekTime(cmp, t));
  };
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
      setNotice({ tone: 'error', text: S.app.importFailed, issues: [{ path: 'import', code: 'tooLarge', params: { length: file.size, max: MAX_IMPORT_BYTES } }] });
      return;
    }
    const result = importText(await file.text());
    if (!result.ok) {
      setNotice({ tone: 'error', text: S.app.importFailed, issues: result.error.slice(0, 8) });
      return;
    }
    setPlaying(false);
    adopt(result.value.comparison, { scenarioId: null, reset: true });
    syncHash(result.value.comparison.config);
    setNotice({ tone: 'info', text: S.app.importOk(result.value.history) });
  };

  const headerActions: { label: string; icon: HeaderIconName; testId: string; keys?: string; onClick: () => void }[] = [
    { label: S.app.modelButton, icon: 'model', testId: 'open-model', onClick: () => dialogRef.current?.showModal() },
    { label: S.app.shortcutsButton, icon: 'keyboard', testId: 'open-shortcuts', keys: '?', onClick: () => shortcutsRef.current?.showModal() },
    { label: S.app.importButton, icon: 'import', testId: 'import', onClick: () => fileRef.current?.click() },
    { label: S.app.exportButton, icon: 'export', testId: 'export', onClick: exportJson },
    { label: S.app.shareButton, icon: 'share', testId: 'share', onClick: () => void share() },
  ];

  return (
    <>
      <header className="header">
        <div className="brand">
          <h1>{S.app.title}</h1>
          <span className="tag">{S.app.tagline}</span>
        </div>
        <span className="disclaimer">{S.app.disclaimer}</span>
        <div className="actions">
          {headerActions.map(a => (
            <button key={a.testId} type="button" className="btn header-action" title={a.label} aria-keyshortcuts={a.keys} onClick={a.onClick} data-testid={a.testId}>
              <HeaderIcon name={a.icon} />
              <span className="btn-label">{a.label}</span>
            </button>
          ))}
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
        </div>
      </header>

      {notice && (
        <div className={`notice${notice.tone === 'error' ? ' error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="notice">
          <div>
            <p>{notice.text}</p>
            {notice.issues && <IssueList issues={notice.issues} />}
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
            <IssueList issues={issues.slice(0, 8)} />
          </div>
        </div>
      )}

      <div className="playback-dock">
        <PlaybackBar
          cmp={cmp}
          at={at}
          playing={playing}
          speed={speed}
          windowMs={windowMs}
          onToggle={toggle}
          onStep={step}
          onReset={reset}
          onSeekTime={seekToTime}
          onSpeed={setSpeed}
          onWindow={setWindowMs}
        />
      </div>

      <div className="layout">
        <aside className="sidebar">
          <ScenarioPanel active={scenarioId} onPick={pickScenario} />
          <ConfigPanel config={draft} onChange={editConfig} compact={narrow} />
        </aside>
        <main className="main">
          <Differences config={cmp.config} />
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

          <OverTime cmp={cmp} atUs={at.timeUs} range={range} onSeekTime={seekToTime} />

          <div className="bottom">
            <DetailsPanel cmp={cmp} states={states} selection={selection} onSelect={setSelection} />
            <EventLog
              cmp={cmp}
              at={at}
              onSeekStep={k => {
                setPlaying(false);
                setAt(seekStep(cmp, k));
              }}
            />
          </div>
          <Results cmp={cmp} states={states} atUs={at.timeUs} selected={selection?.kind === 'request' ? selection.request : null} onSelectRequest={selectRequest} />
          <p className="muted small" data-testid="totals">
            {S.playback.event(at.applied, total)}
          </p>
        </main>
      </div>
      <ModelDialog ref={dialogRef} cost={cmp.config.cost} />
      <ShortcutsDialog ref={shortcutsRef} />
    </>
  );
}
