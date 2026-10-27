import { describe, expect, it } from 'vitest';
import { scenarioConfig } from './scenarios';
import { buildExport, decodeShareParams, digestEvents, encodeShareParams, parseConfig, parseImport, parseTraceText, traceToText } from './serialization';
import { simulateBoth } from './simulator';
import { testConfig } from './testUtils';
import { buildTrace, generateTrace, deterministicLn } from './workload';

describe('share links', () => {
  it('uses a readable scenario link for unmodified presets', () => {
    const encoded = encodeShareParams(scenarioConfig('burst'));
    expect(encoded.ok && encoded.value.toString()).toBe('scenario=burst');
    const decoded = decodeShareParams('?scenario=burst');
    expect(decoded.kind).toBe('scenario');
  });

  it('round-trips a modified configuration with a custom trace', () => {
    const config = testConfig({ requests: [['X', 0, 10, 2], ['Y', 3.5, 20, 4]] });
    config.panels.B.overrides = { tokenBudget: 77 };
    const encoded = encodeShareParams(config);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeShareParams(`?${encoded.value.toString()}`);
    expect(decoded.kind).toBe('config');
    if (decoded.kind === 'config') expect(decoded.config).toEqual(config);
  });

  it('fails gracefully on malformed, invalid, or oversized links', () => {
    expect(decodeShareParams('?cfg=%%%').kind).toBe('error');
    expect(decodeShareParams('?cfg=' + 'A'.repeat(20_000)).kind).toBe('error');
    expect(decodeShareParams('?scenario=nope').kind).toBe('error');
    expect(decodeShareParams('?v=9&cfg=abc').kind).toBe('error');
    const bad = testConfig({ requests: [['X', 0, 10, 2]] });
    bad.scheduler.tokenBudget = -5;
    const raw = btoa(JSON.stringify(bad)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = decodeShareParams(`?cfg=${raw}`);
    expect(decoded).toMatchObject({ kind: 'error' });
    expect(decodeShareParams('').kind).toBe('none');
  });

  it('refuses to put large custom traces in a link', () => {
    const rows: [string, number, number, number][] = Array.from({ length: 80 }, (_, i) => [`R${i}`, i, 10, 2]);
    expect(encodeShareParams(testConfig({ requests: rows })).ok).toBe(false);
  });
});

describe('config parsing', () => {
  it('rejects wrong types, unknown policies, and P + G beyond the context limit', () => {
    expect(parseConfig(null).ok).toBe(false);
    expect(parseConfig({ version: 2 }).ok).toBe(false);
    const config = testConfig({ requests: [['X', 0, 10, 2]] });
    expect(parseConfig({ ...config, seed: '1' }).ok).toBe(false);
    expect(parseConfig({ ...config, panels: { ...config.panels, A: { policy: 'magic', overrides: {} } } }).ok).toBe(false);
    const tooLong = testConfig({ requests: [['X', 0, 60000, 6000]] });
    const parsed = parseConfig(tooLong);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/exceeds the maximum context length/);
  });

  it('ignores unknown keys instead of copying them', () => {
    const config = testConfig({ requests: [['X', 0, 10, 2]] });
    const parsed = parseConfig({ ...config, __proto__: { polluted: true }, extra: '<script>' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('extra' in parsed.value).toBe(false);
  });
});

describe('export and import', () => {
  it('round-trips the configuration and reproduces the event log', () => {
    const config = scenarioConfig('long-prefill');
    const results = simulateBoth(config);
    const doc = buildExport(config, results);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.trace).toHaveLength(9);
    expect(doc.panels[0].events.length).toBeGreaterThan(0);
    expect(doc.assumptions.length).toBeGreaterThan(3);
    const imported = parseImport(JSON.stringify(doc));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.config).toEqual(config);
    const replay = simulateBoth(imported.value.config);
    expect(digestEvents(replay.A.events)).toBe(imported.value.digests.A);
    expect(digestEvents(replay.B.events)).toBe(imported.value.digests.B);
  });

  it('accepts a bare configuration and rejects non-JSON or wrong schema versions', () => {
    const config = testConfig({ requests: [['X', 0, 10, 2]] });
    expect(parseImport(JSON.stringify(config)).ok).toBe(true);
    expect(parseImport('<html>').ok).toBe(false);
    expect(parseImport('[]').ok).toBe(false);
    expect(parseImport(JSON.stringify({ kind: 'inference-lab-export', schemaVersion: 99 })).ok).toBe(false);
  });

  it('parses the compact trace text format', () => {
    const trace = [{ id: 'A', arrivalMs: 0, promptTokens: 5, outputTokens: 2 }, { id: 'B', arrivalMs: 1.5, promptTokens: 9, outputTokens: 1 }];
    const parsed = parseTraceText(traceToText(trace));
    expect(parsed).toEqual({ ok: true, value: trace });
    expect(parseTraceText('A, 0, 5').ok).toBe(false);
    expect(parseTraceText('A, x, 5, 2').ok).toBe(false);
  });
});

describe('seeded workloads', () => {
  it('generates identical traces for a seed and different traces for another', () => {
    const params = { count: 20, startMs: 0, meanInterArrivalMs: 50, promptMin: 10, promptMax: 500, outputMin: 1, outputMax: 100 };
    expect(generateTrace(params, 3)).toEqual(generateTrace(params, 3));
    expect(generateTrace(params, 3)).not.toEqual(generateTrace(params, 4));
    expect(generateTrace({ ...params, meanInterArrivalMs: 0 }, 3).every(r => r.arrivalMs === 0)).toBe(true);
  });

  it('computes ln with basic arithmetic only', () => {
    for (const x of [1e-9, 0.001, 0.5, 1, 2, 3.7, 1e6]) expect(deterministicLn(x)).toBeCloseTo(Math.log(x), 12);
  });

  it('orders traces by arrival with stable ties', () => {
    const config = testConfig({ requests: [['late', 9, 1, 1], ['tieA', 2, 1, 1], ['tieB', 2, 1, 1]] });
    expect(buildTrace(config).map(r => r.id)).toEqual(['tieA', 'tieB', 'late']);
  });
});
