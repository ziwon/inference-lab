import { describe, expect, it } from 'vitest';
import { panelDifferences } from './compare';
import { requestMetrics, summarize } from './metrics';
import { SCENARIO_IDS, scenarioConfig } from './scenarios';
import { simulateBoth } from './simulator';

describe('curated scenarios', () => {
  it.each(SCENARIO_IDS)('%s completes deterministically in both panels', id => {
    const config = scenarioConfig(id);
    const results = simulateBoth(config, { checkInvariants: true });
    for (const panel of ['A', 'B'] as const) {
      expect(results[panel].status).toBe('completed');
      const s = summarize(results[panel], config.slo);
      expect(s.counts.completed + s.counts.infeasible).toBe(s.counts.total);
    }
    expect(panelDifferences(config).map(d => d.field)).toEqual(['policy', 'maxPrefillChunk']);
  });

  it('long-prefill admits the long request while short requests are still decoding, in both panels', () => {
    const config = scenarioConfig('long-prefill');
    const results = simulateBoth(config);
    for (const panel of ['A', 'B'] as const) {
      const r = results[panel];
      const longIndex = r.trace.findIndex(t => t.id === 'LONG');
      const admit = r.events.find(e => e.type === 'admit' && e.req === longIndex)!;
      expect(admit.t - r.trace[longIndex].arrivalMs).toBeLessThan(20);
      const decodingAtAdmit = r.iterations.filter(it => it.startMs >= admit.t && it.startMs < admit.t + 30).flatMap(it => it.items).filter(i => i.kind === 'decode');
      expect(decodingAtAdmit.length).toBeGreaterThanOrEqual(5);
    }
    const a = requestMetrics(results.A, config.slo);
    const b = requestMetrics(results.B, config.slo);
    const shortMaxItl = (m: typeof a) => Math.max(...m.filter(x => x.id.startsWith('R') && Number(x.id.slice(1)) <= 6).map(x => x.maxItlMs ?? 0));
    // Tradeoff from the model: chunking shortens decode stalls but delays the long request's first token.
    expect(shortMaxItl(b)).toBeLessThan(shortMaxItl(a));
    expect(b.find(x => x.id === 'LONG')!.ttftMs!).toBeGreaterThan(a.find(x => x.id === 'LONG')!.ttftMs!);
  });

  it('kv-pressure makes requests wait on reservation capacity', () => {
    const results = simulateBoth(scenarioConfig('kv-pressure'));
    for (const panel of ['A', 'B'] as const) {
      expect(results[panel].events.some(e => e.type === 'admission-blocked' && e.reason === 'kv-reservation')).toBe(true);
      const headroom = results[panel].iterations.map(it => it.reservedBlocks - it.allocatedBlocks);
      expect(Math.max(...headroom)).toBeGreaterThan(100);
    }
  });

  it('burst queues requests behind the sequence limit', () => {
    const results = simulateBoth(scenarioConfig('burst'));
    expect(results.A.events.some(e => e.type === 'admission-blocked' && e.reason === 'sequence-limit')).toBe(true);
    expect(results.A.trace.every(r => r.arrivalMs === results.A.trace[0].arrivalMs)).toBe(true);
  });

  it('edge-cases includes a one-token output and an infeasible request', () => {
    const config = scenarioConfig('edge-cases');
    const results = simulateBoth(config);
    const m = requestMetrics(results.B, config.slo);
    expect(m.find(x => x.id === 'ONE')).toMatchObject({ status: 'completed', generatedTokens: 1, tpotMs: null });
    expect(m.find(x => x.id === 'HUGE')).toMatchObject({ status: 'infeasible', slo: 'infeasible' });
    expect(m.find(x => x.id === 'NEXT')?.status).toBe('completed');
  });
});
