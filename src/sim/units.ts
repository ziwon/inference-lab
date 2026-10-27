export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
export const KIB = 1024;

/** Simulated time is an integer count of microseconds so boundaries compare exactly. */
export const msToUs = (ms: number) => Math.round(ms * 1000);
export const usToMs = (us: number) => us / 1000;

/** Every nonempty iteration lasts at least 1 µs, the clock resolution. */
export const durationUs = (ms: number) => Math.max(1, Math.round(ms * 1000));

export const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}
