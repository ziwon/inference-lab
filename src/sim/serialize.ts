import { type Comparison, buildComparison } from './compare.ts';
import { type Issue, PANEL_IDS, type PanelId, SIMULATOR_VERSION, type SimConfig, parseConfig } from './config.ts';
import { summarize } from './metrics.ts';
import { type Result, err, ok } from './units.ts';

export const EXPORT_SCHEMA = 'inference-viz.run';
export const EXPORT_SCHEMA_VERSION = 1;
export const MAX_SHARE_LENGTH = 8000;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export const MODEL_ASSUMPTIONS = {
  scope: 'One logical GPU, decoder-only Transformer, full attention, MHA/GQA via KV-head count. Educational model, not a hardware benchmark.',
  tokens: 'A final prefill chunk emits the first output token. Each decode consumes the previous token (one KV entry) and emits the next. A request reaches P + G - 1 KV positions before release.',
  kvBytesPerToken: '2 * numLayers * numKvHeads * headDim * kvElementBytes',
  allocation: 'Blocks are allocated per request at iteration start for the tokens the iteration writes. occupiedBlocks = ceil(KV tokens / blockSizeTokens).',
  admission: "Strict FIFO. Admission reserves ceil((P + G - 1) / blockSizeTokens) blocks. This simulator's policy, not vLLM's algorithm.",
  cost: 'duration = overhead + prefillTokenMs * sum(q) + attention * sum(q*c + q(q+1)/2) + decodeSequenceMs * decodes + decodeContext * sum(c + 1). Terms add with no overlap.',
  time: 'Integer microseconds of modeled time. Output tokens are emitted at iteration end.',
  quantiles: 'Nearest rank: the value at rank ceil(p/100 * n) of the sorted sample.',
} as const;

const toBase64Url = (text: string) => {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromBase64Url = (s: string) => {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
};

export function encodeShare(config: SimConfig): Result<string, Issue> {
  const encoded = toBase64Url(JSON.stringify(config));
  if (encoded.length > MAX_SHARE_LENGTH) return err({ path: 'share', code: 'tooLarge', params: { length: encoded.length, max: MAX_SHARE_LENGTH } });
  return ok(encoded);
}

export function decodeShare(param: string): Result<SimConfig, Issue[]> {
  if (param.length > MAX_SHARE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(param)) return err([{ path: 'share', code: 'malformed' }]);
  let data: unknown;
  try {
    data = JSON.parse(fromBase64Url(param));
  } catch {
    return err([{ path: 'share', code: 'malformed' }]);
  }
  return parseConfig(data);
}

export interface ExportDoc {
  schema: typeof EXPORT_SCHEMA;
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  simulatorVersion: string;
  assumptions: typeof MODEL_ASSUMPTIONS;
  config: SimConfig;
  seed: number;
  trace: Comparison['requests'];
  memory: Comparison['memory'];
  panels: Record<PanelId, ReturnType<typeof exportPanel>>;
}

const exportEvents = (run: Comparison['panels'][PanelId]) =>
  run.events.map(e => ('request' in e ? { ...e, request: run.trace[e.request]!.id } : e));

function exportPanel(cmp: Comparison, panel: PanelId) {
  const run = cmp.panels[panel];
  return {
    policy: run.policy,
    limits: run.limits,
    outcome: run.outcome,
    summary: summarize(run, run.final, cmp.config.slo),
    events: exportEvents(run),
    iterations: run.iterations.map(it => ({
      index: it.index,
      startUs: it.startUs,
      endUs: it.endUs,
      entries: it.entries.map(e => ({ request: run.trace[e.request]!.id, kind: e.kind, tokens: e.tokens, cachedBefore: e.cachedBefore, newBlocks: e.newBlocks, reason: e.reason })),
      skipped: it.skipped.map(s => ({ request: run.trace[s.request]!.id, kind: s.kind, reason: s.reason })),
      cost: it.cost,
    })),
  };
}

export function exportRun(cmp: Comparison): ExportDoc {
  return {
    schema: EXPORT_SCHEMA,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    simulatorVersion: SIMULATOR_VERSION,
    assumptions: MODEL_ASSUMPTIONS,
    config: cmp.config,
    seed: cmp.config.seed,
    trace: cmp.requests,
    memory: cmp.memory,
    panels: { A: exportPanel(cmp, 'A'), B: exportPanel(cmp, 'B') },
  };
}

export interface Imported {
  comparison: Comparison;
  history: 'matches' | 'differs' | 'absent';
}

export function importText(text: string): Result<Imported, Issue[]> {
  if (text.length > MAX_IMPORT_BYTES) return err([{ path: 'import', code: 'tooLarge', params: { length: text.length, max: MAX_IMPORT_BYTES } }]);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return err([{ path: 'import', code: 'malformed' }]);
  }
  if (typeof data !== 'object' || data === null) return err([{ path: 'import', code: 'malformed' }]);
  const doc = data as Partial<Record<keyof ExportDoc, unknown>>;
  const isExport = doc.schema === EXPORT_SCHEMA;
  if (isExport && doc.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    return err([{ path: 'import.schemaVersion', code: 'unsupportedVersion', params: { expected: EXPORT_SCHEMA_VERSION } }]);
  }
  const parsed = parseConfig(isExport ? doc.config : data);
  if (!parsed.ok) return parsed;
  const built = buildComparison(parsed.value);
  if (!built.ok) return built;
  let history: Imported['history'] = 'absent';
  const panels = doc.panels as Partial<Record<PanelId, { events?: unknown }>> | undefined;
  if (isExport && panels) {
    const same = PANEL_IDS.every(p => JSON.stringify(panels[p]?.events) === JSON.stringify(exportEvents(built.value.panels[p])));
    history = same ? 'matches' : 'differs';
  }
  return ok({ comparison: built.value, history });
}
