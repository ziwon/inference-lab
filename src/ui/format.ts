import { S } from './strings.ts';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Binary units: 1 KiB = 1,024 bytes. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const index = Math.min(UNITS.length - 1, Math.max(0, Math.floor(Math.log2(Math.abs(bytes)) / 10)));
  const value = bytes / 1024 ** index;
  const digits = index === 0 || Number.isInteger(value) ? 0 : value >= 100 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[index]}`;
}

/** Modeled time in milliseconds. Labels carry "(modeled)"; values do not repeat it. */
export function formatMs(us: number | null | undefined): string {
  if (us === null || us === undefined) return S.common.na;
  const ms = us / 1000;
  const digits = Math.abs(ms) >= 100 ? 0 : Math.abs(ms) >= 10 ? 1 : 2;
  return `${ms.toFixed(digits)} ms`;
}

export const formatInt = (n: number) => n.toLocaleString('en-US');

export function formatRate(perSec: number | null): string {
  if (perSec === null) return S.common.na;
  return `${perSec >= 100 ? perSec.toFixed(0) : perSec.toFixed(1)}/s`;
}

export function formatPercent(fraction: number | null): string {
  return fraction === null ? S.common.na : `${(fraction * 100).toFixed(0)}%`;
}

export const formatCount = (n: number, of: number) => `${n} of ${of}`;
