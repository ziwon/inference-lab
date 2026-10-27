import { useEffect, useId, useState, type ReactNode } from 'react';
import type { RequestPhase } from '../engine/replay';
import { t } from '../i18n';

interface NumberFieldProps {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  min: number;
  max: number;
  integer?: boolean;
  step?: number;
  unit?: string;
  hint?: string;
  /** Allow an empty value (used for optional per-panel overrides). */
  optional?: boolean;
  placeholder?: string;
  compact?: boolean;
}

/**
 * Number input with a local draft. Invalid drafts are shown with an error and never
 * committed, so the simulation keeps using the last valid value.
 */
export function NumberField({ label, value, onCommit, min, max, integer, step, unit, hint, optional, placeholder, compact }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value === undefined ? '' : String(value));
    setError(null);
  }, [value]);

  function change(text: string) {
    setDraft(text);
    const trimmed = text.trim();
    if (trimmed === '') {
      if (optional) { setError(null); onCommit(undefined); }
      else setError('Enter a value.');
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return setError('Enter a number.');
    if (integer && !Number.isInteger(n)) return setError('Enter a whole number.');
    if (n < min || n > max) return setError(`Enter ${min}–${max}.`);
    setError(null);
    if (n !== value) onCommit(n);
  }

  return (
    <div className={`field ${compact ? 'field-compact' : ''} ${error ? 'has-error' : ''}`}>
      <label htmlFor={id} title={hint}>
        {label}
        {hint && <span className="field-hint-dot" aria-hidden="true">?</span>}
      </label>
      <div className="input-wrap">
        <input
          id={id}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          value={draft}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
          onChange={e => change(e.target.value)}
          onBlur={() => { if (error) { setDraft(value === undefined ? '' : String(value)); setError(null); } }}
          step={step}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {error ? <span className="field-error" id={`${id}-err`} role="alert">{error}</span> : hint ? <span className="sr-only" id={`${id}-hint`}>{hint}</span> : null}
    </div>
  );
}

interface SelectFieldProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
  compact?: boolean;
}

export function SelectField<T extends string | number>({ label, value, options, onChange, hint, compact }: SelectFieldProps<T>) {
  const id = useId();
  return (
    <div className={`field ${compact ? 'field-compact' : ''}`}>
      <label htmlFor={id} title={hint}>{label}</label>
      <div className="select-wrap">
        <select id={id} value={String(value)} onChange={e => {
          const found = options.find(o => String(o.value) === e.target.value);
          if (found) onChange(found.value);
        }}>
          {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

/** Shape + label + color, so state never depends on color alone. */
export function PhaseGlyph({ phase, size = 12 }: { phase: RequestPhase; size?: number }) {
  const s = size;
  const c = s / 2;
  let shape: ReactNode;
  switch (phase) {
    case 'waiting': shape = <circle cx={c} cy={c} r={c - 1.5} fill="none" strokeWidth={1.6} />; break;
    case 'admitted': shape = <path d={`M${c} 1.5 L${s - 1.5} ${c} L${c} ${s - 1.5} L1.5 ${c} Z`} fill="none" strokeWidth={1.6} />; break;
    case 'prefill': shape = <rect x={1.5} y={1.5} width={s - 3} height={s - 3} rx={1} strokeWidth={0} />; break;
    case 'decode': shape = <path d={`M2 1.5 L${s - 1.5} ${c} L2 ${s - 1.5} Z`} strokeWidth={0} />; break;
    case 'complete': shape = <path d={`M2 ${c} L${c - 1} ${s - 2.5} L${s - 1.5} 2.5`} fill="none" strokeWidth={2} />; break;
    case 'infeasible': shape = <path d={`M2.5 2.5 L${s - 2.5} ${s - 2.5} M${s - 2.5} 2.5 L2.5 ${s - 2.5}`} fill="none" strokeWidth={2} />; break;
    default: shape = <circle cx={c} cy={c} r={c - 2} fill="none" strokeWidth={1.2} strokeDasharray="2 2" />;
  }
  return (
    <svg className={`glyph phase-${phase}`} width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden="true" focusable="false">
      {shape}
    </svg>
  );
}

export function PhaseBadge({ phase, running }: { phase: RequestPhase; running?: boolean }) {
  return (
    <span className={`phase-badge phase-${phase}`} title={t.phaseHint[phase]}>
      <PhaseGlyph phase={phase} />
      {t.phase[phase]}
      {running && phase !== 'complete' && <span className="running-dot" aria-label="running now" />}
    </span>
  );
}

export function PanelTag({ panel }: { panel: 'A' | 'B' }) {
  return <span className={`panel-tag panel-tag-${panel}`} aria-label={`Panel ${panel}`}>{panel}</span>;
}

export function Collapsible({ title, children, defaultOpen = false, id, extra }: { title: string; children: ReactNode; defaultOpen?: boolean; id?: string; extra?: ReactNode }) {
  return (
    <details className="collapsible" open={defaultOpen} id={id}>
      <summary>
        <span className="summary-title">{title}</span>
        {extra}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
