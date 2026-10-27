# Model reference

This page defines what Inference Lab computes, in which units, and what it leaves out. Every rule here maps to a module in `src/engine/`. The same rules appear in the app's **Model and assumptions** panel and in the `assumptions` field of every JSON export.

Inference Lab is an educational simulation of one logical GPU. It runs no language model, no GPU kernel, and no inference API. All times are modeled milliseconds from the cost model below, not measurements.

## Scope

The engine models a decoder-only Transformer with full attention. An explicit KV-head count selects MHA or GQA. MHA sets KV heads equal to query heads, and GQA sets fewer. Query heads must be a multiple of KV heads.

The model excludes the following, and the UI ships no controls for them:

- MLA, sliding-window attention, and recurrent or hybrid architectures.
- Tensor parallelism, pipeline parallelism, and any other sharding.
- Disaggregated prefill and decode.
- Prefix caching and prefix sharing.
- Speculative decoding.
- KV offloading, preemption, and recomputation.
- Autoscaling and live benchmark import.

Architecture presets (`ARCHITECTURE_PRESETS` in `src/engine/scenarios.ts`) are synthetic. They do not describe a particular commercial model or GPU.

## Requests and token conventions

A request has a stable `id`, an `arrivalMs`, a prompt length `P` (positive integer), and an output budget `G` (positive integer). Every request generates exactly `G` output tokens. The engine does not simulate stochastic end-of-sequence.

`src/engine/tokens.ts` implements this convention:

1. A prefill chunk appends its prompt tokens to the KV cache.
2. The final prefill chunk produces logits and emits output token 1. A non-final chunk emits nothing.
3. An emitted token has no KV entry until a later decode consumes it.
4. Decode `k` (for `k = 1` to `G - 1`) consumes output token `k`, appends one K/V position, and emits token `k + 1`.
5. Just before completion, a request holds `P + G - 1` populated KV positions.
6. If `G = 1`, the request completes right after prefill and runs no decode iterations.

The engine keeps three counters per request, and they are never merged:

| Counter | Meaning |
| --- | --- |
| Generated tokens | Output tokens emitted so far, from 0 to `G`. |
| Cached tokens | Populated KV positions: prompt tokens prefilled, plus `max(0, generated - 1)`. |
| Allocated blocks | Physical blocks owned: `ceil(cached / blockSizeTokens)`. |

Input validation requires `P + G <= maxContextLength`. This is a conservative validity rule. The maximum context length is not the number of currently occupied KV positions.

## Memory model

The engine uses bytes internally. The UI shows binary units: 1 KiB = 1,024 B, 1 MiB = 2^20 B, and 1 GiB = 2^30 B.

`src/engine/memory.ts` computes:

```text
kvBytesPerToken  = 2 * numLayers * numKVHeads * headDim * kvElementBytes
kvBlockBytes     = blockSizeTokens * kvBytesPerToken
weightPacked     = round(paramsBillions * 1e9 * weightBits / 8)
weightMetadata   = round(weightPacked * weightMetadataPercent / 100)
weightBytes      = weightPacked + weightMetadata
kvPoolBytes      = deviceBytes - weightBytes - runtimeAllowanceBytes
totalBlocks      = floor(kvPoolBytes / kvBlockBytes)
```

The factor 2 stores keys and values. KV heads set the size, not query heads, so GQA shrinks the KV cache. The bytes left after carving whole blocks out of the pool appear as `unusedTailBytes`.

The runtime allowance stands for activations, workspaces, graphs, and other memory outside the KV pool. It is one declared number, not a model of those buffers.

Weight precision (16, 8, or 4 bits) changes `weightBytes` only. It does not change the KV element size (2 or 1 bytes) or any cost coefficient. A 4-bit model is not faster in this simulator. It leaves more memory for KV blocks.

The quantization metadata allowance (0% to 50% of the packed size) stands for scales and other metadata. If you choose 8 or 4 bits and leave the allowance at 0%, the UI says that weights show the raw packed size, not exact framework residency.

Validation rejects a configuration in these cases:

- Weights plus the runtime allowance do not fit in device memory.
- The KV pool is smaller than one block.
- The pool has more than 2,000,000 blocks. Increase the block size to stay under this limit.

### Worked example

The default preset `synthetic-8b-gqa` has 32 layers, 8 KV heads, a head dimension of 128, and 2-byte KV elements:

```text
kvBytesPerToken = 2 * 32 * 8 * 128 * 2 = 131,072 B = 128 KiB
kvBlockBytes    = 16 * 128 KiB         = 2 MiB
weightBytes     = 8e9 * 16 / 8         = 16e9 B = 14.90 GiB
kvPoolBytes     = 32 GiB - 14.90 GiB - 4 GiB = 14,064,771,072 B
totalBlocks     = floor(14,064,771,072 / 2 MiB) = 6,706 blocks
```

The **Long prefill interruption** and **Burst arrivals** scenarios use this pool.

## Block allocator

`BlockAllocator` in `src/engine/allocator.ts` allocates blocks per request. Each request rounds up on its own:

```text
occupiedBlocks(request) = ceil(cachedTokens(request) / blockSizeTokens)
```

The engine never rounds the combined token count across requests. The unused slots in each request's last block are internal fragmentation. The memory inspector shows fragmentation in slots, in bytes, and as a percentage of allocated capacity.

Physical blocks come from a FIFO free queue. A released block goes to the back of the queue. The allocator stores one owner per block and a list of block ids per request. It never allocates memory in proportion to the modeled tensor bytes.

Before the engine commits an iteration, it allocates every block that the selected items need. Allocation throws `AllocatorError` if a request would exceed its reservation or the pool would run out. The engine turns that error into a `blocked` finish instead of continuing with bad state.

`checkInvariants()` verifies that no block has two owners and that no request occupies more than it reserved. It also verifies that allocated never exceeds reserved, that reserved never exceeds the pool, and that no counter is negative. The unit tests run it after every iteration.

## Admission and reservation

Admission is this simulator's policy. It is not a reproduction of vLLM's admission algorithm. vLLM admits optimistically and can preempt and recompute requests when KV space runs out. This simulator never preempts.

At admission, a request reserves enough blocks to finish:

```text
reservedBlocks = ceil((P + G - 1) / blockSizeTokens)
```

A reservation is an accounting guarantee, not a physical allocation. Physical blocks grow only as cached tokens grow, and they can never exceed the reservation. The engine does not double-count the two. The sum of reservations is at most the pool, so the sum of occupied blocks is at most the pool too. An admitted request can always get the blocks it needs to finish.

The memory inspector separates three amounts:

| Amount | Meaning |
| --- | --- |
| KV allocated | Blocks that hold populated positions or will hold them in the running iteration. |
| Reservation headroom | Reserved blocks minus allocated blocks. These blocks are physically free but promised. |
| Unreserved | Pool blocks minus reserved blocks. Only these blocks can admit a new request. |

Admission is FIFO. At each iteration boundary, the engine examines the head of the waiting queue:

1. If the head's reservation exceeds the whole pool, the head is marked `infeasible` with the blocks it needs and the pool size. The engine removes it from the queue and examines the next head.
2. If the active set has reached `maxActiveSequences`, the head waits (`sequence-limit`).
3. If the head's reservation exceeds the unreserved blocks, the head waits (`kv-reservation`).
4. Otherwise the engine reserves the blocks, admits the head, and examines the next head.

When the head waits, every request behind it waits too, even a request that would fit. This is head-of-line blocking. It lasts until a completion releases a slot or a reservation. The batch inspector labels the head with its reason and labels the requests behind it as blocked by the head.

When a request emits its last token, the engine releases its physical blocks and its reservation exactly once. A second release throws `AllocatorError`. The request's historical metrics and peak footprint stay in the event log.

## Iterations and event order

`src/engine/simulator.ts` runs a discrete-event loop. Each iteration is one batch. An iteration that has started runs to completion, and no admission can interrupt it.

At one iteration boundary `t`, events occur in this order:

1. `iteration-end` for the iteration that finishes at `t`, with token emissions in batch order.
2. `complete` and `release` for requests that emitted their last token, in batch order.
3. `arrival` for requests that arrive at exactly `t`, in trace order.
4. Admission: `admit`, `admission-blocked`, or `infeasible`.
5. `iteration-start` for the next batch.

A request that arrives strictly inside an iteration gets an `arrival` event at its own timestamp. It becomes eligible for admission only at the next boundary.

If the engine has no work and requests are still to arrive, it emits `idle` and jumps to the next arrival. The run ends with a `finished` event. The status is `completed` when every feasible request has completed. The status is `blocked` when the run stops early: after 60,000 iterations, after a non-positive iteration duration, or after an allocator error. The engine never loops without progress.

Simultaneous arrivals keep their trace order. `orderTrace` sorts by arrival time and breaks ties by the original position.

## Scheduling policies

Both policies are simplified educational policies. Neither one replays a specific vLLM version. Both share the trace, memory rules, and admission rules. By default they also share the scheduler limits:

| Limit | Meaning |
| --- | --- |
| `maxActiveSequences` | Caps admitted, unfinished requests. It also caps the requests selected per iteration. |
| `tokenBudget` | Caps the scheduled tokens per iteration. A prefill chunk counts its length. A decode counts 1. |
| `maxPrefillChunk` | Caps the prompt tokens one request can prefill in one iteration. Only the chunked policy uses it. |

A request appears at most once in an iteration. It cannot complete its prefill and run its next decode in the same iteration. Filling a limit exactly is valid.

Both policies order decodes the same way. The order is round-robin by admission order, starting after the request that received the last decode in the previous iteration. The round-robin order matters only when the budget or the sequence limit cannot serve every eligible decode.

### Policy A: whole-prefill baseline

1. Admitted requests that still need prefill go first, in FIFO admission order. Each prompt runs whole in one iteration and is never split.
2. If the next prompt does not fit the remaining budget, it is deferred. Every prompt behind it is deferred too, so prefill order stays FIFO.
3. Decodes use the remaining token and sequence capacity, even when a prompt was deferred.

Validation requires every prompt to fit this panel's whole token budget. If a prompt is larger, the panel reports an incompatible A/B configuration and names the largest prompt. The panel does not exceed its budget and does not chunk the prompt.

### Policy B: decode-first chunked prefill

1. Decodes go first, in round-robin order.
2. Prefill chunks use the remaining capacity, in FIFO admission order. Each chunk has `min(remaining prompt, maxPrefillChunk, remaining budget)` tokens.
3. A partly prefilled prompt continues from its actual cached prefix. No output token appears before the final chunk completes.

The batch inspector shows why each chunk has its length: the whole prompt, the rest of the prompt, the chunk cap, or the remaining budget.

### Policy explanations

For every iteration, the engine records a decision for each considered request: run a decode, run a whole prompt, run a chunk, or defer. A deferred request has its reason: the token budget, the sequence cap, or FIFO order behind a deferred prompt. Waiting requests get a queue decision: the sequence limit, the KV reservation, or head-of-line blocking. The engine lists up to 64 waiting requests and records only the count for the rest.

Finite demo traces complete under both policies. The policies make no starvation-freedom claim under unlimited incoming load.

## Execution-cost model

`src/engine/cost.ts` gives every nonempty iteration a duration in modeled milliseconds:

```text
duration = overhead
         + linear      * (prefill tokens + decode tokens)
         + prefillAttn * sum over prefill chunks of (q * c + q * (q + 1) / 2) / 1e6
         + decodeAttn  * sum over decodes of (c + 1) / 1e3
```

In a prefill chunk, `q` is the number of new tokens and `c` is the number of populated positions before the chunk. `q * c + q * (q + 1) / 2` counts the causal query-key pairs, including each token's attention to itself. A decode is the `q = 1` case and attends to `c + 1` positions. Decode attention has its own coefficient because decode reads the KV cache instead of running dense compute.

| Coefficient | Default | Unit | Stands for |
| --- | --- | --- | --- |
| `iterationOverheadMs` | 8 | ms per nonempty iteration | Scheduling, kernel launches, and reading the weights once per iteration. |
| `linearMsPerToken` | 0.06 | ms per new token | Projections and MLP for each prefill or decode token. |
| `prefillAttentionMsPerMillionPairs` | 4 | ms per 10^6 query-key pairs | Prefill causal attention. |
| `decodeAttentionMsPerThousandPositions` | 0.5 | ms per 10^3 attended positions | Decode attention over the KV cache. |

The defaults make the scenarios readable. They are not fitted to any hardware.

A mixed batch sums its parts. The model assumes no overlap between prefill compute and decode memory traffic. All outputs of an iteration appear at the iteration's end.

Every nonempty iteration must have a strictly positive duration. Validation rejects a cost configuration unless the overhead is positive, the linear cost is positive, or both attention coefficients are positive. The engine also checks each duration at run time.

For example, Panel A in **Long prefill interruption** runs LONG's 4,000-token prompt with 6 decodes. The prompt has `4000 * 4001 / 2 = 8,002,000` pairs:

```text
8 ms + 0.06 * 4006 + 4 * 8.002 + decode attention
= 8 + 240.4 + 32.0 + 0.6 = 281 ms
```

Busy time is the sum of iteration durations. It is not NVIDIA GPU utilization, MFU, or hardware efficiency.

## Metrics

`src/engine/metrics.ts` computes every metric from event timestamps. An empty sample gives `null`, which the UI shows as N/A. It never gives 0, NaN, or infinity.

| Metric | Definition |
| --- | --- |
| Queue delay | Arrival to the start of the first iteration that includes the request. |
| TTFT | Arrival to the first emitted output token. |
| E2E latency | Arrival to the last emitted output token. Completed requests only. |
| ITL | Each gap between consecutive output tokens of one request. The summary pools gaps across requests. |
| Max ITL | The largest gap for one request. Shows decode stalls. |
| TPOT | `(lastOutputTime - firstOutputTime) / (G - 1)`. Completed requests with `G > 1` only. N/A for `G = 1`. |

Summaries report the sample count with the mean, p50, p90, p99, and max. Percentiles use the nearest-rank method. The p-th percentile of `n` sorted samples is the sample at rank `max(1, ceil(p / 100 * n))`.

The observation window starts at the first arrival and ends at the playback cursor or at the end of the run, whichever is earlier. Throughput values are:

- Completed requests per second.
- Output tokens per second. This counts every emitted token, including tokens of unfinished requests.

Throughput over a zero-length window is N/A.

Each request has one status: not arrived, waiting, running, completed, unfinished, or infeasible. The UI shows each count separately. Metrics never drop unsuccessful requests to improve the result.

A completed request meets its SLO when its TTFT is at or below the TTFT target and its TPOT is at or below the TPOT target. A request with `G = 1` has no TPOT to miss. SLO attainment is the number of requests that met the SLO divided by all requests in the trace. Infeasible and unfinished requests count as not met. Goodput is the rate of SLO-meeting requests, and of their output tokens, over the same window. The results panel shows SLO-compliant tokens per second next to the number of requests that did not meet the SLO. That number includes unfinished and infeasible requests.

## A/B comparison

Both panels run on the identical trace. By default they also share the seed, the architecture, the memory configuration, the cost coefficients, and the SLO targets. Only the policy and explicit per-panel scheduler overrides can differ. The **What differs between panels** bar lists every difference. It marks the chunk size as not used when one panel runs whole-prefill.

The panels share one playback clock in simulated time. **Next event** and **Previous event** step through the merged event times of the visible panels. The results panel compares requests row by row. Each row shows TTFT, max ITL, TPOT, E2E, and the SLO outcome for both panels, with the B minus A delta of each latency.

## Determinism

Identical configuration, seed, and trace produce identical event logs. The tests check this with an FNV-1a digest of the log (`digestEvents`).

- The engine is pure TypeScript with no dependency on React, animation frames, wall-clock time, or tab visibility. Playback speed moves only the cursor.
- Generated traces use the `mulberry32` PRNG. Exponential inter-arrival gaps use `deterministicLn`, which uses only basic floating-point arithmetic, so every JavaScript engine produces the same trace.
- The UI derives each snapshot by folding a prefix of the immutable event log, with checkpoints to keep the folds short. Stepping backward and forward gives the same state.

## Input limits

`LIMITS` in `src/engine/config.ts` keeps the browser responsive:

| Limit | Value |
| --- | --- |
| Requests per trace | 500 |
| Total output tokens per trace | 400,000 |
| Tokens per request and maximum context length | 262,144 |
| Arrival time | 0 to 10,000,000 ms |
| KV blocks in the pool | 2,000,000 |
| Iterations per run | 60,000 |

## Share links and JSON export

A share link for an unchanged preset is `?scenario=<id>`. Any other configuration is `?v=1&cfg=<base64url JSON>`. The app validates a decoded configuration with the same schema as an import. Links carry at most 64 custom trace requests and 12,000 encoded characters. For larger traces, use **Export JSON**. If a link is invalid, the app says why and loads the default scenario.

**Export JSON** writes one document:

| Field | Content |
| --- | --- |
| `schemaVersion` | Export schema version, currently 1. |
| `simulatorVersion` | Simulator version, currently `1.0.0`. |
| `kind` | `inference-lab-export`. |
| `assumptions` | The model assumptions as text. |
| `config` | The full versioned configuration. |
| `seed` | The trace seed. |
| `trace` | The input trace in arrival order. |
| `panels` | Per panel: policy, effective scheduler, status, memory model, summary metrics, per-request metrics, event digest, and the full event log. |

**Import JSON** accepts an export or a bare configuration of at most 8 MiB. The app parses the file as JSON data and validates every field. It never runs the file as code or renders it as HTML. The app ignores the file's events and simulates again locally. If the new event digests differ from the file's, the app says so. All processing stays in the browser.

## References

The references ground the mechanisms. The simplifications on this page belong to this simulator, not to a production engine.

- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180), SOSP 2023. The paper describes block-based KV storage that limits fragmentation. Inference Lab borrows the per-request block allocation and the internal-fragmentation view.
- vLLM, [Optimization and Tuning](https://docs.vllm.ai/en/stable/configuration/optimization/). The page describes preemption and recomputation when KV space runs out, chunked prefill that schedules pending decodes before prefills, and the `max_num_batched_tokens` trade-off between ITL and TTFT. Inference Lab's token budget plays the role of `max_num_batched_tokens`, and its sequence limit plays the role of `max_num_seqs`. Inference Lab does not preempt.
- vLLM, [Metrics](https://docs.vllm.ai/en/stable/usage/metrics/). vLLM exports histograms such as `vllm:time_to_first_token_seconds`, `vllm:inter_token_latency_seconds`, `vllm:request_time_per_output_token_seconds`, `vllm:e2e_request_latency_seconds`, and `vllm:request_queue_time_seconds`. Inference Lab uses the same metric names, but its definitions are the ones in the table above.
- vLLM, [Automatic Prefix Caching](https://docs.vllm.ai/en/stable/features/automatic_prefix_caching/). Prefix caching reuses the KV cache of a shared prefix and skips its prefill, but it does not speed up decode. Inference Lab does not model it. Each request allocates its own blocks.

The vLLM pages were read from the vLLM documentation sources on 2026-10-27. vLLM's behavior changes between versions.
