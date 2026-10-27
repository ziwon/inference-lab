// Display formatting. Byte units are binary (KiB, MiB, GiB); times are modeled milliseconds.

export const NA = 'N/A';

export function formatMs(ms: number | null | undefined, digits?: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return NA;
  const abs = Math.abs(ms);
  if (abs >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (abs >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  const d = digits ?? (abs >= 100 ? 0 : 1);
  return `${ms.toFixed(d)} ms`;
}

export function formatSignedMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return NA;
  if (Math.abs(ms) < 0.05) return '±0';
  return `${ms > 0 ? '+' : '−'}${formatMs(Math.abs(ms))}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return NA;
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return Math.round(value).toLocaleString('en-US');
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatPct(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NA;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatRate(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return NA;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

/** "Nice" tick step for an axis spanning `span` units with roughly `target` ticks. */
export function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10;
  return nice * power;
}

export function formatAxisMs(ms: number, step: number): string {
  if (step >= 1000 || ms >= 10_000) return `${(ms / 1000).toFixed(step >= 1000 ? 0 : 1)} s`;
  return `${Math.round(ms)}`;
}
