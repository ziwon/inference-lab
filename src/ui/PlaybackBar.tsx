import type { Comparison, Playhead } from '../sim/compare.ts';
import { formatMs } from './format.ts';
import { S } from './strings.ts';

export const SPEEDS = [25, 50, 100, 200, 500, 1000, 2000] as const;
export const WINDOWS = [null, 2000, 500, 100] as const;
const SCRUB_STEPS = 200;

export const speedOptions = (speed: number): readonly number[] =>
  SPEEDS.includes(speed as (typeof SPEEDS)[number]) ? SPEEDS : [...SPEEDS, speed].sort((a, b) => a - b);

interface Props {
  cmp: Comparison;
  at: Playhead;
  playing: boolean;
  speed: number;
  windowMs: number | null;
  onToggle: () => void;
  onStep: (delta: number) => void;
  onReset: () => void;
  onSeekTime: (timeUs: number) => void;
  onSpeed: (msPerSec: number) => void;
  onWindow: (ms: number | null) => void;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <path d={d} />
  </svg>
);

export function PlaybackBar({ cmp, at, playing, speed, windowMs, onToggle, onStep, onReset, onSeekTime, onSpeed, onWindow }: Props) {
  const total = cmp.steps.timeUs.length;
  const scrubStep = Math.max(1, Math.round(cmp.endUs / SCRUB_STEPS));
  return (
    <section className="card" aria-label={S.playback.time}>
      <div className="playback">
        <div className="transport">
          <button type="button" className="btn icon" aria-label={S.playback.reset} title={S.playback.reset} aria-keyshortcuts="Home" onClick={onReset} data-testid="reset">
            <Icon d="M3 2h2v12H3zM14 2v12L6 8z" />
          </button>
          <button type="button" className="btn icon" aria-label={S.playback.previous} title={S.playback.previous} aria-keyshortcuts="ArrowLeft" onClick={() => onStep(-1)} disabled={at.applied === 0} data-testid="prev">
            <Icon d="M11 2h2v12h-2zM10 2v12L3 8z" />
          </button>
          <button type="button" className="btn primary" onClick={onToggle} aria-pressed={playing} aria-keyshortcuts="Space" data-testid="play">
            {playing ? <Icon d="M4 2h3v12H4zm5 0h3v12H9z" /> : <Icon d="M4 2v12l10-6z" />}
            {playing ? S.playback.pause : S.playback.play}
          </button>
          <button type="button" className="btn icon" aria-label={S.playback.next} title={S.playback.next} aria-keyshortcuts="ArrowRight" onClick={() => onStep(1)} disabled={at.applied >= total} data-testid="next">
            <Icon d="M11 2h2v12h-2zM3 2v12l7-6z" />
          </button>
        </div>
        <div className="scrub">
          <input
            type="range"
            aria-label={S.playback.scrubber}
            aria-valuetext={S.playback.scrubberValue(formatMs(at.timeUs), formatMs(cmp.endUs))}
            min={0}
            max={scrubStep * Math.ceil(cmp.endUs / scrubStep)}
            step={scrubStep}
            value={at.timeUs}
            onChange={e => onSeekTime(Number(e.target.value))}
            data-testid="scrubber"
          />
        </div>
        <div className="clock">
          <div className="mono" data-testid="clock">
            {formatMs(at.timeUs)} <span className="muted small">(modeled)</span>
          </div>
          <div className="muted small mono" data-testid="event-counter">
            {S.playback.event(at.applied, total)}
          </div>
        </div>
        <div className="options">
          <label>
            {S.playback.speed}
            <select value={speed} onChange={e => onSpeed(Number(e.target.value))} data-testid="speed">
              {speedOptions(speed).map(s => (
                <option key={s} value={s}>
                  {S.playback.speedOption(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {S.playback.window}
            <select value={windowMs ?? ''} onChange={e => onWindow(e.target.value === '' ? null : Number(e.target.value))} data-testid="window">
              {WINDOWS.map(w => (
                <option key={w ?? 'all'} value={w ?? ''}>
                  {w === null ? S.playback.windowAll : S.playback.windowOption(w)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </section>
  );
}
