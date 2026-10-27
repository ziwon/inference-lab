import { useEffect, useId, useState } from 'react';
import { S } from './strings.ts';

interface Props {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  optional?: boolean;
  placeholder?: string;
  wide?: boolean;
  badge?: string;
  testId?: string;
}

export function NumberField({ label, value, onCommit, min, max, step, integer, optional, placeholder, wide, badge, testId }: Props) {
  const id = useId();
  const shown = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(shown);
    setInvalid(false);
  }, [shown]);

  const commit = () => {
    const text = draft.trim();
    if (text === '' && optional) {
      setInvalid(false);
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const n = Number(text);
    const ok = text !== '' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
    setInvalid(!ok);
    if (ok && n !== value) onCommit(n);
  };

  return (
    <label className={`field${wide ? ' wide' : ''}`} htmlFor={id}>
      <span>
        {label} {badge && <span className="badge">{badge}</span>}
      </span>
      <input
        id={id}
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        value={draft}
        min={min}
        max={max}
        step={step ?? (integer ? 1 : 'any')}
        placeholder={placeholder}
        aria-invalid={invalid}
        data-testid={testId}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
        }}
      />
      {invalid && <span className="err">{S.config.invalidNumber} {min}–{max}</span>}
    </label>
  );
}

interface SelectProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  wide?: boolean;
  badge?: string;
  testId?: string;
}

export function SelectField<T extends string | number>({ label, value, options, onChange, wide, badge, testId }: SelectProps<T>) {
  const id = useId();
  return (
    <label className={`field${wide ? ' wide' : ''}`} htmlFor={id}>
      <span>
        {label} {badge && <span className="badge">{badge}</span>}
      </span>
      <select
        id={id}
        value={String(value)}
        data-testid={testId}
        onChange={e => {
          const picked = options.find(o => String(o.value) === e.target.value);
          if (picked) onChange(picked.value);
        }}
      >
        {options.map(o => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
