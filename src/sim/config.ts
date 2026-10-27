import { GIB, type Result, err, ok } from './units.ts';

export const CONFIG_VERSION = 1;
export const SIMULATOR_VERSION = '1.0.0';

export const POLICY_IDS = ['whole-prefill', 'chunked-prefill'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

export const PANEL_IDS = ['A', 'B'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const WEIGHT_BITS = [4, 8, 16] as const;
export const KV_ELEMENT_BYTES = [1, 2, 4] as const;
export const ARRIVAL_PATTERNS = ['uniform', 'jittered', 'burst'] as const;
export type ArrivalPattern = (typeof ARRIVAL_PATTERNS)[number];

export interface Architecture {
  label: string;
  parameterCount: number;
  numLayers: number;
  numQueryHeads: number;
  numKvHeads: number;
  headDim: number;
  maxContextTokens: number;
}

export interface MemoryConfig {
  deviceBytes: number;
  weightBits: number;
  /** Declared allowance for quantization scales, zero points, and other weight metadata, as a percent of packed weights. */
  weightMetadataPercent: number;
  runtimeAllowanceBytes: number;
  kvElementBytes: number;
  blockSizeTokens: number;
}

export interface SchedulerLimits {
  maxActiveSequences: number;
  maxBatchTokens: number;
  maxPrefillChunkTokens: number;
}

export interface CostModel {
  overheadMs: number;
  prefillTokenMs: number;
  attentionMsPerMillionPairs: number;
  decodeSequenceMs: number;
  decodeContextMsPerThousandTokens: number;
}

export interface Slo {
  ttftMs: number;
  tpotMs: number;
}

export interface TraceRequest {
  id: string;
  arrivalMs: number;
  promptTokens: number;
  outputTokens: number;
}

export interface IntRange {
  min: number;
  max: number;
}

export type TraceSpec =
  | { kind: 'explicit'; requests: TraceRequest[] }
  | { kind: 'generated'; count: number; pattern: ArrivalPattern; spanMs: number; promptTokens: IntRange; outputTokens: IntRange };

export interface PanelSpec {
  policy: PolicyId;
  overrides: Partial<SchedulerLimits>;
}

export interface SimConfig {
  version: typeof CONFIG_VERSION;
  seed: number;
  architecture: Architecture;
  memory: MemoryConfig;
  scheduler: SchedulerLimits;
  cost: CostModel;
  slo: Slo;
  trace: TraceSpec;
  panels: Record<PanelId, PanelSpec>;
}

export const LIMITS = {
  requests: 512,
  promptTokens: 131_072,
  outputTokens: 16_384,
  contextTokens: 262_144,
  arrivalMs: 3_600_000,
  idLength: 24,
} as const;

export const ARCHITECTURE_PRESETS = [
  { id: 'syn-8b-gqa', arch: { label: 'Synthetic 8B, GQA 32/8', parameterCount: 8e9, numLayers: 32, numQueryHeads: 32, numKvHeads: 8, headDim: 128, maxContextTokens: 8192 } },
  { id: 'syn-3b-mha', arch: { label: 'Synthetic 3B, MHA 24/24', parameterCount: 3e9, numLayers: 28, numQueryHeads: 24, numKvHeads: 24, headDim: 128, maxContextTokens: 8192 } },
  { id: 'syn-70b-gqa', arch: { label: 'Synthetic 70B, GQA 64/8', parameterCount: 70e9, numLayers: 80, numQueryHeads: 64, numKvHeads: 8, headDim: 128, maxContextTokens: 8192 } },
] as const satisfies readonly { id: string; arch: Architecture }[];

export const DEFAULT_COST: CostModel = {
  overheadMs: 4,
  prefillTokenMs: 0.02,
  attentionMsPerMillionPairs: 2,
  decodeSequenceMs: 0.2,
  decodeContextMsPerThousandTokens: 0.4,
};

export function resolveLimits(config: SimConfig, panel: PanelId): SchedulerLimits {
  return { ...config.scheduler, ...config.panels[panel].overrides };
}

export type IssueCode =
  | 'malformed'
  | 'unsupportedVersion'
  | 'notObject'
  | 'notNumber'
  | 'notInteger'
  | 'outOfRange'
  | 'notOneOf'
  | 'badText'
  | 'tooMany'
  | 'empty'
  | 'duplicateId'
  | 'rangeInverted'
  | 'contextExceeded'
  | 'weightsDoNotFit'
  | 'noKvBlocks'
  | 'zeroDurationWork'
  | 'promptExceedsWholePrefillBudget'
  | 'kvHeadsExceedQueryHeads'
  | 'tooLarge';

export interface Issue {
  path: string;
  code: IssueCode;
  params?: Record<string, number | string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Reader {
  issues: Issue[] = [];
  obj(v: unknown, path: string): Obj {
    if (isObj(v)) return v;
    this.issues.push({ path, code: 'notObject' });
    return {};
  }
  num(o: Obj, key: string, path: string, min: number, max: number, integer = false): number {
    const v = o[key];
    const at = `${path}.${key}`;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.issues.push({ path: at, code: 'notNumber' });
      return min;
    }
    if (integer && !Number.isInteger(v)) this.issues.push({ path: at, code: 'notInteger' });
    else if (v < min || v > max) this.issues.push({ path: at, code: 'outOfRange', params: { min, max } });
    return v;
  }
  int(o: Obj, key: string, path: string, min: number, max: number) {
    return this.num(o, key, path, min, max, true);
  }
  oneOf<T extends string | number>(o: Obj, key: string, path: string, options: readonly T[]): T {
    const v = o[key];
    if ((options as readonly unknown[]).includes(v)) return v as T;
    this.issues.push({ path: `${path}.${key}`, code: 'notOneOf', params: { options: options.join(', ') } });
    return options[0] as T;
  }
  text(o: Obj, key: string, path: string, maxLength: number, pattern?: RegExp): string {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > maxLength || (pattern && !pattern.test(v))) {
      this.issues.push({ path: `${path}.${key}`, code: 'badText', params: { maxLength } });
      return '';
    }
    return v;
  }
  range(o: Obj, key: string, path: string, min: number, max: number): IntRange {
    const r = this.obj(o[key], `${path}.${key}`);
    const out = { min: this.int(r, 'min', `${path}.${key}`, min, max), max: this.int(r, 'max', `${path}.${key}`, min, max) };
    if (out.min > out.max) this.issues.push({ path: `${path}.${key}`, code: 'rangeInverted' });
    return out;
  }
}

const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const LABEL_PATTERN = /^[^<>]+$/;

/** Parses untrusted data (URL, import, form state) into a structurally valid configuration. */
export function parseConfig(input: unknown): Result<SimConfig, Issue[]> {
  const r = new Reader();
  const root = r.obj(input, 'config');
  if (root.version !== CONFIG_VERSION) return err([{ path: 'config.version', code: 'unsupportedVersion', params: { expected: CONFIG_VERSION } }]);

  const a = r.obj(root.architecture, 'architecture');
  const architecture: Architecture = {
    label: r.text(a, 'label', 'architecture', 64, LABEL_PATTERN),
    parameterCount: r.num(a, 'parameterCount', 'architecture', 1e6, 2e12),
    numLayers: r.int(a, 'numLayers', 'architecture', 1, 256),
    numQueryHeads: r.int(a, 'numQueryHeads', 'architecture', 1, 512),
    numKvHeads: r.int(a, 'numKvHeads', 'architecture', 1, 512),
    headDim: r.int(a, 'headDim', 'architecture', 1, 1024),
    maxContextTokens: r.int(a, 'maxContextTokens', 'architecture', 2, LIMITS.contextTokens),
  };
  if (architecture.numKvHeads > architecture.numQueryHeads) r.issues.push({ path: 'architecture.numKvHeads', code: 'kvHeadsExceedQueryHeads' });

  const m = r.obj(root.memory, 'memory');
  const memory: MemoryConfig = {
    deviceBytes: r.num(m, 'deviceBytes', 'memory', 1 * GIB, 1024 * GIB),
    weightBits: r.oneOf(m, 'weightBits', 'memory', WEIGHT_BITS),
    weightMetadataPercent: r.num(m, 'weightMetadataPercent', 'memory', 0, 100),
    runtimeAllowanceBytes: r.num(m, 'runtimeAllowanceBytes', 'memory', 0, 1024 * GIB),
    kvElementBytes: r.oneOf(m, 'kvElementBytes', 'memory', KV_ELEMENT_BYTES),
    blockSizeTokens: r.int(m, 'blockSizeTokens', 'memory', 1, 512),
  };

  const scheduler = readLimits(r, r.obj(root.scheduler, 'scheduler'), 'scheduler', false) as SchedulerLimits;

  const c = r.obj(root.cost, 'cost');
  const cost: CostModel = {
    overheadMs: r.num(c, 'overheadMs', 'cost', 0, 10_000),
    prefillTokenMs: r.num(c, 'prefillTokenMs', 'cost', 0, 1_000),
    attentionMsPerMillionPairs: r.num(c, 'attentionMsPerMillionPairs', 'cost', 0, 10_000),
    decodeSequenceMs: r.num(c, 'decodeSequenceMs', 'cost', 0, 1_000),
    decodeContextMsPerThousandTokens: r.num(c, 'decodeContextMsPerThousandTokens', 'cost', 0, 1_000),
  };

  const s = r.obj(root.slo, 'slo');
  const slo: Slo = { ttftMs: r.num(s, 'ttftMs', 'slo', 0, 3_600_000), tpotMs: r.num(s, 'tpotMs', 'slo', 0, 3_600_000) };

  const trace = readTrace(r, r.obj(root.trace, 'trace'), architecture.maxContextTokens);

  const p = r.obj(root.panels, 'panels');
  const panels = {} as Record<PanelId, PanelSpec>;
  for (const id of PANEL_IDS) {
    const po = r.obj(p[id], `panels.${id}`);
    panels[id] = {
      policy: r.oneOf(po, 'policy', `panels.${id}`, POLICY_IDS),
      overrides: readLimits(r, po.overrides === undefined ? {} : r.obj(po.overrides, `panels.${id}.overrides`), `panels.${id}.overrides`, true),
    };
  }

  const seed = r.int(root, 'seed', 'config', 0, 2 ** 32 - 1);
  if (r.issues.length > 0) return err(r.issues);
  return ok({ version: CONFIG_VERSION, seed, architecture, memory, scheduler, cost, slo, trace, panels });
}

const LIMIT_RANGES: Record<keyof SchedulerLimits, [number, number]> = {
  maxActiveSequences: [1, 1024],
  maxBatchTokens: [1, 262_144],
  maxPrefillChunkTokens: [1, 262_144],
};

function readLimits(r: Reader, o: Obj, path: string, partial: boolean): Partial<SchedulerLimits> {
  const out: Partial<SchedulerLimits> = {};
  for (const key of Object.keys(LIMIT_RANGES) as (keyof SchedulerLimits)[]) {
    if (partial && o[key] === undefined) continue;
    const [min, max] = LIMIT_RANGES[key];
    out[key] = r.int(o, key, path, min, max);
  }
  return out;
}

function readTrace(r: Reader, t: Obj, maxContext: number): TraceSpec {
  if (t.kind === 'generated') {
    const spec: TraceSpec = {
      kind: 'generated',
      count: r.int(t, 'count', 'trace', 1, LIMITS.requests),
      pattern: r.oneOf(t, 'pattern', 'trace', ARRIVAL_PATTERNS),
      spanMs: r.num(t, 'spanMs', 'trace', 0, LIMITS.arrivalMs),
      promptTokens: r.range(t, 'promptTokens', 'trace', 1, LIMITS.promptTokens),
      outputTokens: r.range(t, 'outputTokens', 'trace', 1, LIMITS.outputTokens),
    };
    const longest = spec.promptTokens.max + spec.outputTokens.max;
    if (longest > maxContext) r.issues.push({ path: 'trace', code: 'contextExceeded', params: { id: 'longest generated', total: longest, max: maxContext } });
    return spec;
  }
  if (t.kind !== 'explicit') {
    r.issues.push({ path: 'trace.kind', code: 'notOneOf', params: { options: 'explicit, generated' } });
    return { kind: 'explicit', requests: [] };
  }
  const list = t.requests;
  if (!Array.isArray(list)) {
    r.issues.push({ path: 'trace.requests', code: 'notObject' });
    return { kind: 'explicit', requests: [] };
  }
  if (list.length === 0) r.issues.push({ path: 'trace.requests', code: 'empty' });
  if (list.length > LIMITS.requests) {
    r.issues.push({ path: 'trace.requests', code: 'tooMany', params: { max: LIMITS.requests } });
    return { kind: 'explicit', requests: [] };
  }
  const seen = new Set<string>();
  const requests = list.map((item, i): TraceRequest => {
    const path = `trace.requests[${i}]`;
    const o = r.obj(item, path);
    const req = {
      id: r.text(o, 'id', path, LIMITS.idLength, ID_PATTERN),
      arrivalMs: r.num(o, 'arrivalMs', path, 0, LIMITS.arrivalMs),
      promptTokens: r.int(o, 'promptTokens', path, 1, LIMITS.promptTokens),
      outputTokens: r.int(o, 'outputTokens', path, 1, LIMITS.outputTokens),
    };
    if (req.id && seen.has(req.id)) r.issues.push({ path: `${path}.id`, code: 'duplicateId', params: { id: req.id } });
    seen.add(req.id);
    const total = req.promptTokens + req.outputTokens;
    if (total > maxContext) r.issues.push({ path, code: 'contextExceeded', params: { id: req.id, total, max: maxContext } });
    return req;
  });
  return { kind: 'explicit', requests };
}
