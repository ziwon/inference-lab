import type { ReactNode } from 'react';
import { limitDifferences } from '../sim/compare.ts';
import { LIMIT_KEYS, PANEL_IDS, type PanelId, type SimConfig } from '../sim/config.ts';
import { formatInt } from './format.ts';
import { S } from './strings.ts';
import { PanelTag } from './Timeline.tsx';

const Value = ({ panel, children }: { panel: PanelId; children: ReactNode }) => (
  <span className="value">
    <PanelTag panel={panel} /> {children}
  </span>
);

export function Differences({ config }: { config: SimConfig }) {
  const D = S.differences;
  const limits = limitDifferences(config);
  return (
    <section className="card differences" aria-labelledby="differences-heading" data-testid="differences">
      <h2 id="differences-heading">{D.heading}</h2>
      <ul>
        <li data-testid="difference-policy">
          <span className="label">{D.policy}</span>{' '}
          {PANEL_IDS.map(p => (
            <Value key={p} panel={p}>
              {S.policy[config.panels[p].policy].short}{' '}
            </Value>
          ))}
        </li>
        {limits.map(d => (
          <li key={d.limit} className="override" data-testid={`difference-${d.limit}`}>
            <span className="label">{S.config.limits[d.limit]}</span>{' '}
            {PANEL_IDS.map(p => (
              <Value key={p} panel={p}>
                {d.unusedBy.includes(p) ? <s>{formatInt(d.values[p])}</s> : formatInt(d.values[p])}{' '}
              </Value>
            ))}
            <span className="note">{D.shared(formatInt(d.shared))}</span>
            {d.unusedBy.map(p => (
              <span key={p} className="note">
                {' '}
                {D.unusedBy(p)}
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="note">{D.alsoShared(limits.length, LIMIT_KEYS.length)}</p>
    </section>
  );
}
