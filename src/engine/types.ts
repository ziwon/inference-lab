// Core data types shared by the simulation engine, metrics, serialization, and UI.
// Everything here is plain data so results can be exported, compared, and replayed.

export type PolicyId = 'whole-prefill' | 'chunked-prefill';
export type PanelId = 'A' | 'B';

export interface ArchitectureConfig {
  /** Synthetic preset id, or "custom" after any manual edit. */
  presetId: string;
  /** Total parameter count in billions. */
  paramsBillions: number;
  numLayers: number;
  /** Query heads. Shown for context; KV size depends only on KV heads. */
  numQueryHeads: number;
  /** KV heads. Equal to query heads for MHA, fewer for GQA. */
  numKVHeads: number;
  headDim: number;
  /** Validity limit: every request needs P + G <= maxContextLength. */
  maxContextLength: number;
}

export interface PrecisionConfig {
  weightBits: number;
  /** Extra weight residency for quantization scales and metadata, as a percentage of packed size. */
  weightMetadataPercent: number;
  kvElementBytes: number;
}

export interface MemoryConfig {
  deviceMemoryGiB: number;
  /** Activations, workspaces, graphs, and fragmentation outside the KV pool. */
  runtimeAllowanceGiB: number;
  blockSizeTokens: number;
}

export interface SchedulerConfig {
  /** Cap on admitted, unfinished requests and on requests selected per iteration. */
  maxActiveSequences: number;
  /** Maximum scheduled tokens per iteration (prefill tokens plus one per decode). */
  tokenBudget: number;
  /** Maximum prompt tokens one request may prefill in a single iteration (chunked policy only). */
  maxPrefillChunk: number;
}

export interface CostConfig {
  /** Fixed modeled cost of every nonempty iteration, in modeled ms. */
  iterationOverheadMs: number;
  /** Projection/MLP cost per newly processed token (prefill or decode), in modeled ms. */
  linearMsPerToken: number;
  /** Prefill causal-attention cost per million query-key token pairs, in modeled ms. */
  prefillAttentionMsPerMillionPairs: number;
  /** Decode attention cost per thousand attended KV positions, in modeled ms. */
  decodeAttentionMsPerThousandPositions: number;
}

export interface SloConfig {
  ttftMs: number;
  tpotMs: number;
}

export interface PanelConfig {
  policy: PolicyId;
  /** Per-panel scheduler overrides. Empty means "use the shared scheduler settings". */
  overrides: Partial<SchedulerConfig>;
}

export interface TraceRequest {
  id: string;
  arrivalMs: number;
  promptTokens: number;
  outputTokens: number;
}

export interface GeneratorParams {
  count: number;
  startMs: number;
  /** Mean exponential inter-arrival gap. Zero produces a burst at startMs. */
  meanInterArrivalMs: number;
  promptMin: number;
  promptMax: number;
  outputMin: number;
  outputMax: number;
}

export type WorkloadSpec =
  | { kind: 'explicit'; requests: TraceRequest[] }
  | { kind: 'generated'; params: GeneratorParams };

export interface SimConfig {
  version: 1;
  /** Preset this configuration started from, or null for a custom configuration. */
  scenarioId: string | null;
  seed: number;
  workload: WorkloadSpec;
  architecture: ArchitectureConfig;
  precision: PrecisionConfig;
  memory: MemoryConfig;
  scheduler: SchedulerConfig;
  cost: CostConfig;
  slo: SloConfig;
  panels: { A: PanelConfig; B: PanelConfig };
}

// ---------------------------------------------------------------------------
// Memory model output

export interface MemoryModel {
  weightPackedBytes: number;
  weightMetadataBytes: number;
  weightBytes: number;
  runtimeAllowanceBytes: number;
  deviceBytes: number;
  kvBytesPerToken: number;
  kvBlockBytes: number;
  kvPoolBytes: number;
  totalBlocks: number;
  /** Bytes left over after carving whole blocks out of the pool. */
  unusedTailBytes: number;
}

// ---------------------------------------------------------------------------
// Scheduling records

export type BatchItemKind = 'prefill' | 'decode';

export interface BatchItem {
  req: number;
  kind: BatchItemKind;
  /** Scheduled tokens: chunk length for prefill, 1 for decode. */
  tokens: number;
  /** Populated KV positions before this item runs. */
  contextBefore: number;
  /** True when this prefill chunk completes the prompt and emits the first output token. */
  finalChunk: boolean;
  /** 1-based index of the output token emitted at iteration end, or 0 for a non-final prefill chunk. */
  emitsToken: number;
  /** Why a prefill chunk has this length. */
  limitedBy?: 'whole-prompt' | 'remaining-prompt' | 'chunk-cap' | 'token-budget';
  /** Physical block ids allocated for this item before the iteration ran. */
  newBlocks: number[];
}

export type DecisionCode =
  | 'run-decode'
  | 'run-prefill-whole'
  | 'run-prefill-chunk'
  | 'defer-token-budget'
  | 'defer-sequence-cap'
  | 'defer-fifo'
  | 'queue-sequence-limit'
  | 'queue-kv-reservation'
  | 'queue-head-of-line';

export interface Decision {
  req: number;
  code: DecisionCode;
  /** Tokens scheduled, or tokens the request needed when deferred. */
  tokens?: number;
  /** Remaining token budget or free reservable blocks, depending on the code. */
  available?: number;
  /** Blocks needed by a queued request. */
  neededBlocks?: number;
  /** The request blocking this one (FIFO or head-of-line). */
  blockedBy?: number;
}

export interface CostBreakdown {
  overheadMs: number;
  linearMs: number;
  prefillAttentionMs: number;
  decodeAttentionMs: number;
  totalMs: number;
  prefillPairs: number;
  decodePositions: number;
}

export interface IterationRecord {
  index: number;
  startMs: number;
  endMs: number;
  items: BatchItem[];
  decisions: Decision[];
  /** Waiting requests not listed individually in decisions to keep records small. */
  omittedQueued: number;
  tokenBudget: number;
  tokensScheduled: number;
  sequenceLimit: number;
  sequencesScheduled: number;
  prefillTokens: number;
  decodeTokens: number;
  cost: CostBreakdown;
  /** Pool state while this iteration runs: after allocation, before completion and release. */
  allocatedBlocks: number;
  reservedBlocks: number;
  /** Populated KV positions across live requests at iteration end, before release. */
  cachedTokensAtEnd: number;
}

export type BlockedReason = 'sequence-limit' | 'kv-reservation';

export type FinishStatus = 'completed' | 'blocked';

export type SimEvent =
  | { t: number; type: 'arrival'; req: number }
  | { t: number; type: 'admit'; req: number; reservedBlocks: number; poolReserved: number }
  | { t: number; type: 'admission-blocked'; req: number; reason: BlockedReason; neededBlocks: number; freeBlocks: number; active: number; limit: number }
  | { t: number; type: 'infeasible'; req: number; neededBlocks: number; totalBlocks: number }
  | { t: number; type: 'iteration-start'; iteration: IterationRecord }
  | { t: number; type: 'iteration-end'; index: number; emitted: { req: number; token: number }[] }
  | { t: number; type: 'complete'; req: number }
  | { t: number; type: 'release'; req: number; blocks: number; reservedBlocks: number }
  | { t: number; type: 'idle'; untilMs: number }
  | { t: number; type: 'finished'; status: FinishStatus; reason: string };

export type SimEventType = SimEvent['type'];

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface SimResult {
  panel: PanelId;
  policy: PolicyId;
  scheduler: SchedulerConfig;
  /** 'invalid' means the run did not start; see issues. */
  status: FinishStatus | 'invalid';
  statusReason: string;
  issues: ValidationIssue[];
  trace: TraceRequest[];
  memory: MemoryModel | null;
  events: SimEvent[];
  iterations: IterationRecord[];
  /** Per-request physical block ids in allocation order (for block-map views). */
  blockIds: number[][];
  endMs: number;
  peakAllocatedBlocks: number;
  peakReservedBlocks: number;
}
