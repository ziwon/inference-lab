import type { IssueCode, PolicyId, SchedulerLimits } from '../sim/config.ts';
import type { WaitReason } from '../sim/inspect.ts';
import type { RequestStatus } from '../sim/metrics.ts';
import type { ScenarioId } from '../sim/scenarios.ts';
import type { Command } from './Shortcuts.tsx';
import type { EntryReason, SkipReason } from '../sim/scheduler.ts';
import type { InfeasibleReason, Phase, RunOutcome } from '../sim/state.ts';

type Params = Record<string, number | string> | undefined;

const iterationNumber = (index: number) => index + 1;
const count = (n: number, singular: string, plural = `${singular}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
type Catalog<U extends { code: string }> = { [C in U['code']]: (r: Extract<U, { code: C }>, id: (i: number) => string) => string };

export const S = {
  app: {
    title: 'Inference Lab',
    tagline: 'Requests, batching, and paged KV cache, one iteration at a time.',
    disclaimer: 'Educational model, not a hardware benchmark',
    modelButton: 'Model assumptions',
    shortcutsButton: 'Keyboard shortcuts',
    importButton: 'Import',
    exportButton: 'Export JSON',
    shareButton: 'Share link',
    shareCopied: 'Link copied. It encodes this configuration and seed.',
    shareUpdated: 'Address bar updated with a share link. Copying to the clipboard was blocked.',
    exported: 'Exported the configuration, trace, events, and summaries as JSON.',
    importOk: (history: 'matches' | 'differs' | 'absent') =>
      history === 'matches' ? 'Imported. The file’s event history matches the rebuild.'
      : history === 'differs' ? 'Imported the configuration. The file’s event history differs from this simulator version’s rebuild, so the rebuild is shown.'
      : 'Imported the configuration.',
    importFailed: 'Import failed.',
    shareInvalid: 'The share link could not be used, so the default scenario is shown.',
    earlierVersionLink: 'This link came from an earlier version of Inference Lab, which stored settings in a form this version cannot read, so the default scenario is shown.',
    invalidConfig: 'This change makes the configuration invalid. The last valid run stays on screen.',
    dismiss: 'Dismiss',
  },
  crash: {
    message: 'The simulator hit an internal error while building or drawing this run, so it stopped. This is a bug in the simulator.',
    reset: 'Open the default scenario',
  },
  scenario: {
    heading: 'Scenario',
    custom: 'Custom configuration',
    observe: 'What to observe',
    assumption: 'Assumption that matters',
    limits: 'What this does not establish',
  },
  scenarios: {
    'long-prefill': {
      name: 'Long prefill interruption',
      summary: 'Six short requests are decoding when a 6,144-token prompt arrives. One more short request, R8, arrives behind it.',
      observe:
        'Policy A runs the whole long prompt in one 166 ms iteration, so every short request waits that long for its next token. Policy B splits it into 512-token chunks beside the decodes. The long request’s first token arrives later in B, and the request behind it starts sooner.',
      assumption: 'Costs add up with no overlap, so a mixed iteration lasts as long as its prefill and decode work combined.',
      limits: 'It does not show that chunked prefill is faster on real hardware. Kernel fusion, overlap, and memory bandwidth change the balance.',
    },
    'kv-pressure': {
      name: 'KV pressure',
      summary: 'Twenty long-context requests on a 20 GiB device leave room for about ten completion reservations.',
      observe:
        'Watch reservation headroom: admitted requests reserve blocks for their final length but occupy far fewer at first. The head of the queue waits until a release frees enough unreserved blocks. Raise prompt lengths or the request count to see admission waiting grow.',
      assumption: 'This simulator reserves ceil((P + G − 1) / block size) blocks at admission, a conservative policy that never needs preemption.',
      limits: 'Production engines admit optimistically and preempt or swap under pressure. Their capacity and waiting times differ.',
    },
    burst: {
      name: 'Burst arrivals',
      summary: 'Twenty-four requests arrive within 20 ms with eight sequence slots.',
      observe:
        'Admission waits on sequence slots, not memory. Compare how each policy batches the queued prompts and how first-token and end-to-end latency spread across the same requests.',
      assumption: 'Admission is strict FIFO, so one slow head request delays everyone behind it.',
      limits: 'A real router or engine may reorder, shed, or autoscale. This trace is a fixed synthetic burst.',
    },
    'edge-cases': {
      name: 'Edge cases',
      summary: 'A one-token output, a request that can never fit the KV pool, and two ordinary requests on a 50-block pool.',
      observe:
        'OneToken finishes after its prefill with no decode and no TPOT. TooBig needs 76 blocks, more than the empty pool holds, so it is rejected at arrival and leaves the queue.',
      assumption: 'Maximum context length is a validity limit, separate from how many KV positions a request currently occupies.',
      limits: 'Real servers may truncate, offload, or return an error instead of rejecting a request this way.',
    },
  } satisfies Record<ScenarioId, { name: string; summary: string; observe: string; assumption: string; limits: string }>,
  policy: {
    'whole-prefill': { name: 'Whole-prefill baseline', short: 'Whole prefill' },
    'chunked-prefill': { name: 'Decode-first chunked prefill', short: 'Chunked prefill' },
  } satisfies Record<PolicyId, { name: string; short: string }>,
  panel: (id: string) => `Panel ${id}`,
  phase: {
    pending: 'Not arrived',
    waiting: 'Waiting',
    infeasible: 'Infeasible',
    admitted: 'Admitted',
    prefilling: 'Prefilling',
    decoding: 'Decoding',
    awaitingRelease: 'Awaiting release',
    completed: 'Completed',
  } satisfies Record<Phase, string>,
  status: {
    pending: 'Not arrived',
    waiting: 'Waiting',
    active: 'Unfinished',
    completed: 'Completed',
    infeasible: 'Infeasible',
  } satisfies Record<RequestStatus, string>,
  outcome: (o: RunOutcome) =>
    o.code === 'drained' ? 'All requests completed or were rejected.'
    : o.limit === 'iterations' ? `Stopped after ${o.max.toLocaleString('en-US')} iterations. Results are partial.`
    : `Stopped at ${o.max.toLocaleString('en-US')} scheduled entries to bound browser memory. Results are partial.`,
  playback: {
    reset: 'Reset',
    previous: 'Previous event',
    play: 'Play',
    pause: 'Pause',
    next: 'Next event',
    speed: 'Speed',
    speedOption: (msPerSec: number) => `${msPerSec} ms/s`,
    scrubber: 'Modeled time',
    scrubberValue: (at: string, end: string) => `${at} of ${end} (modeled)`,
    time: 'Modeled time',
    event: (applied: number, total: number) => `Event ${applied} of ${total}`,
    window: 'Time window',
    windowAll: 'Whole run',
    windowOption: (ms: number) => `${ms} ms`,
  },
  timeline: {
    heading: 'Request timeline',
    iterations: 'Iterations',
    axis: 'ms (modeled)',
    legend: {
      waiting: 'Waiting',
      admitted: 'Admitted, awaiting prefill',
      prefill: 'Prefill chunk',
      decode: 'Decode iteration',
      token: 'Output token',
      completed: 'Completed',
      infeasible: 'Infeasible',
      ahead: 'Faint: the rest of the run',
    },
    rowLabel: (id: string, phase: string) => `${id}, ${phase}. Show details.`,
    current: (index: number) => `#${iterationNumber(index)}`,
    scrollHint: 'Rows scroll inside the timeline.',
  },
  batch: {
    heading: 'Batch',
    idle: 'Idle. No iteration has started yet.',
    executing: (index: number) => `Iteration ${iterationNumber(index)}, executing`,
    finished: (index: number) => `Iteration ${iterationNumber(index)}, finished`,
    tokens: 'Scheduled tokens',
    tokenBudget: (used: number, budget: number) => `${used} of ${budget} tokens`,
    sequences: (used: number, limit: number) => `${used} of ${limit} sequences`,
    remaining: (n: number) => `${count(n, 'token')} left`,
    duration: 'Duration',
    ran: 'Ran',
    notRun: 'Did not run',
    request: 'Request',
    work: 'Work',
    why: 'Why',
    prefillWork: (tokens: number, from: number, emitsFirstToken: boolean) => `Prefill ${count(tokens, 'token')} from position ${from}${emitsFirstToken ? ', emits first token' : ''}`,
    decodeWork: (position: number) => `Decode: append KV position ${position}, emit next token`,
    newBlocks: (n: number) => (n === 0 ? 'no new block' : n === 1 ? '+1 block' : `+${n} blocks`),
    waitingWork: 'Waiting for admission',
    arrivedDuring: 'Arrived during this iteration. Eligible at the next decision.',
    more: (n: number) => `+${n} more`,
    showDetails: 'Explain this iteration',
    costTerms: {
      overheadMs: 'Iteration overhead',
      prefillTokenMs: 'Prefill projection and MLP',
      prefillAttentionMs: 'Prefill attention',
      decodeSequenceMs: 'Decode per sequence',
      decodeContextMs: 'Decode context reads',
    },
  },
  entryReason: {
    wholePrompt: () => 'Policy A runs admitted prompts first, whole, in FIFO order.',
    decodeWithRemainingBudget: r => `Uses token budget left after whole prompts (decode rank ${r.rank + 1}).`,
    decodeFirst: r => `Policy B schedules decodes before prefill (decode rank ${r.rank + 1}).`,
    prefillChunk: r =>
      r.limitedBy === 'promptEnd' ? 'Prefill chunk covers the rest of the prompt.'
      : r.limitedBy === 'chunkLimit' ? 'Prefill chunk capped at the maximum chunk size.'
      : 'Prefill chunk capped by the token budget left after decodes.',
  } satisfies Catalog<EntryReason>,
  skipReason: {
    tokenBudgetExhausted: () => 'The iteration token budget is used up.',
    wholePromptDoesNotFit: r => `Its ${r.promptTokens}-token prompt does not fit the ${r.remainingTokens} tokens left, and Policy A never splits prompts.`,
    behindDeferredPrefill: (r, id) => `FIFO: waits behind ${id(r.head)}, whose prompt was deferred.`,
  } satisfies Catalog<SkipReason>,
  waitReason: {
    activeLimitReached: r => `All ${r.limit} active-sequence slots are taken (head of the queue).`,
    reservationDoesNotFit: r => `Needs ${r.needBlocks} reserved blocks, but only ${r.unreservedBlocks} are unreserved (head of the queue).`,
    queuedBehind: (r, id) => `FIFO: queued behind ${id(r.head)}, which cannot be admitted yet.`,
    awaitingDecision: () => 'Fits now. Admitted at the next decision instant.',
  } satisfies Catalog<WaitReason>,
  infeasible: {
    reservationExceedsPool: r => `Needs ${r.needBlocks} blocks to finish, but the empty pool has ${r.totalBlocks}. Rejected at arrival.`,
  } satisfies Catalog<InfeasibleReason>,
  memory: {
    heading: 'Memory',
    device: 'Device memory',
    weights: 'Weights',
    runtime: 'Runtime allowance',
    kvPool: 'KV pool',
    tail: 'Unusable tail',
    blocks: 'KV blocks',
    allocated: 'Allocated',
    headroom: 'Reserved headroom',
    unreserved: 'Unreserved',
    free: 'Free',
    cached: 'Logical cached tokens',
    inflight: 'Being written this iteration',
    fragmentation: 'Internal fragmentation',
    peak: 'Peak allocated',
    perToken: 'KV per token',
    perBlock: 'Block',
    blockUnit: (n: number) => count(n, 'block'),
    tokenUnit: (n: number) => count(n, 'token'),
    headroomNote: 'Reserved headroom is an accounting guarantee for admitted requests, not extra allocated memory.',
    metadataMissing: 'No quantization metadata allowance is declared, so packed weight size understates real residency.',
    rowsHeading: 'Per request',
    noRows: 'No request holds KV memory.',
    rowSummary: (cached: number, inflight: number, allocated: number, reserved: number) =>
      `${inflight > 0 ? `${cached} + ${inflight} writing` : cached} tokens in ${allocated}/${reserved} blocks`,
  },
  overTime: {
    heading: 'Over time',
    note: 'Sampled when each iteration starts, on the timelines’ time axis. Select a point to move the cursor there.',
    kv: 'KV blocks',
    batch: 'Batch and queue',
    allocated: 'Allocated',
    reserved: 'Reserved',
    inBatch: 'Requests in the iteration',
    waiting: 'Waiting',
    scaleTo: (max: number) => `0 to ${max.toLocaleString('en-US')}`,
    pool: (blocks: number) => `pool ${blocks.toLocaleString('en-US')}`,
    at: (time: string) => `At ${time} (modeled)`,
    idle: 'idle',
    kvReadout: (allocated: number, reserved: number) => `${allocated.toLocaleString('en-US')} allocated, ${reserved.toLocaleString('en-US')} reserved`,
    batchReadout: (entries: number, waiting: number) => `${count(entries, 'request')} in the iteration, ${waiting} waiting`,
    kvSummary: (panel: string, peakAllocated: number, peakAt: string, peakReserved: number, pool: number) =>
      `Panel ${panel} KV blocks over time. Allocated peaks at ${count(peakAllocated, 'block')} at ${peakAt}; reserved peaks at ${count(peakReserved, 'block')}; the pool holds ${count(pool, 'block')}.`,
    batchSummary: (panel: string, peakEntries: number, peakWaiting: number, peakAt: string) =>
      peakWaiting === 0 ? `Panel ${panel} batch and queue over time. Up to ${count(peakEntries, 'request')} per iteration; no request waits at an iteration start.`
      : `Panel ${panel} batch and queue over time. Up to ${count(peakEntries, 'request')} per iteration; the waiting queue peaks at ${peakWaiting} at ${peakAt}.`,
  },
  details: {
    heading: 'Details',
    hint: 'Select a request row or an iteration bar to see its details. Select an event to jump to it.',
    request: (id: string) => `Request ${id}`,
    iteration: (panel: string, index: number) => `${panel}, iteration ${iterationNumber(index)}`,
    previousIteration: (index: number) => `← ${iterationNumber(index)}`,
    nextIteration: (index: number) => `${iterationNumber(index)} →`,
    close: 'Clear selection',
    prompt: 'Prompt tokens (P)',
    output: 'Output budget (G)',
    state: 'State',
    generated: 'Generated tokens',
    cachedTokens: 'Cached KV tokens',
    allocatedBlocks: 'Allocated blocks',
    reservedBlocks: 'Reserved blocks',
    blockIds: 'Block ids',
    arrival: 'Arrival',
    admitted: 'Admitted',
    queueDelay: 'Initial queue delay',
    ttft: 'TTFT',
    tpot: 'TPOT',
    e2e: 'E2E latency',
    maxItl: 'Largest gap between tokens',
    chunks: 'Prefill chunks',
    decodes: 'Decode iterations',
    releasedNote: (peak: number, kv: number) => `Released. Held ${count(peak, 'block')} and ${count(kv, 'KV position')} (P + G − 1) at the end.`,
    reason: 'Why',
    ran: 'Ran in this iteration',
    skipped: 'Active but not scheduled',
    queued: 'Waiting for admission at the decision',
    arrivedDuring: 'Arrived while it ran',
    cost: 'Cost terms',
  },
  events: {
    heading: 'Event log',
    describe: {
      arrived: (id: string) => `${id} arrived`,
      rejected: (id: string) => `${id} rejected as infeasible`,
      admitted: (id: string, blocks: number) => `${id} admitted, reserved ${count(blocks, 'block')}`,
      iterationStarted: (index: number, requests: number) => `Iteration ${iterationNumber(index)} started with ${count(requests, 'request')}`,
      iterationCompleted: (index: number) => `Iteration ${iterationNumber(index)} finished, tokens emitted`,
      released: (id: string, blocks: number) => `${id} completed, released ${count(blocks, 'block')}`,
      runEnded: () => 'Run ended',
    },
    jump: 'Jump to this event',
  },
  results: {
    heading: 'Comparison results',
    modes: { final: 'Final', cursor: 'At cursor' },
    modeLabel: 'Results as of',
    note: (scope: string) => `${scope} Percentiles use nearest rank. n is the sample count. Requests that never finish count against SLO attainment.`,
    finalScope: 'Full run, modeled time.',
    cursorScope: (at: string) => `Events up to the cursor at ${at} (modeled). Running requests have no E2E or TPOT yet and count as not met.`,
    metric: 'Metric',
    delta: 'B − A',
    rows: {
      completed: 'Completed',
      infeasible: 'Infeasible',
      unfinished: 'Unfinished',
      waiting: 'Waiting',
      queueDelayP50: 'Initial queue delay p50',
      queueDelayP90: 'Initial queue delay p90',
      ttftP50: 'TTFT p50',
      ttftP90: 'TTFT p90',
      tpotP50: 'TPOT p50',
      tpotP90: 'TPOT p90',
      itlP50: 'ITL p50',
      itlP99: 'ITL p99',
      itlMax: 'ITL max',
      e2eP50: 'E2E p50',
      e2eP90: 'E2E p90',
      throughput: 'Completed requests per second',
      tokens: 'Output tokens per second',
      slo: 'SLO attainment',
      goodput: 'SLO-met requests per second',
      makespan: 'Last event',
    },
    sloNote: (ttft: number, tpot: number) => `SLO: TTFT ≤ ${ttft} ms and TPOT ≤ ${tpot} ms (TPOT is not checked for one-token outputs).`,
    perRequest: 'Request-level outcomes',
    columns: { id: 'Request', status: 'Status', ttft: 'TTFT', e2e: 'E2E', slo: 'SLO' },
    met: 'met',
    missed: 'missed',
    interval: (start: string, end: string) => `Throughput interval: first arrival (${start}) to last event (${end}).`,
  },
  config: {
    heading: 'Configuration',
    architecture: 'Model',
    preset: 'Architecture preset',
    customArch: 'Custom',
    params: 'Parameters (billions)',
    layers: 'Layers',
    queryHeads: 'Query heads',
    kvHeads: 'KV heads',
    headDim: 'Head dimension',
    maxContext: 'Max context (tokens)',
    memory: 'Memory',
    device: 'Device memory (GiB)',
    weightBits: 'Weight precision',
    bits: (b: number) => `${b}-bit`,
    metadata: 'Weight metadata allowance (%)',
    runtime: 'Runtime allowance (GiB)',
    kvElement: 'KV element',
    kvElements: { 1: 'FP8, 1 byte', 2: 'FP16 or BF16, 2 bytes', 4: 'FP32, 4 bytes' } as Record<number, string>,
    blockSize: 'Block size (tokens)',
    scheduler: 'Scheduler (shared)',
    limits: {
      maxActiveSequences: 'Max active sequences',
      maxBatchTokens: 'Iteration token budget',
      maxPrefillChunkTokens: 'Max prefill chunk (tokens)',
    } satisfies Record<keyof SchedulerLimits, string>,
    panels: 'Panels',
    policy: 'Policy',
    override: 'Override',
    overrideHint: 'Leave blank to use the shared value.',
    trace: 'Request trace',
    traceRow: (n: number) => `Request trace, row ${n}`,
    seed: 'Seed',
    count: 'Requests',
    pattern: 'Arrival pattern',
    patterns: { uniform: 'Uniform', jittered: 'Jittered', burst: 'Burst' } as Record<string, string>,
    span: 'Arrival span (ms)',
    promptMin: 'Prompt min',
    promptMax: 'Prompt max',
    outputMin: 'Output min',
    outputMax: 'Output max',
    traceId: 'ID',
    traceArrival: 'Arrival ms',
    traceP: 'P',
    traceG: 'G',
    addRequest: 'Add request',
    removeRequest: (id: string) => `Remove ${id}`,
    traceTooLong: (n: number) => `${n} requests. Edit larger traces as JSON and import them.`,
    cost: 'Cost model',
    overhead: 'Overhead (ms per iteration)',
    prefillToken: 'Prefill (ms per token)',
    attention: 'Attention (ms per million pairs)',
    decodeSeq: 'Decode (ms per sequence)',
    decodeCtx: 'Decode context (ms per 1,000 tokens)',
    slo: 'SLO thresholds',
    ttft: 'TTFT (ms)',
    tpot: 'TPOT (ms)',
    differs: 'Differs from shared',
    invalidNumber: 'Enter a number in range.',
  },
  model: {
    heading: 'Model assumptions',
  },
  dialog: { close: 'Close' },
  differences: {
    heading: 'What differs between panels',
    policy: 'Policy',
    shared: (value: string) => `shared ${value}`,
    unusedBy: (panel: string) => `not used by panel ${panel}`,
    alsoShared: (limitsDiffer: number, limitCount: number) =>
      `Shared: trace, seed, architecture, memory, cost model, SLOs${limitsDiffer === 0 ? ', scheduler limits' : limitsDiffer < limitCount ? ', other scheduler limits' : ''}.`,
  },
  shortcuts: {
    heading: 'Keyboard shortcuts',
    commands: {
      toggle: 'Play or pause',
      previous: 'Previous event',
      next: 'Next event',
      reset: 'Reset to the start',
      end: 'Jump to the end',
      slower: 'Slower playback',
      faster: 'Faster playback',
      shortcuts: 'Show these shortcuts',
    } satisfies Record<Command, string>,
    keyName: (key: string) => ({ ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', '-': '−' })[key] ?? key,
    note: 'Esc closes this dialog. Shortcuts are ignored while typing in a field.',
  },
  common: { na: 'N/A', yes: 'Yes', no: 'No' },
};

const ISSUE_TEXT: Record<IssueCode, (p: Params) => string> = {
  malformed: () => 'The input is not valid JSON or base64url data.',
  unsupportedVersion: p => `Unsupported version. Expected version ${p?.expected}.`,
  notObject: () => 'Expected an object.',
  notNumber: () => 'Expected a number.',
  notInteger: () => 'Expected a whole number.',
  outOfRange: p => `Must be between ${p?.min} and ${p?.max}.`,
  notOneOf: p => `Must be one of: ${p?.options}.`,
  badText: p => `Expected plain text up to ${p?.maxLength} characters, without markup.`,
  tooMany: p => `At most ${p?.max} entries.`,
  empty: () => 'At least one request is required.',
  duplicateId: p => `Request id ${p?.id} appears more than once.`,
  rangeInverted: () => 'Minimum is larger than maximum.',
  contextExceeded: p =>
    `${p?.id === undefined ? 'The longest generated request' : `Request ${p.id}`} has P + G = ${p?.total}, which exceeds the ${p?.max}-token context limit.`,
  weightsDoNotFit: () => 'Weights plus the runtime allowance do not fit in device memory.',
  noKvBlocks: () => 'The remaining memory does not hold a single KV block.',
  zeroDurationWork: p => `A ${p?.kind} iteration would take zero modeled time. Give it a positive cost term.`,
  promptExceedsWholePrefillBudget: p =>
    `Request ${p?.id} has ${p?.promptTokens} prompt tokens, more than the ${p?.budget}-token budget. The whole-prefill policy cannot run it. Raise the budget or use chunked prefill.`,
  kvHeadsExceedQueryHeads: () => 'KV heads cannot exceed query heads.',
  queryHeadsNotGrouped: p => `${p?.query} query heads do not split evenly into groups for ${p?.kv} KV heads. MHA and GQA need query heads to be a multiple of KV heads.`,
  tooManyKvBlocks: p =>
    `The trace allocates ${p?.total} KV blocks in total, more than the ${p?.max} this page tracks. Raise the block size or shorten the trace.`,
  tooLarge: p => `Too large (${p?.length ?? p?.total} > ${p?.max}). Export and import JSON for large traces.`,
};

function issueArea(path: string): string | null {
  const [root, field] = path.split('.');
  const row = /^trace\.requests\[(\d+)\]/.exec(path);
  switch (root) {
    case 'architecture':
      return S.config.architecture;
    case 'memory':
      return S.config.memory;
    case 'scheduler':
      return S.config.scheduler;
    case 'cost':
      return S.config.cost;
    case 'slo':
      return S.config.slo;
    case 'trace':
      return row ? S.config.traceRow(Number(row[1]) + 1) : S.config.trace;
    case 'panels':
      return field ? S.panel(field) : S.config.panels;
    case 'config':
      return field === 'seed' ? S.config.seed : null;
    default:
      return null;
  }
}

export function issueText(issue: { path: string; code: IssueCode; params?: Params }): string {
  const area = issueArea(issue.path);
  const message = ISSUE_TEXT[issue.code](issue.params);
  return area === null ? message : `${area}: ${message}`;
}

export function explain<U extends { code: string }>(catalog: Catalog<U>, reason: U, id: (i: number) => string): string {
  const f = catalog[reason.code as U['code']] as unknown as (r: U, id: (i: number) => string) => string;
  return f(reason, id);
}

export const MODEL_DOC = {
  intro:
    'Inference Lab is a deterministic, educational simulation of one logical GPU serving a decoder-only Transformer with full attention. It runs no model and measures no hardware. Every number comes from the equations below.',
  sections: [
    {
      title: 'Token semantics',
      items: [
        'A prefill chunk writes K/V for its prompt tokens. Only the final chunk produces logits and emits the first output token.',
        'An emitted token has no KV entry until a later decode consumes it. Each decode appends one KV position and emits the next token.',
        'A request with P prompt tokens and G output tokens reaches P + G − 1 populated KV positions before release. With G = 1 it finishes after prefill with no decode.',
        'Exactly G tokens are generated. There is no stochastic end-of-sequence.',
        'P + G must not exceed the maximum context length. That limit is an input rule, not the current KV occupancy.',
      ],
    },
    {
      title: 'Memory',
      equation: 'kvBytesPerToken = 2 × layers × kvHeads × headDim × kvElementBytes\nweightBytes = parameters × weightBits / 8 × (1 + metadata%)\nkvPool = device − weightBytes − runtimeAllowance\ntotalBlocks = floor(kvPool / (blockSize × kvBytesPerToken))',
      items: [
        'The factor 2 counts keys and values. KV heads, not query heads, set the size, so GQA shrinks the cache.',
        'Weight precision changes only weight bytes. It does not change KV precision or modeled compute time.',
        'Blocks belong to one request. occupiedBlocks = ceil(KV tokens / blockSize), rounded per request, so the partly filled last block is internal fragmentation.',
        'Blocks for the tokens an iteration writes are allocated when it starts and populated when it ends.',
        'Excluded: MLA, sliding-window attention, recurrent or hybrid layers, tensor or pipeline sharding, prefix sharing, offloading, and activation memory beyond the fixed runtime allowance.',
      ],
    },
    {
      title: 'Admission',
      items: [
        'Strict FIFO. The head request is admitted when an active-sequence slot is free and ceil((P + G − 1) / blockSize) blocks are still unreserved.',
        'The reservation guarantees that admitted requests can finish without preemption. It is accounting, not extra allocation. Reserved headroom shrinks as KV grows.',
        'When the head cannot be admitted, everyone behind it waits (head-of-line blocking). A request that cannot fit even an empty pool is rejected at arrival and leaves the queue.',
        "This is this simulator's conservative policy. It is not vLLM's admission algorithm, which admits optimistically and preempts under pressure.",
      ],
    },
    {
      title: 'Scheduling policies',
      items: [
        'Both policies share the active-sequence limit, the iteration token budget, the memory rules, and the trace unless a panel override changes them. Each decode counts as one token.',
        'Policy A, whole-prefill baseline: admitted prompts run first, whole, in FIFO order. It stops at the first prompt that does not fit the remaining budget, then fills the rest with decodes. Every prompt must fit the full budget.',
        'Policy B, decode-first chunked prefill: decodes run first, then FIFO prefill chunks of min(remaining prompt, max chunk, remaining budget), continuing from the cached prefix.',
        'Decode order in both: least recently served first, ties by admission order. This rotates service when the budget cannot cover every decode.',
        'Arrivals during an iteration wait for the next decision. Running work is never interrupted. These are simplified educational policies, not a replay of any vLLM version, and they do not guarantee freedom from starvation under unbounded load.',
      ],
    },
    {
      title: 'Cost model',
      equationKey: 'cost',
      items: [
        'q is the new prompt tokens in a chunk and c the tokens already cached. q × c + q(q + 1)/2 counts causal query-key pairs.',
        'A decode attends over its c cached positions plus its own, so it reads c + 1 positions.',
        'Terms add with no overlap between prefill compute and decode memory traffic. Output tokens are emitted at iteration end.',
        'Coefficients are chosen for readable scenarios, not measured on hardware. Modeled busy time is not GPU utilization or MFU. 4-bit weights are not assumed to be faster.',
        'Durations are rounded to whole microseconds, minimum 1 µs. A configuration where any nonempty iteration would take zero time is rejected.',
      ],
    },
    {
      title: 'Metrics',
      items: [
        'Initial queue delay: arrival to first execution. TTFT: arrival to first emitted token. E2E: arrival to last emitted token.',
        'ITL: gaps between consecutive output tokens. TPOT: (last − first) / (G − 1), N/A when G = 1.',
        'Throughput uses the interval from the first arrival to the last event. A zero-length interval gives N/A.',
        'Percentiles use nearest rank: the value at rank ceil(p/100 × n). Empty samples are N/A. Unfinished and infeasible requests count against SLO attainment.',
      ],
    },
  ],
  references: [
    { label: 'vLLM: Optimization and tuning (chunked prefill)', href: 'https://docs.vllm.ai/en/stable/configuration/optimization/' },
    { label: 'vLLM: Production metrics', href: 'https://docs.vllm.ai/en/stable/usage/metrics/' },
    { label: 'vLLM: Automatic prefix caching (excluded here)', href: 'https://docs.vllm.ai/en/stable/features/automatic_prefix_caching/' },
    { label: 'Kwon et al., PagedAttention (SOSP 2023)', href: 'https://arxiv.org/abs/2309.06180' },
  ],
  referencesTitle: 'References',
};
