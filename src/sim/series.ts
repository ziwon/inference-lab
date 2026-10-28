import { type PanelRun, reducerContext } from './engine.ts';
import { applyEvent, initialState } from './state.ts';

export interface PanelSeries {
  startUs: Float64Array;
  endUs: Float64Array;
  allocated: Int32Array;
  reserved: Int32Array;
  entries: Int32Array;
  waiting: Int32Array;
  active: Int32Array;
}

export function panelSeries(run: PanelRun): PanelSeries {
  const n = run.iterations.length;
  const series: PanelSeries = {
    startUs: new Float64Array(n),
    endUs: new Float64Array(n),
    allocated: new Int32Array(n),
    reserved: new Int32Array(n),
    entries: new Int32Array(n),
    waiting: new Int32Array(n),
    active: new Int32Array(n),
  };
  const ctx = reducerContext(run);
  const state = initialState(run.trace.length);
  let waiting = 0;
  for (const e of run.events) {
    applyEvent(state, e, ctx);
    if (e.kind === 'arrived') waiting += 1;
    else if (e.kind === 'admitted' || e.kind === 'rejected') waiting -= 1;
    else if (e.kind === 'iterationStarted') {
      const i = e.iteration;
      const it = run.iterations[i]!;
      series.startUs[i] = it.startUs;
      series.endUs[i] = it.endUs;
      series.allocated[i] = state.allocatedBlocks;
      series.reserved[i] = state.reservedBlocks;
      series.entries[i] = it.entries.length;
      series.waiting[i] = waiting;
      series.active[i] = state.activeCount;
    }
  }
  return series;
}

export function sampleAt(series: PanelSeries, timeUs: number): number | null {
  let lo = 0;
  let hi = series.endUs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series.endUs[mid]! <= timeUs) lo = mid + 1;
    else hi = mid;
  }
  return lo < series.startUs.length && series.startUs[lo]! <= timeUs ? lo : null;
}
