import { useState } from 'react';
import { KV_ELEMENT_BYTES, POLICIES, RANGES, WEIGHT_BITS } from '../engine/config';
import { memoryModel } from '../engine/memory';
import { ARCHITECTURE_PRESETS, architectureFromPreset } from '../engine/scenarios';
import { parseTraceText, traceToText } from '../engine/serialization';
import type { ArchitectureConfig, CostConfig, GeneratorParams, PanelId, PolicyId, SchedulerConfig, SimConfig, TraceRequest } from '../engine/types';
import { buildTrace } from '../engine/workload';
import { t } from '../i18n';
import { Collapsible, NumberField, SelectField } from './controls';
import { formatBytes, formatInt } from './format';

interface Props {
  config: SimConfig;
  onChange: (next: SimConfig) => void;
}

const POLICY_OPTIONS: { value: PolicyId; label: string }[] = POLICIES.map(value => ({ value, label: t.policy.short[value] }));

const ARCH_LABELS: Record<string, string> = {
  'synthetic-8b-gqa': 'Synthetic 8B · GQA 32/8',
  'synthetic-8b-mha': 'Synthetic 8B · MHA 32/32',
  'synthetic-3b-mha': 'Synthetic 3B · MHA 24/24',
  'synthetic-30b-gqa': 'Synthetic 30B · GQA 48/8',
};

export function ConfigPanel({ config, onChange }: Props) {
  // Every edit produces a new immutable config and marks it as custom.
  const edit = (patch: Partial<SimConfig>) => onChange({ ...config, ...patch, scenarioId: null });
  const setArch = (patch: Partial<ArchitectureConfig>) => edit({ architecture: { ...config.architecture, ...patch, presetId: 'custom' } });
  const setScheduler = (patch: Partial<SchedulerConfig>) => edit({ scheduler: { ...config.scheduler, ...patch } });
  const setCost = (patch: Partial<CostConfig>) => edit({ cost: { ...config.cost, ...patch } });
  const setOverride = (panel: PanelId, key: keyof SchedulerConfig, value: number | undefined) => {
    const overrides = { ...config.panels[panel].overrides };
    if (value === undefined) delete overrides[key];
    else overrides[key] = value;
    edit({ panels: { ...config.panels, [panel]: { ...config.panels[panel], overrides } } });
  };
  const setPolicy = (panel: PanelId, policy: PolicyId) => edit({ panels: { ...config.panels, [panel]: { ...config.panels[panel], policy } } });

  const mem = memoryModel(config.architecture, config.precision, config.memory);
  const a = config.architecture;

  return (
    <div className="config-panel-body">
      <Collapsible title={t.config.workload} defaultOpen>
        <WorkloadEditor config={config} onChange={edit} />
      </Collapsible>

      <Collapsible title={t.config.scheduler} defaultOpen>
        <div className="field-grid">
          <SelectField label={t.config.policyA} value={config.panels.A.policy} options={POLICY_OPTIONS} onChange={v => setPolicy('A', v)} />
          <SelectField label={t.config.policyB} value={config.panels.B.policy} options={POLICY_OPTIONS} onChange={v => setPolicy('B', v)} />
          <NumberField label={t.config.maxSeqs} hint={t.config.maxSeqsHint} value={config.scheduler.maxActiveSequences} onCommit={v => v !== undefined && setScheduler({ maxActiveSequences: v })} {...RANGES.maxActiveSequences} />
          <NumberField label={t.config.tokenBudget} hint={t.config.tokenBudgetHint} value={config.scheduler.tokenBudget} unit="tok" onCommit={v => v !== undefined && setScheduler({ tokenBudget: v })} {...RANGES.tokenBudget} />
          <NumberField label={t.config.chunk} hint={t.config.chunkHint} value={config.scheduler.maxPrefillChunk} unit="tok" onCommit={v => v !== undefined && setScheduler({ maxPrefillChunk: v })} {...RANGES.maxPrefillChunk} />
        </div>
        <details className="sub-details">
          <summary>{t.config.overrides}</summary>
          <p className="small muted">{t.config.overridesHint}</p>
          {(['A', 'B'] as const).map(panel => (
            <div key={panel} className="override-row">
              <span className={`panel-tag panel-tag-${panel}`}>{panel}</span>
              <NumberField compact optional label="Budget" placeholder={String(config.scheduler.tokenBudget)} value={config.panels[panel].overrides.tokenBudget} onCommit={v => setOverride(panel, 'tokenBudget', v)} {...RANGES.tokenBudget} />
              <NumberField compact optional label="Seqs" placeholder={String(config.scheduler.maxActiveSequences)} value={config.panels[panel].overrides.maxActiveSequences} onCommit={v => setOverride(panel, 'maxActiveSequences', v)} {...RANGES.maxActiveSequences} />
              <NumberField compact optional label="Chunk" placeholder={String(config.scheduler.maxPrefillChunk)} value={config.panels[panel].overrides.maxPrefillChunk} onCommit={v => setOverride(panel, 'maxPrefillChunk', v)} {...RANGES.maxPrefillChunk} />
            </div>
          ))}
        </details>
      </Collapsible>

      <Collapsible title={t.config.model}>
        <SelectField
          label={t.config.archPreset}
          value={a.presetId}
          options={[...ARCHITECTURE_PRESETS.map(p => ({ value: p.id, label: ARCH_LABELS[p.id] ?? p.id })), ...(a.presetId === 'custom' ? [{ value: 'custom', label: t.config.customArch }] : [])]}
          onChange={id => { if (id !== 'custom') edit({ architecture: architectureFromPreset(id) }); }}
        />
        <div className="field-grid">
          <NumberField label={t.config.params} value={a.paramsBillions} unit="B" onCommit={v => v !== undefined && setArch({ paramsBillions: v })} {...RANGES.paramsBillions} />
          <NumberField label={t.config.layers} value={a.numLayers} onCommit={v => v !== undefined && setArch({ numLayers: v })} {...RANGES.numLayers} />
          <NumberField label={t.config.qHeads} value={a.numQueryHeads} onCommit={v => v !== undefined && setArch({ numQueryHeads: v })} {...RANGES.numQueryHeads} />
          <NumberField label={t.config.kvHeads} value={a.numKVHeads} onCommit={v => v !== undefined && setArch({ numKVHeads: v })} {...RANGES.numKVHeads} />
          <NumberField label={t.config.headDim} value={a.headDim} onCommit={v => v !== undefined && setArch({ headDim: v })} {...RANGES.headDim} />
          <NumberField label={t.config.maxContext} value={a.maxContextLength} unit="tok" onCommit={v => v !== undefined && setArch({ maxContextLength: v })} {...RANGES.maxContextLength} />
        </div>
      </Collapsible>

      <Collapsible title={t.config.memory}>
        <div className="field-grid">
          <SelectField label={t.config.weightBits} value={config.precision.weightBits} options={WEIGHT_BITS.map(b => ({ value: b, label: `${b}-bit` }))} onChange={v => edit({ precision: { ...config.precision, weightBits: v } })} />
          <NumberField label={t.config.metadata} hint={t.config.metadataHint} value={config.precision.weightMetadataPercent} unit="%" onCommit={v => v !== undefined && edit({ precision: { ...config.precision, weightMetadataPercent: v } })} {...RANGES.weightMetadataPercent} />
          <SelectField label={t.config.kvBytes} value={config.precision.kvElementBytes} options={KV_ELEMENT_BYTES.map(b => ({ value: b, label: b === 2 ? '2 B (16-bit)' : '1 B (8-bit)' }))} onChange={v => edit({ precision: { ...config.precision, kvElementBytes: v } })} />
          <NumberField label={t.config.blockSize} value={config.memory.blockSizeTokens} unit="tok" onCommit={v => v !== undefined && edit({ memory: { ...config.memory, blockSizeTokens: v } })} {...RANGES.blockSizeTokens} />
          <NumberField label={t.config.device} value={config.memory.deviceMemoryGiB} unit="GiB" onCommit={v => v !== undefined && edit({ memory: { ...config.memory, deviceMemoryGiB: v } })} {...RANGES.deviceMemoryGiB} />
          <NumberField label={t.config.runtime} hint={t.config.runtimeHint} value={config.memory.runtimeAllowanceGiB} unit="GiB" onCommit={v => v !== undefined && edit({ memory: { ...config.memory, runtimeAllowanceGiB: v } })} {...RANGES.runtimeAllowanceGiB} />
        </div>
        <p className="derived small mono">{t.config.derived(formatBytes(mem.weightBytes), formatBytes(mem.kvBytesPerToken), formatInt(mem.totalBlocks), formatInt(mem.totalBlocks * config.memory.blockSizeTokens))}</p>
        {config.precision.weightBits < 16 && config.precision.weightMetadataPercent === 0 && <p className="note small">{t.memory.metadataNote}</p>}
      </Collapsible>

      <Collapsible title={t.config.cost}>
        <div className="field-grid">
          <NumberField label={t.config.overhead} value={config.cost.iterationOverheadMs} unit="ms" onCommit={v => v !== undefined && setCost({ iterationOverheadMs: v })} {...RANGES.cost} />
          <NumberField label={t.config.linear} value={config.cost.linearMsPerToken} unit="ms/tok" onCommit={v => v !== undefined && setCost({ linearMsPerToken: v })} {...RANGES.cost} />
          <NumberField label={t.config.prefillAttn} value={config.cost.prefillAttentionMsPerMillionPairs} unit="ms/M pairs" onCommit={v => v !== undefined && setCost({ prefillAttentionMsPerMillionPairs: v })} {...RANGES.cost} />
          <NumberField label={t.config.decodeAttn} value={config.cost.decodeAttentionMsPerThousandPositions} unit="ms/K pos" onCommit={v => v !== undefined && setCost({ decodeAttentionMsPerThousandPositions: v })} {...RANGES.cost} />
        </div>
        <p className="small muted">Modeled milliseconds, chosen for readable scenarios. See “Model and assumptions”.</p>
      </Collapsible>

      <Collapsible title={t.config.slo}>
        <div className="field-grid">
          <NumberField label={t.config.ttft} value={config.slo.ttftMs} unit="ms" onCommit={v => v !== undefined && edit({ slo: { ...config.slo, ttftMs: v } })} {...RANGES.sloMs} />
          <NumberField label={t.config.tpot} value={config.slo.tpotMs} unit="ms" onCommit={v => v !== undefined && edit({ slo: { ...config.slo, tpotMs: v } })} {...RANGES.sloMs} />
        </div>
      </Collapsible>
    </div>
  );
}

function WorkloadEditor({ config, onChange }: { config: SimConfig; onChange: (patch: Partial<SimConfig>) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trace = buildTrace(config);
  const range = (values: number[]) => (values.length === 0 ? '—' : `${Math.min(...values)}–${Math.max(...values)}`);

  function startEdit() {
    setText(traceToText(trace));
    setError(null);
    setEditing(true);
  }
  function apply() {
    const parsed = parseTraceText(text);
    if (!parsed.ok) return setError(parsed.error);
    if (parsed.value.length === 0) return setError('Add at least one request.');
    setError(null);
    setEditing(false);
    onChange({ workload: { kind: 'explicit', requests: parsed.value as TraceRequest[] } });
  }

  if (config.workload.kind === 'generated') {
    const g = config.workload.params;
    const setG = (patch: Partial<GeneratorParams>) => onChange({ workload: { kind: 'generated', params: { ...g, ...patch } } });
    return (
      <>
        <p className="small muted">{t.config.generated}</p>
        <div className="field-grid">
          <NumberField label={t.config.seed} value={config.seed} onCommit={v => v !== undefined && onChange({ seed: v })} {...RANGES.seed} />
          <NumberField label={t.config.count} value={g.count} onCommit={v => v !== undefined && setG({ count: v })} {...RANGES.generatorCount} />
          <NumberField label={t.config.startMs} value={g.startMs} unit="ms" onCommit={v => v !== undefined && setG({ startMs: v })} {...RANGES.generatorMs} />
          <NumberField label={t.config.gapMs} hint={t.config.gapHint} value={g.meanInterArrivalMs} unit="ms" onCommit={v => v !== undefined && setG({ meanInterArrivalMs: v })} {...RANGES.generatorMs} />
          <NumberField label={`${t.config.promptRange} ${t.config.min}`} value={g.promptMin} onCommit={v => v !== undefined && setG({ promptMin: v })} {...RANGES.generatorTokens} />
          <NumberField label={`${t.config.promptRange} ${t.config.max}`} value={g.promptMax} onCommit={v => v !== undefined && setG({ promptMax: v })} {...RANGES.generatorTokens} />
          <NumberField label={`${t.config.outputRange} ${t.config.min}`} value={g.outputMin} onCommit={v => v !== undefined && setG({ outputMin: v })} {...RANGES.generatorTokens} />
          <NumberField label={`${t.config.outputRange} ${t.config.max}`} value={g.outputMax} onCommit={v => v !== undefined && setG({ outputMax: v })} {...RANGES.generatorTokens} />
        </div>
        <button className="button small-button" onClick={() => onChange({ workload: { kind: 'explicit', requests: trace } })}>{t.config.toExplicit}</button>
      </>
    );
  }
  return (
    <>
      <p className="small muted">{t.config.explicit}: {t.config.traceSummary(trace.length, range(trace.map(r => r.promptTokens)), range(trace.map(r => r.outputTokens)))}</p>
      {!editing ? (
        <button className="button small-button" onClick={startEdit}>{t.config.editTrace}</button>
      ) : (
        <div className="trace-editor">
          <label htmlFor="trace-text" className="small muted">{t.config.traceFormat}</label>
          <textarea id="trace-text" value={text} onChange={e => setText(e.target.value)} rows={Math.min(14, Math.max(5, trace.length + 2))} spellCheck={false} aria-invalid={error ? true : undefined} />
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="row-actions">
            <button className="button primary small-button" onClick={apply}>{t.config.applyTrace}</button>
            <button className="button small-button" onClick={() => setEditing(false)}>{t.config.cancel}</button>
          </div>
        </div>
      )}
    </>
  );
}
