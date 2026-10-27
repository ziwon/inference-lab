import { t } from '../i18n';
import { formatMs } from './format';
import { Icon } from './icons';

export const SPEEDS = [25, 50, 100, 250, 500, 1000, 2000, 5000] as const;
export type ViewMode = 'AB' | 'A' | 'B';

interface Props {
  time: number;
  endMs: number;
  playing: boolean;
  rate: number;
  view: ViewMode;
  canPrev: boolean;
  canNext: boolean;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onEnd: () => void;
  onSeek: (ms: number) => void;
  onRate: (rate: number) => void;
  onView: (view: ViewMode) => void;
}

export function Playback({ time, endMs, playing, rate, view, canPrev, canNext, onToggle, onPrev, onNext, onReset, onEnd, onSeek, onRate, onView }: Props) {
  const disabled = endMs <= 0;
  return (
    <section className="playback" aria-label="Playback">
      <div className="playback-buttons" role="group" aria-label="Playback controls">
        <button className="icon-button" onClick={onReset} disabled={disabled || time <= 0} aria-label={t.playback.reset} title={`${t.playback.reset} (Home)`}><Icon.reset /></button>
        <button className="icon-button" onClick={onPrev} disabled={disabled || !canPrev} aria-label={t.playback.prev} title={`${t.playback.prev} (←)`}><Icon.prev /></button>
        <button className="button primary play-button" onClick={onToggle} disabled={disabled} aria-label={playing ? t.playback.pause : t.playback.play} title={`${playing ? t.playback.pause : t.playback.play} (Space)`}>
          {playing ? <Icon.pause /> : <Icon.play />}
          <span>{playing ? t.playback.pause : t.playback.play}</span>
        </button>
        <button className="icon-button" onClick={onNext} disabled={disabled || !canNext} aria-label={t.playback.next} title={`${t.playback.next} (→)`}><Icon.next /></button>
        <button className="icon-button" onClick={onEnd} disabled={disabled || time >= endMs} aria-label={t.playback.end} title={`${t.playback.end} (End)`}><Icon.end /></button>
      </div>
      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={Math.max(endMs, 1)}
          step="any"
          value={Math.min(time, endMs)}
          onChange={e => onSeek(Number(e.target.value))}
          disabled={disabled}
          aria-label={t.playback.scrubber}
          aria-valuetext={`${formatMs(time)} of ${formatMs(endMs)}`}
        />
        <span className="time-readout mono" aria-live="off">
          <b>{formatMs(Math.min(time, endMs))}</b> / {formatMs(endMs)}
        </span>
      </div>
      <div className="playback-options">
        <label className="speed" title={t.playback.speedHint}>
          <span>{t.playback.speed}</span>
          <select value={rate} onChange={e => onRate(Number(e.target.value))} aria-label={`${t.playback.speed} (${t.playback.speedHint})`}>
            {SPEEDS.map(s => <option key={s} value={s}>{s} {t.playback.speedUnit}</option>)}
          </select>
        </label>
        <div className="segmented" role="radiogroup" aria-label={t.playback.view}>
          {(['AB', 'A', 'B'] as const).map(v => (
            <button key={v} role="radio" aria-checked={view === v} onClick={() => onView(v)}>{v === 'AB' ? t.playback.viewAB : v}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
