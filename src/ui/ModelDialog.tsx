import type { Ref } from 'react';
import type { CostModel } from '../sim/config.ts';
import { MODEL_DOC, S } from './strings.ts';

const costEquation = (c: CostModel) =>
  `duration (ms) = ${c.overheadMs} overhead\n  + ${c.prefillTokenMs} × Σq\n  + ${c.attentionMsPerMillionPairs} × Σ(q·c + q(q+1)/2) / 10⁶\n  + ${c.decodeSequenceMs} × decodes\n  + ${c.decodeContextMsPerThousandTokens} × Σ(c + 1) / 10³`;

export function ModelDialog({ cost, ref }: { cost: CostModel; ref: Ref<HTMLDialogElement> }) {
  return (
    <dialog ref={ref} aria-labelledby="model-heading" data-testid="model-dialog">
      <div className="card-head">
        <h2 id="model-heading">{S.model.heading}</h2>
        <form method="dialog" className="spacer">
          <button type="submit" className="btn">
            {S.model.close}
          </button>
        </form>
      </div>
      <div className="card-body doc">
        <p>{MODEL_DOC.intro}</p>
        {MODEL_DOC.sections.map(section => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {'equation' in section && <code className="eq">{section.equation}</code>}
            {'equationKey' in section && <code className="eq">{costEquation(cost)}</code>}
            <ul>
              {section.items.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
        <h3>{MODEL_DOC.referencesTitle}</h3>
        <ul>
          {MODEL_DOC.references.map(r => (
            <li key={r.href}>
              <a href={r.href} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--text)' }}>
                {r.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}
