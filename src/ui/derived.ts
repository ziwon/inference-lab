import { buildTimelines, createReplayer, eventMoments, type Replayer, type RequestTimeline } from '../engine/replay';
import type { PanelId, SimResult } from '../engine/types';

/** Read-only data derived once per simulation result and shared by every view. */
export interface PanelData {
  id: PanelId;
  result: SimResult;
  valid: boolean;
  replayer: Replayer | null;
  timelines: RequestTimeline[];
  moments: number[];
  blockSize: number;
}

export function derivePanel(id: PanelId, result: SimResult, blockSize: number): PanelData {
  const valid = result.status !== 'invalid';
  return {
    id,
    result,
    valid,
    replayer: valid ? createReplayer(result, blockSize) : null,
    timelines: valid ? buildTimelines(result) : [],
    moments: valid ? eventMoments(result) : [],
    blockSize,
  };
}

export function mergeMoments(lists: number[][]): number[] {
  const all = lists.flat().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of all) if (out.length === 0 || v - out[out.length - 1] > 1e-9) out.push(v);
  return out;
}

const EPS = 1e-7;

export function nextMoment(moments: readonly number[], time: number): number | null {
  let lo = 0;
  let hi = moments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moments[mid] <= time + EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo < moments.length ? moments[lo] : null;
}

export function prevMoment(moments: readonly number[], time: number): number | null {
  let lo = 0;
  let hi = moments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moments[mid] < time - EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? moments[lo - 1] : null;
}
