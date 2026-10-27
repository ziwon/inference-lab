import { CONFIG_VERSION, LIMITS, POLICIES, SIMULATOR_VERSION, validateConfig, validateTrace } from './config';
import { requestMetrics, summarize } from './metrics';
import { isScenarioId, scenarioConfig, type ScenarioId } from './scenarios';
import type { GeneratorParams, PanelConfig, PolicyId, SchedulerConfig, SimConfig, SimResult, TraceRequest, WorkloadSpec } from './types';
import { buildTrace } from './workload';

// Share links and JSON files are parsed as plain data: known keys are read one by one,
// types are checked, and the result is validated before it reaches the simulator.

export const EXPORT_SCHEMA_VERSION = 1;
export const MAX_SHARE_TRACE_REQUESTS = 64;
export const MAX_SHARE_PARAM_LENGTH = 12_000;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

class SchemaError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SchemaError(`${path} must be an object.`);
  return value;
}
function num(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError(`${path}.${key} must be a finite number.`);
  return value;
}
function optionalNum(source: Record<string, unknown>, key: string, path: string): number | undefined {
  return source[key] === undefined ? undefined : num(source, key, path);
}
function str(source: Record<string, unknown>, key: string, path: string, max = 64): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(`${path}.${key} must be a string of at most ${max} characters.`);
  return value;
}

function parsePolicy(value: unknown, path: string): PolicyId {
  if ((POLICIES as readonly unknown[]).includes(value)) return value as PolicyId;
  throw new SchemaError(`${path} must be one of ${POLICIES.map(p => `"${p}"`).join(', ')}.`);
}

function parsePanel(value: unknown, path: string): PanelConfig {
  const source = record(value, path);
  const overridesSource = source.overrides === undefined ? {} : record(source.overrides, `${path}.overrides`);
  const overrides: Partial<SchedulerConfig> = {};
  for (const key of ['maxActiveSequences', 'tokenBudget', 'maxPrefillChunk'] as const) {
    const v = optionalNum(overridesSource, key, `${path}.overrides`);
    if (v !== undefined) overrides[key] = v;
  }
  return { policy: parsePolicy(source.policy, `${path}.policy`), overrides };
}

export function parseTraceRequests(value: unknown, path = 'workload.requests'): TraceRequest[] {
  if (!Array.isArray(value)) throw new SchemaError(`${path} must be an array.`);
  if (value.length > LIMITS.maxRequests) throw new SchemaError(`${path} has ${value.length} requests; the limit is ${LIMITS.maxRequests}.`);
  return value.map((item, i) => {
    const r = record(item, `${path}[${i}]`);
    return {
      id: str(r, 'id', `${path}[${i}]`, 24),
      arrivalMs: num(r, 'arrivalMs', `${path}[${i}]`),
      promptTokens: num(r, 'promptTokens', `${path}[${i}]`),
      outputTokens: num(r, 'outputTokens', `${path}[${i}]`),
    };
  });
}

function parseWorkload(value: unknown): WorkloadSpec {
  const source = record(value, 'workload');
  if (source.kind === 'explicit') return { kind: 'explicit', requests: parseTraceRequests(source.requests) };
  if (source.kind === 'generated') {
    const p = record(source.params, 'workload.params');
    const params: GeneratorParams = {
      count: num(p, 'count', 'workload.params'),
      startMs: num(p, 'startMs', 'workload.params'),
      meanInterArrivalMs: num(p, 'meanInterArrivalMs', 'workload.params'),
      promptMin: num(p, 'promptMin', 'workload.params'),
      promptMax: num(p, 'promptMax', 'workload.params'),
      outputMin: num(p, 'outputMin', 'workload.params'),
      outputMax: num(p, 'outputMax', 'workload.params'),
    };
    return { kind: 'generated', params };
  }
  throw new SchemaError('workload.kind must be "explicit" or "generated".');
}

/** Structural parse plus validation. Panel compatibility is reported later by the simulator. */
export function parseConfig(raw: unknown): ParseResult<SimConfig> {
  try {
    const root = record(raw, 'config');
    if (root.version !== CONFIG_VERSION) throw new SchemaError(`Unsupported configuration version ${String(root.version)}; expected ${CONFIG_VERSION}.`);
    const scenarioId = root.scenarioId === null || root.scenarioId === undefined ? null : str(root, 'scenarioId', 'config', 32);
    const a = record(root.architecture, 'architecture');
    const p = record(root.precision, 'precision');
    const m = record(root.memory, 'memory');
    const s = record(root.scheduler, 'scheduler');
    const c = record(root.cost, 'cost');
    const slo = record(root.slo, 'slo');
    const panels = record(root.panels, 'panels');
    const config: SimConfig = {
      version: 1,
      scenarioId: scenarioId && isScenarioId(scenarioId) ? scenarioId : null,
      seed: num(root, 'seed', 'config'),
      workload: parseWorkload(root.workload),
      architecture: {
        presetId: str(a, 'presetId', 'architecture', 32),
        paramsBillions: num(a, 'paramsBillions', 'architecture'),
        numLayers: num(a, 'numLayers', 'architecture'),
        numQueryHeads: num(a, 'numQueryHeads', 'architecture'),
        numKVHeads: num(a, 'numKVHeads', 'architecture'),
        headDim: num(a, 'headDim', 'architecture'),
        maxContextLength: num(a, 'maxContextLength', 'architecture'),
      },
      precision: {
        weightBits: num(p, 'weightBits', 'precision'),
        weightMetadataPercent: num(p, 'weightMetadataPercent', 'precision'),
        kvElementBytes: num(p, 'kvElementBytes', 'precision'),
      },
      memory: {
        deviceMemoryGiB: num(m, 'deviceMemoryGiB', 'memory'),
        runtimeAllowanceGiB: num(m, 'runtimeAllowanceGiB', 'memory'),
        blockSizeTokens: num(m, 'blockSizeTokens', 'memory'),
      },
      scheduler: {
        maxActiveSequences: num(s, 'maxActiveSequences', 'scheduler'),
        tokenBudget: num(s, 'tokenBudget', 'scheduler'),
        maxPrefillChunk: num(s, 'maxPrefillChunk', 'scheduler'),
      },
      cost: {
        iterationOverheadMs: num(c, 'iterationOverheadMs', 'cost'),
        linearMsPerToken: num(c, 'linearMsPerToken', 'cost'),
        prefillAttentionMsPerMillionPairs: num(c, 'prefillAttentionMsPerMillionPairs', 'cost'),
        decodeAttentionMsPerThousandPositions: num(c, 'decodeAttentionMsPerThousandPositions', 'cost'),
      },
      slo: { ttftMs: num(slo, 'ttftMs', 'slo'), tpotMs: num(slo, 'tpotMs', 'slo') },
      panels: { A: parsePanel(panels.A, 'panels.A'), B: parsePanel(panels.B, 'panels.B') },
    };
    const issues = validateConfig(config);
    if (issues.length > 0) return { ok: false, error: issues[0].message };
    const traceIssues = validateTrace(buildTrace(config), config.architecture.maxContextLength);
    if (traceIssues.length > 0) return { ok: false, error: traceIssues[0].message };
    return { ok: true, value: config };
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, error: error.message };
    return { ok: false, error: 'The configuration could not be read.' };
  }
}

// ---------------------------------------------------------------------------
// Share URLs

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new SchemaError('The shared configuration is not valid base64url.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function configsEqual(a: SimConfig, b: SimConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Returns query parameters for a share link, or an error when the configuration is too large. */
export function encodeShareParams(config: SimConfig): ParseResult<URLSearchParams> {
  const params = new URLSearchParams();
  if (config.scenarioId && isScenarioId(config.scenarioId) && configsEqual(config, scenarioConfig(config.scenarioId))) {
    params.set('scenario', config.scenarioId);
    return { ok: true, value: params };
  }
  if (config.workload.kind === 'explicit' && config.workload.requests.length > MAX_SHARE_TRACE_REQUESTS) {
    return { ok: false, error: `Custom traces with more than ${MAX_SHARE_TRACE_REQUESTS} requests are too large for a link. Use Export JSON instead.` };
  }
  const encoded = toBase64Url(JSON.stringify(config));
  if (encoded.length > MAX_SHARE_PARAM_LENGTH) return { ok: false, error: 'This configuration is too large for a link. Use Export JSON instead.' };
  params.set('v', String(CONFIG_VERSION));
  params.set('cfg', encoded);
  return { ok: true, value: params };
}

export type ShareDecode = { kind: 'none' } | { kind: 'scenario'; id: ScenarioId; config: SimConfig } | { kind: 'config'; config: SimConfig } | { kind: 'error'; error: string };

export function decodeShareParams(search: string): ShareDecode {
  const params = new URLSearchParams(search);
  const cfg = params.get('cfg');
  if (cfg !== null) {
    if (cfg.length > MAX_SHARE_PARAM_LENGTH) return { kind: 'error', error: 'The shared configuration is too large.' };
    const version = params.get('v');
    if (version !== null && version !== String(CONFIG_VERSION)) return { kind: 'error', error: `Unsupported share link version ${version}.` };
    try {
      const parsed = parseConfig(JSON.parse(fromBase64Url(cfg)));
      return parsed.ok ? { kind: 'config', config: parsed.value } : { kind: 'error', error: parsed.error };
    } catch (error) {
      return { kind: 'error', error: error instanceof SchemaError ? error.message : 'The shared configuration could not be decoded.' };
    }
  }
  const scenario = params.get('scenario');
  if (scenario !== null) {
    return isScenarioId(scenario) ? { kind: 'scenario', id: scenario, config: scenarioConfig(scenario) } : { kind: 'error', error: `Unknown scenario "${scenario.slice(0, 32)}".` };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// JSON export / import

export const MODEL_ASSUMPTIONS: readonly string[] = [
  'Educational simulation of one logical GPU; no model, GPU kernel, or inference API is executed.',
  'Decoder-only Transformer with full attention (MHA/GQA). Excludes MLA, sliding-window attention, recurrent/hybrid models, sharding, and prefix sharing.',
  'kvBytesPerToken = 2 * layers * kvHeads * headDim * kvElementBytes. Weight precision does not change KV precision or compute cost.',
  'Admission reserves ceil((P + G - 1) / blockSize) blocks per request (FIFO). Reservation is accounting, not physical allocation. This is this simulator\'s policy, not vLLM\'s admission algorithm.',
  'Exactly G output tokens per request; the final prefill chunk emits token 1; each decode consumes the previous token and emits the next.',
  'Iteration duration (modeled ms) = overhead + linear * tokens + prefillAttention * pairs / 1e6 + decodeAttention * positions / 1e3, summed with no overlap. Coefficients are illustrative, not measurements.',
  'Percentiles use the nearest-rank method. Throughput uses the window from first arrival to the last event observed.',
];

export interface ExportPanel {
  panel: 'A' | 'B';
  policy: PolicyId;
  scheduler: SchedulerConfig;
  status: SimResult['status'];
  statusReason: string;
  issues: SimResult['issues'];
  memory: SimResult['memory'];
  summary: ReturnType<typeof summarize> | null;
  requests: ReturnType<typeof requestMetrics>;
  eventDigest: string;
  events: SimResult['events'];
}

export interface ExportDocument {
  schemaVersion: number;
  simulatorVersion: string;
  kind: 'inference-lab-export';
  assumptions: readonly string[];
  config: SimConfig;
  seed: number;
  trace: TraceRequest[];
  panels: ExportPanel[];
}

/** FNV-1a 32-bit digest of the event log, for quick replay comparison. */
export function digestEvents(events: SimResult['events']): string {
  const text = JSON.stringify(events);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildExport(config: SimConfig, results: { A: SimResult; B: SimResult }): ExportDocument {
  const panels = (['A', 'B'] as const).map((panel): ExportPanel => {
    const result = results[panel];
    const valid = result.status !== 'invalid';
    return {
      panel,
      policy: result.policy,
      scheduler: result.scheduler,
      status: result.status,
      statusReason: result.statusReason,
      issues: result.issues,
      memory: result.memory,
      summary: valid ? summarize(result, config.slo) : null,
      requests: valid ? requestMetrics(result, config.slo) : [],
      eventDigest: digestEvents(result.events),
      events: result.events,
    };
  });
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    simulatorVersion: SIMULATOR_VERSION,
    kind: 'inference-lab-export',
    assumptions: MODEL_ASSUMPTIONS,
    config,
    seed: config.seed,
    trace: buildTrace(config),
    panels,
  };
}

export interface ImportedDocument {
  config: SimConfig;
  /** Event digests recorded in the file, used to warn when a re-simulation differs. */
  digests: Partial<Record<'A' | 'B', string>>;
  simulatorVersion: string | null;
}

/**
 * Accepts a full export or a bare configuration object. The file's events are never
 * trusted; the configuration is re-simulated locally and digests are compared.
 */
export function parseImport(text: string): ParseResult<ImportedDocument> {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: 'The file is larger than 8 MiB.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'The file must contain a JSON object.' };
  if (raw.kind === 'inference-lab-export') {
    if (raw.schemaVersion !== EXPORT_SCHEMA_VERSION) return { ok: false, error: `Unsupported export schema version ${String(raw.schemaVersion)}.` };
    const parsed = parseConfig(raw.config);
    if (!parsed.ok) return parsed;
    const digests: ImportedDocument['digests'] = {};
    if (Array.isArray(raw.panels)) {
      for (const panel of raw.panels) {
        if (isRecord(panel) && (panel.panel === 'A' || panel.panel === 'B') && typeof panel.eventDigest === 'string' && /^[0-9a-f]{8}$/.test(panel.eventDigest)) {
          digests[panel.panel] = panel.eventDigest;
        }
      }
    }
    const version = typeof raw.simulatorVersion === 'string' && raw.simulatorVersion.length <= 32 ? raw.simulatorVersion : null;
    return { ok: true, value: { config: parsed.value, digests, simulatorVersion: version } };
  }
  const parsed = parseConfig(raw);
  return parsed.ok ? { ok: true, value: { config: parsed.value, digests: {}, simulatorVersion: null } } : parsed;
}

// ---------------------------------------------------------------------------
// Compact text format for small custom traces: "id, arrival_ms, prompt_tokens, output_tokens"

export function traceToText(trace: readonly TraceRequest[]): string {
  return ['# id, arrival_ms, prompt_tokens, output_tokens', ...trace.map(r => `${r.id}, ${r.arrivalMs}, ${r.promptTokens}, ${r.outputTokens}`)].join('\n');
}

export function parseTraceText(text: string): ParseResult<TraceRequest[]> {
  if (text.length > 200_000) return { ok: false, error: 'The trace text is too long. Import a JSON file instead.' };
  const requests: TraceRequest[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/[,\t]/).map(part => part.trim());
    if (parts.length !== 4) return { ok: false, error: `Line ${i + 1}: expected 4 comma-separated values.` };
    const [id, arrival, prompt, output] = parts;
    const numbers = [arrival, prompt, output].map(Number);
    if (numbers.some(n => !Number.isFinite(n)) || [arrival, prompt, output].some(v => v === '')) return { ok: false, error: `Line ${i + 1}: arrival, prompt, and output must be numbers.` };
    requests.push({ id, arrivalMs: numbers[0], promptTokens: numbers[1], outputTokens: numbers[2] });
    if (requests.length > LIMITS.maxRequests) return { ok: false, error: `Traces are limited to ${LIMITS.maxRequests} requests.` };
  }
  return { ok: true, value: requests };
}
