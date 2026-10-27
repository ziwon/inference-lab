import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComparison } from './compare.ts';
import { parseConfig } from './config.ts';
import { scenario } from './scenarios.ts';
import { MAX_SHARE_LENGTH, decodeShare, encodeShare, exportRun, importText } from './serialize.ts';
import { build, fixture, r } from './test-fixtures.ts';

test('share links round-trip a validated configuration and seed', () => {
  for (const id of ['long-prefill', 'kv-pressure'] as const) {
    const config = scenario(id).config;
    const encoded = encodeShare(config);
    assert.ok(encoded.ok);
    const decoded = decodeShare(encoded.value);
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.value, config);
  }
});

test('malformed or oversized share parameters fail gracefully', () => {
  assert.equal(decodeShare('not base64 !').ok, false);
  assert.equal(decodeShare('e30').ok, false, '{} has no version');
  assert.equal(decodeShare('A'.repeat(MAX_SHARE_LENGTH + 1)).ok, false);
  const big = fixture({ trace: Array.from({ length: 400 }, (_, i) => r(`request-${i}`, i, 100, 10)) });
  const share = encodeShare(big);
  assert.equal(share.ok, false);
  assert.equal(!share.ok && share.error.code, 'tooLarge');
});

test('export then import rebuilds the same run and verifies the event history', () => {
  const cmp = build(scenario('burst').config);
  const text = JSON.stringify(exportRun(cmp));
  const imported = importText(text);
  assert.ok(imported.ok);
  assert.equal(imported.value.history, 'matches');
  assert.deepEqual(imported.value.comparison.config, cmp.config);
  assert.deepEqual(JSON.parse(text).trace, cmp.requests);
});

test('exported events name the same request as the exported iterations when the trace is not in arrival order', () => {
  const doc = exportRun(build(fixture({ trace: [r('late', 50, 8, 2), r('early', 0, 4, 3)] })));
  const arrivals = doc.panels.A.events.flatMap(e => (e.kind === 'arrived' ? [[e.timeUs, e.request]] : []));
  assert.deepEqual(arrivals, [[0, 'early'], [50_000, 'late']]);
  const firstEntry = doc.panels.A.iterations[0]!.entries[0]!.request;
  assert.equal(firstEntry, 'early');
});

test('an export records versions, assumptions, configuration, seed, trace, events, and summaries', () => {
  const doc = exportRun(build(scenario('edge-cases').config));
  assert.equal(doc.schema, 'inference-viz.run');
  assert.equal(doc.schemaVersion, 1);
  assert.equal(typeof doc.simulatorVersion, 'string');
  assert.ok(doc.assumptions.kvBytesPerToken.includes('numKvHeads'));
  assert.equal(doc.seed, doc.config.seed);
  assert.equal(doc.trace.length, 4);
  assert.ok(doc.panels.A.events.length > 0);
  assert.equal(doc.panels.B.summary.counts.infeasible, 1);
});

test('a tampered event history is reported, and a bare configuration imports', () => {
  const doc = exportRun(build(scenario('long-prefill').config));
  doc.panels.A.events = doc.panels.A.events.slice(1);
  const tampered = importText(JSON.stringify(doc));
  assert.ok(tampered.ok);
  assert.equal(tampered.value.history, 'differs');
  const bare = importText(JSON.stringify(scenario('long-prefill').config));
  assert.ok(bare.ok);
  assert.equal(bare.value.history, 'absent');
});

test('imports are parsed as data: markup, wrong types, and junk are rejected', () => {
  assert.equal(importText('<script>alert(1)</script>').ok, false);
  assert.equal(importText('null').ok, false);
  const config = scenario('long-prefill').config;
  const withMarkup = { ...config, architecture: { ...config.architecture, label: '<img src=x onerror=alert(1)>' } };
  const parsed = parseConfig(withMarkup);
  assert.equal(parsed.ok, false);
  assert.equal(!parsed.ok && parsed.error[0]!.code, 'badText');
  const wrong = parseConfig({ ...config, scheduler: { ...config.scheduler, maxBatchTokens: '8192' } });
  assert.deepEqual(!wrong.ok && wrong.error, [{ path: 'scheduler.maxBatchTokens', code: 'notNumber' }]);
});

test('validation rejects context overruns, zero-duration cost, and impossible head counts', () => {
  const config = scenario('long-prefill').config;
  const tooLong = parseConfig({ ...config, trace: { kind: 'explicit', requests: [r('x', 0, 8000, 500)] } });
  assert.equal(!tooLong.ok && tooLong.error[0]!.code, 'contextExceeded');
  const zero = buildComparison({ ...config, cost: { overheadMs: 0, prefillTokenMs: 0, attentionMsPerMillionPairs: 0, decodeSequenceMs: 0, decodeContextMsPerThousandTokens: 0 } });
  assert.deepEqual(!zero.ok && zero.error.map(i => i.params?.kind), ['prefill', 'decode']);
  const heads = parseConfig({ ...config, architecture: { ...config.architecture, numKvHeads: 64 } });
  assert.equal(!heads.ok && heads.error[0]!.code, 'kvHeadsExceedQueryHeads');
  const dup = parseConfig({ ...config, trace: { kind: 'explicit', requests: [r('x', 0, 10, 2), r('x', 1, 10, 2)] } });
  assert.equal(!dup.ok && dup.error[0]!.code, 'duplicateId');
});
