import type { Snapshot } from '../engine/replay';
import type { SimConfig } from '../engine/types';
import { t } from '../i18n';
import { PanelTag } from './controls';
import type { PanelData } from './derived';
import { formatBytes, formatInt, formatPct } from './format';

interface Props {
  panel: PanelData;
  snapshot: Snapshot;
  config: SimConfig;
  selectedReq: number | null;
  onSelectReq: (req: number) => void;
}

const MAX_ROWS = 48;

export function MemoryInspector({ panel, snapshot, config, selectedReq, onSelectReq }: Props) {
  const mem = panel.result.memory!;
  const B = config.memory.blockSizeTokens;
  const allocated = snapshot.allocatedBlocks;
  const reserved = snapshot.reservedBlocks;
  const total = mem.totalBlocks;
  const headroom = reserved - allocated;
  const unreserved = total - reserved;
  const slots = allocated * B;
  const written = snapshot.cachedTokens + snapshot.inFlightTokens;
  const fragTokens = Math.max(0, slots - written);
  const device = [
    { key: 'weights', label: t.memory.weights, bytes: mem.weightBytes },
    { key: 'runtime', label: t.memory.runtime, bytes: mem.runtimeAllowanceBytes },
    { key: 'kv', label: t.memory.kvAllocated, bytes: allocated * mem.kvBlockBytes },
    { key: 'headroom', label: t.memory.headroom, bytes: headroom * mem.kvBlockBytes },
    { key: 'free', label: t.memory.unreserved, bytes: unreserved * mem.kvBlockBytes + mem.unusedTailBytes },
  ];
  const live = snapshot.active.map(req => snapshot.requests[req]);
  const maxReserved = Math.max(1, ...live.map(r => r.reservedBlocks));
  const pct = (n: number, d: number) => `${Math.max(0, Math.min(100, (n / Math.max(1, d)) * 100))}%`;
  const showMetadataNote = config.precision.weightBits < 16 && config.precision.weightMetadataPercent === 0;

  return (
    <section className="card inspector" aria-label={`Panel ${panel.id} ${t.memory.title}`}>
      <div className="card-head compact">
        <h3><PanelTag panel={panel.id} /> {t.memory.title}</h3>
        <span className="muted small mono">{formatBytes(mem.kvBytesPerToken)}/token · {formatBytes(mem.kvBlockBytes)}/block</span>
      </div>

      <div className="mem-section">
        <div className="mem-label"><span>{t.memory.device}</span><span className="mono muted">{formatBytes(mem.deviceBytes)}</span></div>
        <div className="stack-bar" role="img" aria-label={device.map(d => `${d.label} ${formatBytes(d.bytes)}`).join(', ')}>
          {device.map(d => <span key={d.key} className={`seg seg-${d.key}`} style={{ width: pct(d.bytes, mem.deviceBytes) }} />)}
        </div>
        <ul className="mem-legend small">
          {device.map(d => (
            <li key={d.key}><i className={`swatch seg-${d.key}`} />{d.label} <span className="mono">{formatBytes(d.bytes)}</span></li>
          ))}
        </ul>
        {showMetadataNote && <p className="note small">{t.memory.metadataNote}</p>}
      </div>

      <div className="mem-section">
        <div className="mem-label"><span>{t.memory.pool}</span><span className="mono muted">{formatInt(total)} {t.memory.blocks} × {B} tokens</span></div>
        <div className="stack-bar pool-bar" role="img" aria-label={`${allocated} allocated, ${headroom} reserved headroom, ${unreserved} unreserved of ${total} blocks`}>
          <span className="seg seg-kv" style={{ width: pct(allocated, total) }} />
          <span className="seg seg-headroom" style={{ width: pct(headroom, total) }} />
        </div>
        <dl className="stat-grid">
          <div><dt>{t.memory.kvAllocated}</dt><dd className="mono">{formatInt(allocated)} <small>{t.memory.blocks}</small></dd></div>
          <div title={t.memory.headroomHint}><dt>{t.memory.headroom}</dt><dd className="mono">{formatInt(headroom)} <small>{t.memory.blocks}</small></dd></div>
          <div><dt>{t.memory.unreserved}</dt><dd className="mono">{formatInt(unreserved)} <small>{t.memory.blocks}</small></dd></div>
          <div><dt>{t.memory.cached}</dt><dd className="mono">{formatInt(snapshot.cachedTokens)}{snapshot.inFlightTokens > 0 && <small> +{formatInt(snapshot.inFlightTokens)} writing</small>}</dd></div>
          <div title={t.memory.fragmentationHint}><dt>{t.memory.fragmentation}</dt><dd className="mono">{formatInt(fragTokens)} <small>slots · {formatBytes(fragTokens * mem.kvBytesPerToken)} · {slots > 0 ? formatPct(fragTokens / slots, 1) : 'N/A'}</small></dd></div>
          <div><dt>{t.memory.peak}</dt><dd className="mono">{formatInt(panel.result.peakAllocatedBlocks)} <small>{t.memory.blocks}</small></dd></div>
        </dl>
        <p className="note small">{t.memory.headroomHint}</p>
      </div>

      <div className="mem-section">
        <div className="mem-label"><span>{t.memory.perRequest}</span><span className="muted small">{live.length}</span></div>
        <p className="small muted">{t.memory.perRequestHint}</p>
        {live.length === 0 ? <p className="small muted">{t.memory.noLive}</p> : (
          <ul className="req-mem-list">
            {live.slice(0, MAX_ROWS).map(r => {
              const capacity = r.reservedBlocks * B;
              return (
                <li key={r.req} className={selectedReq === r.req ? 'is-selected' : ''}>
                  <button className="link-button mono" onClick={() => onSelectReq(r.req)}>{panel.result.trace[r.req].id}</button>
                  <div className="req-bar-track">
                    <div className="req-bar" style={{ width: pct(r.reservedBlocks, maxReserved) }} role="img" aria-label={`${r.cachedTokens} positions populated, ${r.allocatedBlocks} of ${r.reservedBlocks} reserved blocks allocated`}>
                      <span className="rb-alloc" style={{ width: pct(r.allocatedBlocks * B, capacity) }} />
                      <span className="rb-cached" style={{ width: pct(r.cachedTokens, capacity) }} />
                      {r.inFlightTokens > 0 && <span className="rb-flight" style={{ left: pct(r.cachedTokens, capacity), width: pct(r.inFlightTokens, capacity) }} />}
                    </div>
                  </div>
                  <span className="mono small req-bar-text">{r.allocatedBlocks}/{r.reservedBlocks}</span>
                </li>
              );
            })}
          </ul>
        )}
        {live.length > MAX_ROWS && <p className="small muted">…and {live.length - MAX_ROWS} more.</p>}
      </div>
    </section>
  );
}
