import {
  ARCHITECTURE_PRESETS,
  ARRIVAL_PATTERNS,
  type Architecture,
  KV_ELEMENT_BYTES,
  LIMITS,
  PANEL_IDS,
  POLICY_IDS,
  type PanelId,
  type SchedulerLimits,
  type SimConfig,
  type TraceRequest,
  WEIGHT_BITS,
} from '../sim/config.ts';
import { SCENARIO_IDS, type ScenarioId } from '../sim/scenarios.ts';
import { usedBy } from '../sim/scheduler.ts';
import { GIB } from '../sim/units.ts';
import { NumberField, SelectField } from './NumberField.tsx';
import { S } from './strings.ts';

const EDITABLE_TRACE_ROWS = 32;

export function ScenarioPanel({ active, onPick }: { active: ScenarioId | null; onPick: (id: ScenarioId) => void }) {
  const text = active ? S.scenarios[active] : null;
  return (
    <section className="card" aria-labelledby="scenario-heading">
      <div className="card-head">
        <h2 id="scenario-heading">{S.scenario.heading}</h2>
        {!active && <span className="badge">{S.scenario.custom}</span>}
      </div>
      <div className="card-body">
        <div className="scenario-list">
          {SCENARIO_IDS.map(id => (
            <button key={id} type="button" className="scenario-btn" aria-pressed={active === id} onClick={() => onPick(id)} data-testid={`scenario-${id}`}>
              <span className="name">{S.scenarios[id].name}</span>
              <span className="summary">{S.scenarios[id].summary}</span>
            </button>
          ))}
        </div>
        {text && (
          <dl className="explain">
            <dt>{S.scenario.observe}</dt>
            <dd>{text.observe}</dd>
            <dt>{S.scenario.assumption}</dt>
            <dd>{text.assumption}</dd>
            <dt>{S.scenario.limits}</dt>
            <dd>{text.limits}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

interface Props {
  config: SimConfig;
  onChange: (next: SimConfig) => void;
  compact: boolean;
}

const LIMIT_FIELDS: { key: keyof SchedulerLimits; label: string; max: number }[] = [
  { key: 'maxActiveSequences', label: S.config.limits.maxActiveSequences, max: 1024 },
  { key: 'maxBatchTokens', label: S.config.limits.maxBatchTokens, max: 262_144 },
  { key: 'maxPrefillChunkTokens', label: S.config.limits.maxPrefillChunkTokens, max: 262_144 },
];

export function ConfigPanel({ config, onChange, compact }: Props) {
  const c = config;
  const set = <K extends keyof SimConfig>(key: K, value: SimConfig[K]) => onChange({ ...c, [key]: value });
  const arch = (patch: Partial<Architecture>) => set('architecture', { ...c.architecture, ...patch });
  const presetId = ARCHITECTURE_PRESETS.find(p => JSON.stringify(p.arch) === JSON.stringify(c.architecture))?.id ?? 'custom';
  const open = !compact;

  return (
    <section className="card" aria-labelledby="config-heading">
      <div className="card-head">
        <h2 id="config-heading">{S.config.heading}</h2>
      </div>
      <div className="card-body config">
        <details className="group" open={open}>
          <summary>{S.config.architecture}</summary>
          <div className="fields">
            <SelectField
              wide
              label={S.config.preset}
              value={presetId}
              testId="arch-preset"
              options={[...ARCHITECTURE_PRESETS.map(p => ({ value: p.id as string, label: p.arch.label })), { value: 'custom', label: S.config.customArch }]}
              onChange={id => {
                const p = ARCHITECTURE_PRESETS.find(x => x.id === id);
                if (p) set('architecture', { ...p.arch });
              }}
            />
            <NumberField label={S.config.params} value={c.architecture.parameterCount / 1e9} min={0.001} max={2000} onCommit={v => arch({ parameterCount: Math.round((v ?? 1) * 1e9), label: S.config.customArch })} />
            <NumberField label={S.config.layers} integer value={c.architecture.numLayers} min={1} max={256} onCommit={v => arch({ numLayers: v ?? 1, label: S.config.customArch })} />
            <NumberField label={S.config.queryHeads} integer value={c.architecture.numQueryHeads} min={1} max={512} onCommit={v => arch({ numQueryHeads: v ?? 1, label: S.config.customArch })} />
            <NumberField label={S.config.kvHeads} integer value={c.architecture.numKvHeads} min={1} max={512} testId="kv-heads" onCommit={v => arch({ numKvHeads: v ?? 1, label: S.config.customArch })} />
            <NumberField label={S.config.headDim} integer value={c.architecture.headDim} min={1} max={1024} onCommit={v => arch({ headDim: v ?? 1, label: S.config.customArch })} />
            <NumberField label={S.config.maxContext} integer value={c.architecture.maxContextTokens} min={2} max={LIMITS.contextTokens} onCommit={v => arch({ maxContextTokens: v ?? 2, label: S.config.customArch })} />
          </div>
        </details>

        <details className="group" open={open}>
          <summary>{S.config.memory}</summary>
          <div className="fields">
            <NumberField label={S.config.device} value={c.memory.deviceBytes / GIB} min={1} max={1024} testId="device-gib" onCommit={v => set('memory', { ...c.memory, deviceBytes: Math.round((v ?? 1) * GIB) })} />
            <SelectField label={S.config.weightBits} value={c.memory.weightBits} options={WEIGHT_BITS.map(b => ({ value: b as number, label: S.config.bits(b) }))} onChange={v => set('memory', { ...c.memory, weightBits: v })} />
            <NumberField label={S.config.metadata} value={c.memory.weightMetadataPercent} min={0} max={100} onCommit={v => set('memory', { ...c.memory, weightMetadataPercent: v ?? 0 })} />
            <NumberField label={S.config.runtime} value={c.memory.runtimeAllowanceBytes / GIB} min={0} max={1024} onCommit={v => set('memory', { ...c.memory, runtimeAllowanceBytes: Math.round((v ?? 0) * GIB) })} />
            <SelectField label={S.config.kvElement} value={c.memory.kvElementBytes} options={KV_ELEMENT_BYTES.map(b => ({ value: b as number, label: S.config.kvElements[b] ?? String(b) }))} onChange={v => set('memory', { ...c.memory, kvElementBytes: v })} />
            <NumberField label={S.config.blockSize} integer value={c.memory.blockSizeTokens} min={1} max={512} testId="block-size" onCommit={v => set('memory', { ...c.memory, blockSizeTokens: v ?? 16 })} />
          </div>
        </details>

        <details className="group" open={open}>
          <summary>{S.config.scheduler}</summary>
          <div className="fields">
            {LIMIT_FIELDS.map(f => (
              <NumberField key={f.key} label={f.label} integer value={c.scheduler[f.key]} min={1} max={f.max} testId={`shared-${f.key}`} onCommit={v => set('scheduler', { ...c.scheduler, [f.key]: v ?? 1 })} />
            ))}
          </div>
        </details>

        <details className="group" open={open}>
          <summary>{S.config.panels}</summary>
          {PANEL_IDS.map(panel => (
            <PanelFields key={panel} panel={panel} config={c} onChange={onChange} />
          ))}
        </details>

        <details className="group" open={open}>
          <summary>{S.config.trace}</summary>
          <TraceFields config={c} onChange={onChange} />
        </details>

        <details className="group">
          <summary>{S.config.cost}</summary>
          <div className="fields">
            <NumberField label={S.config.overhead} value={c.cost.overheadMs} min={0} max={10_000} onCommit={v => set('cost', { ...c.cost, overheadMs: v ?? 0 })} />
            <NumberField label={S.config.prefillToken} value={c.cost.prefillTokenMs} min={0} max={1000} onCommit={v => set('cost', { ...c.cost, prefillTokenMs: v ?? 0 })} />
            <NumberField label={S.config.attention} value={c.cost.attentionMsPerMillionPairs} min={0} max={10_000} onCommit={v => set('cost', { ...c.cost, attentionMsPerMillionPairs: v ?? 0 })} />
            <NumberField label={S.config.decodeSeq} value={c.cost.decodeSequenceMs} min={0} max={1000} onCommit={v => set('cost', { ...c.cost, decodeSequenceMs: v ?? 0 })} />
            <NumberField wide label={S.config.decodeCtx} value={c.cost.decodeContextMsPerThousandTokens} min={0} max={1000} onCommit={v => set('cost', { ...c.cost, decodeContextMsPerThousandTokens: v ?? 0 })} />
          </div>
        </details>

        <details className="group" open={open}>
          <summary>{S.config.slo}</summary>
          <div className="fields">
            <NumberField label={S.config.ttft} value={c.slo.ttftMs} min={0} max={3_600_000} testId="slo-ttft" onCommit={v => set('slo', { ...c.slo, ttftMs: v ?? 0 })} />
            <NumberField label={S.config.tpot} value={c.slo.tpotMs} min={0} max={3_600_000} onCommit={v => set('slo', { ...c.slo, tpotMs: v ?? 0 })} />
          </div>
        </details>
      </div>
    </section>
  );
}

function PanelFields({ panel, config, onChange }: { panel: PanelId; config: SimConfig; onChange: (c: SimConfig) => void }) {
  const spec = config.panels[panel];
  const setSpec = (next: typeof spec) => onChange({ ...config, panels: { ...config.panels, [panel]: next } });
  return (
    <div className="fields">
      <SelectField
        wide
        label={`${S.panel(panel)} · ${S.config.policy}`}
        value={spec.policy}
        testId={`policy-${panel}`}
        options={POLICY_IDS.map(p => ({ value: p, label: S.policy[p].name }))}
        onChange={policy => setSpec({ ...spec, policy })}
      />
      {LIMIT_FIELDS.filter(f => usedBy(spec.policy, f.key)).map(f => {
        const v = spec.overrides[f.key];
        return (
          <NumberField
            key={f.key}
            optional
            integer
            label={`${S.config.override}: ${f.label}`}
            placeholder={String(config.scheduler[f.key])}
            value={v}
            min={1}
            max={f.max}
            badge={v !== undefined && v !== config.scheduler[f.key] ? S.config.differs : undefined}
            testId={`override-${panel}-${f.key}`}
            onCommit={value => {
              const overrides = { ...spec.overrides };
              if (value === undefined) delete overrides[f.key];
              else overrides[f.key] = value;
              setSpec({ ...spec, overrides });
            }}
          />
        );
      })}
    </div>
  );
}

function TraceFields({ config, onChange }: { config: SimConfig; onChange: (c: SimConfig) => void }) {
  const t = config.trace;
  const seed = <NumberField integer label={S.config.seed} value={config.seed} min={0} max={2 ** 32 - 1} testId="seed" onCommit={v => onChange({ ...config, seed: v ?? 0 })} />;
  if (t.kind === 'generated') {
    const setGen = (patch: Partial<typeof t>) => onChange({ ...config, trace: { ...t, ...patch } });
    return (
      <div className="fields">
        {seed}
        <NumberField integer label={S.config.count} value={t.count} min={1} max={LIMITS.requests} testId="trace-count" onCommit={v => setGen({ count: v ?? 1 })} />
        <SelectField label={S.config.pattern} value={t.pattern} options={ARRIVAL_PATTERNS.map(p => ({ value: p, label: S.config.patterns[p] ?? p }))} onChange={pattern => setGen({ pattern })} />
        <NumberField label={S.config.span} value={t.spanMs} min={0} max={LIMITS.arrivalMs} onCommit={v => setGen({ spanMs: v ?? 0 })} />
        <NumberField integer label={S.config.promptMin} value={t.promptTokens.min} min={1} max={LIMITS.promptTokens} onCommit={v => setGen({ promptTokens: { ...t.promptTokens, min: v ?? 1 } })} />
        <NumberField integer label={S.config.promptMax} value={t.promptTokens.max} min={1} max={LIMITS.promptTokens} testId="prompt-max" onCommit={v => setGen({ promptTokens: { ...t.promptTokens, max: v ?? 1 } })} />
        <NumberField integer label={S.config.outputMin} value={t.outputTokens.min} min={1} max={LIMITS.outputTokens} onCommit={v => setGen({ outputTokens: { ...t.outputTokens, min: v ?? 1 } })} />
        <NumberField integer label={S.config.outputMax} value={t.outputTokens.max} min={1} max={LIMITS.outputTokens} onCommit={v => setGen({ outputTokens: { ...t.outputTokens, max: v ?? 1 } })} />
      </div>
    );
  }
  const rows = t.requests;
  const setRows = (requests: TraceRequest[]) => onChange({ ...config, trace: { kind: 'explicit', requests } });
  const patch = (i: number, p: Partial<TraceRequest>) => setRows(rows.map((row, j) => (j === i ? { ...row, ...p } : row)));
  if (rows.length > EDITABLE_TRACE_ROWS) {
    return (
      <div className="fields">
        {seed}
        <p className="field wide muted small">{S.config.traceTooLong(rows.length)}</p>
      </div>
    );
  }
  const nextId = () => {
    let n = rows.length + 1;
    while (rows.some(r => r.id === `R${n}`)) n++;
    return `R${n}`;
  };
  return (
    <div className="fields">
      <div className="trace-wrap">
        <table className="trace-table">
          <thead>
            <tr>
              <th>{S.config.traceId}</th>
              <th>{S.config.traceArrival}</th>
              <th>{S.config.traceP}</th>
              <th>{S.config.traceG}</th>
              <th>
                <span className="visually-hidden">{S.config.removeRequest('')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id}>
                <td className="id">{row.id}</td>
                <td>
                  <TraceCell label={`${row.id} ${S.config.traceArrival}`} value={row.arrivalMs} max={LIMITS.arrivalMs} onCommit={v => patch(i, { arrivalMs: v })} />
                </td>
                <td>
                  <TraceCell integer label={`${row.id} ${S.config.traceP}`} value={row.promptTokens} max={LIMITS.promptTokens} min={1} testId={`trace-p-${row.id}`} onCommit={v => patch(i, { promptTokens: v })} />
                </td>
                <td>
                  <TraceCell integer label={`${row.id} ${S.config.traceG}`} value={row.outputTokens} max={LIMITS.outputTokens} min={1} onCommit={v => patch(i, { outputTokens: v })} />
                </td>
                <td>
                  <button type="button" className="btn ghost icon" aria-label={S.config.removeRequest(row.id)} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn"
        disabled={rows.length >= EDITABLE_TRACE_ROWS}
        onClick={() => {
          const last = rows[rows.length - 1];
          setRows([...rows, { id: nextId(), arrivalMs: (last?.arrivalMs ?? 0) + 10, promptTokens: 256, outputTokens: 32 }]);
        }}
      >
        {S.config.addRequest}
      </button>
    </div>
  );
}

function TraceCell({ label, value, onCommit, min = 0, max, integer, testId }: { label: string; value: number; onCommit: (v: number) => void; min?: number; max: number; integer?: boolean; testId?: string }) {
  return (
    <input
      type="number"
      aria-label={label}
      defaultValue={value}
      key={value}
      min={min}
      max={max}
      step={integer ? 1 : 'any'}
      data-testid={testId}
      onBlur={e => {
        const n = Number(e.target.value);
        const ok = e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
        e.target.setAttribute('aria-invalid', String(!ok));
        if (ok && n !== value) onCommit(n);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}
