# Model reference

[Back to Inference Lab](../README.md)

Inference Lab is a deterministic simulation of one logical GPU serving a decoder-only Transformer with full attention. This page states every rule the engine applies. Where a rule resembles a production engine, the resemblance is named and the difference is stated. Nothing here reproduces measured hardware results.

## Scope

Supported: one logical GPU, a conventional decoder-only Transformer with full attention, and MHA or GQA through an explicit KV-head count. The query-head count must be a multiple of the KV-head count, so every KV head serves an equal group of query heads.

Excluded from this release: MLA, sliding-window attention, recurrent or hybrid layers, tensor or pipeline parallelism, prefix caching and block sharing, disaggregated prefill and decode, speculative decoding, KV offloading, preemption and recomputation, autoscaling, stochastic end-of-sequence, and live benchmark import. The policy registry (`POLICIES` in `src/sim/scheduler.ts`), the event union (`SimEvent` in `src/sim/state.ts`), and the memory plan (`planMemory`) are the extension points.

## Units and time

- Memory is counted in bytes. The UI shows binary units: 1 KiB is 1,024 bytes, 1 MiB is 1,024 KiB, 1 GiB is 1,024 MiB.
- Simulated time is an integer count of microseconds. The UI shows it as "ms (modeled)".
- An iteration's duration is its modeled cost in milliseconds, rounded to whole microseconds with a minimum of 1 µs.

## Requests and traces

Each request has a stable id, an arrival time, a positive prompt length P, and a positive output budget G. The engine generates exactly G output tokens.

A configuration is invalid when any request has P + G greater than the maximum context length. This is a conservative input rule. Maximum context length is a validity limit, not a count of occupied KV positions.

A trace is explicit (a list of requests) or generated from a seed. Generated traces use mulberry32, a 32-bit integer PRNG, and avoid transcendental math, so a seed yields the same trace in every JavaScript engine. Arrival patterns are uniform spacing, uniform spacing with jitter, or a burst of uniformly random times inside a window.

Requests are ordered by (arrival time, position in the input). That order is also FIFO admission order and the tie-break for every other rule.

## Token semantics

The engine uses this convention:

1. A prefill chunk writes K/V entries for the prompt tokens it processes.
2. The final prefill chunk produces logits and emits the first output token. Earlier chunks emit nothing.
3. An emitted token has no KV entry until a later decode iteration consumes it.
4. Each decode consumes the previously emitted token, appends its K/V entry, and emits the next token.
5. Before release, a request with P prompt tokens and G output tokens holds P + G − 1 populated KV positions.
6. With G = 1 the request completes after prefill and has no decode iteration.

Generated tokens, populated KV positions, and allocated block capacity are separate counters. A request cannot finish its prefill and run its first decode in the same iteration, because the first token exists only when the prefill iteration ends.

## Memory accounting

For the supported full-attention architecture:

```
kvBytesPerToken = 2 × numLayers × numKvHeads × headDim × kvElementBytes
```

The factor 2 counts keys and values. KV heads, not query heads, set the size, so GQA shrinks the cache in proportion to the KV-head count.

```
packedWeightBytes   = parameterCount × weightBits / 8
weightMetadataBytes = packedWeightBytes × weightMetadataPercent / 100
weightBytes         = packedWeightBytes + weightMetadataBytes
kvPoolBytes         = deviceBytes − weightBytes − runtimeAllowanceBytes
kvBlockBytes        = blockSizeTokens × kvBytesPerToken
totalBlocks         = floor(kvPoolBytes / kvBlockBytes)
```

- The runtime allowance is a declared, fixed reservation for activations, workspaces, and framework state. The simulator does not model it further.
- The metadata allowance covers quantization scales and zero points. When weights are below 16 bits and the allowance is zero, the memory inspector says the packed size understates real residency.
- A configuration is rejected when weights plus the runtime allowance do not fit, or when the remainder holds no whole block. Bytes left after the last whole block are shown as the unusable tail.
- Weight precision, KV element size, and compute cost are independent inputs. Switching to 4-bit weights frees memory for KV blocks but changes neither KV bytes per token nor any iteration's duration.

### Blocks

Blocks belong to exactly one request. Each request rounds separately:

```
occupiedBlocks(request) = ceil(kvTokens(request) / blockSizeTokens)
```

The unused slots in each request's last block are internal fragmentation. The memory inspector sums them per request rather than rounding the combined token count.

Blocks for the tokens an iteration writes are allocated when the iteration starts. The tokens count as populated when it ends. While an iteration runs, the inspector shows those tokens as "being written". Between iterations, allocated blocks equal `ceil(cachedTokens / blockSizeTokens)` for every live request.

Block ids are stable integers. Fresh ids ascend from a high-water mark, and released ids are reused last-in, first-out. The engine never allocates an array the size of the device.

### Admission reservation

This is the simulator's own policy. It does not reproduce vLLM's admission algorithm.

```
reservedBlocks(request) = ceil((P + G − 1) / blockSizeTokens)
```

- Admission is strict FIFO. The head request is admitted when an active-sequence slot is free and its reservation fits in the unreserved blocks (total blocks minus the sum of active reservations).
- When the head does not fit, admission stops. Requests behind it wait even if they are smaller. This is head-of-line blocking, and the UI names the head and its shortfall.
- The reservation is an accounting guarantee, not a second allocation. Allocated blocks never exceed a request's reservation. Reserved headroom is the difference, and it shrinks as KV grows.
- Because every admitted request holds a reservation for its final length, active requests can never exhaust the free blocks while still needing more. No preemption is required.
- A request whose reservation exceeds the empty pool is infeasible. It is rejected when it arrives, with the block counts as its reason, and never enters the queue.
- A completed request releases its blocks and its reservation exactly once, in the same decision instant its last token is emitted. Its metrics remain.

vLLM's documentation describes the other approach. When KV space runs out, vLLM preempts requests and recomputes them later ([optimization guide](https://docs.vllm.ai/en/stable/configuration/optimization/)). The reservation here trades some capacity for never needing preemption.

## Scheduling

### Shared rules

- Both panels use the same trace, architecture, memory, cost model, and SLO. A panel may override the active-sequence limit, the iteration token budget, or the maximum prefill chunk. The UI marks every override next to the panel name.
- The active-sequence limit caps admitted, unfinished requests. An iteration selects a subset of them, counting each selected request once.
- Each decode counts as one scheduled token. Exactly filling the token budget or the sequence limit is valid.
- Decode order in both policies is least recently served first, with ties broken by admission order. When the budget cannot cover every decode, service rotates across iterations.
- Required KV blocks are confirmed against the request's reservation before an iteration is committed.

### Decision instants

At each decision instant t, the engine does this in order:

1. Complete the iteration ending at t and emit its output tokens.
2. Release requests that have emitted all G tokens, in admission order.
3. Apply arrivals with arrival time ≤ t, in trace order. Reject infeasible ones.
4. Admit from the FIFO queue.
5. Plan and start the next iteration.

A request that arrives strictly inside a running iteration is recorded at its own timestamp and becomes eligible at the next instant. New work never interrupts a running iteration. When nothing is active, the engine jumps to the next arrival. The run ends when every request has completed or been rejected. Every iteration schedules at least one token, so a valid configuration always makes progress. Two safety limits end a run early with an explicit "truncated" outcome instead of hanging or exhausting the tab: 100,000 iterations, and 400,000 recorded batch entries and skip records per panel. Validation also rejects a trace whose completion reservations total more than 2,097,152 KV blocks, and one with more than 250,000 output tokens. Together these bound the memory a share link or import can make the page use.

### Policy A: whole-prefill baseline

1. Admitted requests awaiting prefill take priority, in FIFO order. Each prompt runs whole and is never split.
2. Selection stops at the first prompt that does not fit the remaining budget. Later prompts do not skip ahead.
3. The remaining budget goes to eligible decodes.

Every prompt must fit the policy's full token budget. Otherwise the configuration is reported as incompatible for that panel, rather than exceeding the budget or chunking silently. vLLM's guide states the analogous rule: without chunked prefill, `max_num_batched_tokens` must exceed `max_model_len`.

### Policy B: decode-first chunked prefill

1. Eligible decodes are scheduled first, in the shared decode order.
2. The remaining token and sequence capacity goes to FIFO prefill chunks of `min(remaining prompt, maximum chunk, remaining budget)`.
3. A partly processed prompt continues from its cached prefix.

This mirrors the idea in vLLM's guide that chunked prefill prioritizes decodes and fills the leftover `max_num_batched_tokens` with prefill chunks. It is not a replay of any vLLM version. Neither policy guarantees freedom from starvation under unbounded load. Under Policy B a large enough stream of decodes can hold a prompt back, and the finite demo traces simply end.

## Cost model

Each iteration's modeled duration in milliseconds is a sum of five terms:

```
duration = overheadMs
         + prefillTokenMs × Σ q
         + attentionMsPerMillionPairs × Σ (q·c + q(q+1)/2) / 10⁶
         + decodeSequenceMs × decodes
         + decodeContextMsPerThousandTokens × Σ (c + 1) / 10³
```

| Coefficient | Default | Meaning |
| --- | --- | --- |
| `overheadMs` | 4 ms per iteration | Fixed cost of one engine step: launch, weight streaming, and sampling |
| `prefillTokenMs` | 0.02 ms per prompt token | Projection and MLP work, proportional to new prompt tokens |
| `attentionMsPerMillionPairs` | 2 ms per million pairs | Causal attention for a chunk of q new tokens after c cached ones |
| `decodeSequenceMs` | 0.2 ms per decode | Per-sequence projection and MLP work for one token |
| `decodeContextMsPerThousandTokens` | 0.4 ms per 1,000 positions | KV reads: a decode attends over its c cached positions plus its own |

- `q·c + q(q+1)/2` counts query-key pairs. Each new token attends to the c cached tokens, to itself, and to earlier new tokens in the chunk. Over a whole prompt the chunks sum to P(P+1)/2 pairs however the prompt is split, so chunking does not save attention work in this model.
- A mixed iteration's terms add with no overlap. The model does not assume prefill compute hides decode memory traffic. Output tokens are emitted at iteration end.
- A configuration where any nonempty iteration would take zero time is rejected.
- The defaults are chosen so scenarios read clearly. They are not measurements. Modeled busy time is not GPU utilization, MFU, or hardware efficiency, and lower-precision weights are not assumed to run faster.

Because the terms add, chunking redistributes latency rather than creating free throughput. In the long-prefill scenario both panels finish at 871 ms. Chunking shortens the longest stall and delays the chunked request's first token.

## Metrics

All metrics are computed from event timestamps.

| Metric | Definition |
| --- | --- |
| Initial queue delay | Arrival to the start of the first iteration that runs the request |
| TTFT | Arrival to the first emitted output token |
| E2E latency | Arrival to the final emitted output token |
| ITL | Each gap between consecutive output tokens of one request |
| TPOT | (last token time − first token time) / (G − 1). N/A when G = 1 |
| Throughput | Completed requests and emitted output tokens per second of modeled time, over the interval from the first arrival to the last event |
| SLO attainment | Requests with TTFT ≤ threshold and TPOT ≤ threshold, divided by every arrived request |

- Percentiles use nearest rank: the value at rank ceil(p/100 × n) of the sorted sample. The UI prints the sample count n next to each percentile.
- Empty samples, and throughput over a zero-length interval, are N/A, never 0, NaN, or infinity.
- Completed, unfinished, waiting, and infeasible requests are counted separately. Infeasible and unfinished requests stay in the SLO denominator, so failures cannot make latency look better. When a run stops at a safety limit, requests it never reached also count as unfinished. TPOT is not checked for one-token outputs.
- The request-level outcome table lists every request's status, TTFT, E2E, and SLO result in both panels.
- Results default to the full run. **At cursor** computes the same metrics from each panel's replayed state at the playhead: only tokens emitted so far count, a running request has no E2E or TPOT yet, SLO attainment covers only requests that have finished or were rejected (a running request is not yet a miss), and the throughput interval ends at the panel's last applied event.
- The over-time charts sample each panel once per iteration, at its start: allocated and reserved KV blocks, requests in the iteration, waiting requests, and active requests. Between iterations a panel is idle, so every series is zero there.

These definitions resemble vLLM's production metrics `vllm:time_to_first_token_seconds`, `vllm:inter_token_latency_seconds`, `vllm:request_time_per_output_token_seconds`, `vllm:e2e_request_latency_seconds`, and `vllm:request_queue_time_seconds` ([metrics page](https://docs.vllm.ai/en/stable/usage/metrics/)). The names show which production signal each one corresponds to. vLLM does not necessarily compute them identically.

## Determinism and stepping

- The engine is pure TypeScript with no React, DOM, clock, or randomness outside the seeded trace generator. The same configuration and seed produce byte-identical exports.
- One reducer (`applyEvent`) is the only writer of simulation state. The engine applies each event as it emits it. The UI reads state at a cursor by replaying events from the nearest checkpoint with the same reducer, so the UI can only show states the engine produced. Checkpoints are taken every max(64, events / 400) events. Per-request metrics, timeline marks, and wait reasons at the cursor are gated on that replayed state (phase, generated tokens, iterations started), not on the playhead time, so stepping through events that share a timestamp never shows a token, a release, or a wait figure the state has not reached.
- The two panels' events merge by (time, A before B, event order). The playhead is a position in that merged list, so both panels stay synchronized by simulated time, and next and previous step one event in either panel.
- Playback speed, frame rate, resizing, and tab visibility move only the playhead. The run is computed once per configuration.

## Sharing and export

- Share links carry the configuration and seed as versioned base64url JSON in the URL fragment, which never reaches a server. Links longer than 8,000 characters are refused with a suggestion to export instead. A `?cfg=` link from the earlier version of the site cannot be read. It opens the default scenario with a notice. A share link that fails validation does the same, and the address bar then shows `#scenario=long-prefill`.
- Export writes the schema version, simulator version, model assumptions, configuration, seed, materialized trace, memory plan, every event, iteration records, and result summaries. Iteration indices in the export count from 0. The page numbers iterations from 1.
- Import accepts an export or a bare configuration. The text is parsed with `JSON.parse` and validated field by field. It is never evaluated or rendered as HTML, and labels containing markup are rejected. The engine rebuilds the run and reports whether the file's event history matches. Files over 20 MiB are refused.

## References

- vLLM documentation, [Optimization and tuning](https://docs.vllm.ai/en/stable/configuration/optimization/). Chunked prefill prioritizes decodes and chunks prefills to fit `max_num_batched_tokens`. Preemption with recomputation handles KV exhaustion.
- vLLM documentation, [Production metrics](https://docs.vllm.ai/en/stable/usage/metrics/).
- vLLM documentation, [Automatic prefix caching](https://docs.vllm.ai/en/stable/features/automatic_prefix_caching/). It reuses KV blocks for shared prefixes and shortens prefill only. This release excludes it. Shared, reference-counted blocks would be the extension.
- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180), SOSP 2023. Fixed-size KV blocks per request follow its paging idea. The simulator does not reproduce the paper's measurements.

The vLLM pages were consulted on 2026-10-27 through their Markdown sources in the vLLM repository, because the documentation site was rate-limiting requests.
