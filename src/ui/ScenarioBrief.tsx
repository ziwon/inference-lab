import type { PanelDifference } from '../engine/compare';
import type { ScenarioId } from '../engine/scenarios';
import { t } from '../i18n';
import { PanelTag } from './controls';

export function ScenarioBrief({ scenarioId, basedOn }: { scenarioId: ScenarioId | null; basedOn: ScenarioId }) {
  const text = t.scenarios[scenarioId ?? basedOn];
  return (
    <section className="card brief" aria-labelledby="brief-title">
      <div className="brief-head">
        <h2 id="brief-title">{text.title}{scenarioId === null && <span className="tag">modified</span>}</h2>
        <p>{text.summary}</p>
      </div>
      <div className="brief-observe">
        <h3>{t.scenario.observe}</h3>
        <ul className="observe">{text.observe.map((line, i) => <li key={i}>{line}</li>)}</ul>
      </div>
      <details className="brief-details">
        <summary>{t.scenario.limits}</summary>
        <dl className="brief-grid">
          <div><dt>{t.scenario.assumption}</dt><dd>{text.assumption}</dd></div>
          <div><dt>{t.scenario.notEstablished}</dt><dd>{text.notEstablished}</dd></div>
          <div><dt>{t.scenario.tryThis}</dt><dd>{text.tryThis}</dd></div>
        </dl>
      </details>
    </section>
  );
}

export function DiffBar({ diffs }: { diffs: PanelDifference[] }) {
  const value = (field: PanelDifference['field'], v: string | number) => (field === 'policy' ? t.policy.short[v as 'whole-prefill' | 'chunked-prefill'] : String(v));
  return (
    <div className="diff-bar" role="note" aria-label={t.compare.title}>
      <span className="diff-title">{t.compare.title}:</span>
      {diffs.length === 0 && <span className="diff-item">nothing</span>}
      {diffs.map(d => (
        <span key={d.field} className={`diff-item ${d.field === 'policy' ? '' : 'diff-changed'}`}>
          {t.compare.field[d.field]}{' '}
          <PanelTag panel="A" /> <b className={d.inactiveOn === 'A' ? 'inactive' : ''}>{value(d.field, d.a)}</b>{' '}
          <PanelTag panel="B" /> <b className={d.inactiveOn === 'B' ? 'inactive' : ''}>{value(d.field, d.b)}</b>
          {d.inactiveOn && <small> ({t.compare.inactive(d.inactiveOn)})</small>}
        </span>
      ))}
      <span className="diff-shared">{t.compare.same}</span>
    </div>
  );
}
