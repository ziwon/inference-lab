# Scenarios

[Back to Inference Lab](../README.md)

Each preset is deterministic: the same preset always produces the same events. The numbers below come from the shipped presets with the default synthetic 8B GQA architecture (32 layers, 8 KV heads, head dimension 128, 128 KiB of FP16 KV per token, 16-token blocks of 2 MiB). They are outputs of the [model](model.md), not hardware measurements.

Open a preset directly with `#scenario=<id>`, for example `#scenario=kv-pressure`.

## Long prefill interruption (`long-prefill`)

Six short requests (P = 160 to 256, G = 96) arrive between 0 and 50 ms and start decoding. A 6,144-token prompt (`Long`, G = 32) arrives at 150 ms. `R8` (P = 200) arrives at 200 ms. Both panels share a 24 GiB device (3,634 blocks), a 16-sequence limit, and an 8,192-token budget. Panel B chunks prefill at 512 tokens.

The preset is built so the long request gets an admission slot and its 386-block reservation immediately in both panels, while the short requests are still decoding. It demonstrates scheduling, not admission blocking.

**What to observe.**

| Outcome | A, whole prefill | B, chunked prefill |
| --- | --- | --- |
| Longest gap between tokens (ITL max) | 166 ms | 22 ms |
| ITL p99 | 12.5 ms | 22.3 ms |
| `Long` TTFT | 171 ms | 241 ms |
| `R8` TTFT | 133 ms | 27 ms |
| Last event | 871 ms | 871 ms |
| SLO attainment (TTFT ≤ 200 ms, TPOT ≤ 20 ms) | 8 of 8 | 7 of 8 |

In A, iteration 24 runs the whole 6,144-token prompt together with the six decodes. It lasts 166 ms, so each short request waits 166 ms for one token, and `R8` waits behind it. In B the prompt runs as twelve chunks of 16 to 22 ms beside the decodes. The stall disappears, but every chunk pays the per-iteration overhead again and shares its iteration with decodes, so the long request's first token comes later and misses the TTFT threshold. ITL p99 is higher in B because more gaps are mid-sized, while A has one very large gap per request.

**Assumption that matters.** Costs add with no overlap, so a mixed iteration lasts as long as its prefill and decode work combined. Total work is the same in both panels, which is why both finish at 871 ms.

**What this does not establish.** It does not show that chunked prefill is faster on real hardware, or that its ITL benefit has this size. Kernel fusion, compute and memory overlap, and bandwidth limits change the balance.

## KV pressure (`kv-pressure`)

Twenty requests with P = 1,500 to 3,000 and G = 64 to 160 arrive over 600 ms (seeded, jittered). The device has 20 GiB, which leaves 1,586 KV blocks after 14.9 GiB of FP16 weights and a 2 GiB runtime allowance. Each completion reservation is roughly 100 to 200 blocks, so only about ten requests fit at once. The SLO is relaxed to TTFT ≤ 1,500 ms and TPOT ≤ 25 ms.

**What to observe.**

- Early in a request's life its reservation is mostly headroom. The per-request bars in the memory inspector fill as decode appends KV, and headroom shrinks.
- At 900 ms, R11 is the queue head. It needs 178 reserved blocks, only 76 are unreserved, and R12 through R20 wait behind it. The batch inspector groups them in one row.
- The head waits even though 130 blocks are physically free (1,586 minus 1,456 allocated in panel A). Reservation, not occupancy, limits admission.
- Head-of-line blocking appears in 145 of A's admission decisions and 152 of B's. Peak allocation reaches 1,536 of 1,586 blocks in A and 1,516 in B.
- TTFT p50 is 327 ms in A and 408 ms in B. TTFT p90 is about 2.5 s in both, because late requests wait for earlier ones to release memory. 11 of 20 requests meet the SLO in each panel.
- Raise **Prompt max**, the request count, or the block size to grow the waiting. Lower **Weight precision** to 4-bit to see the extra blocks shorten it.

**Assumption that matters.** Admission reserves ceil((P + G − 1) / block size) blocks, a conservative policy that never needs preemption.

**What this does not establish.** Production engines admit optimistically and preempt or swap under pressure, so their capacity and waiting times differ. Real memory also includes activations that this model folds into one fixed allowance.

## Burst arrivals (`burst`)

Twenty-four requests (P = 256 to 1,536, G = 24 to 128) arrive within 20 ms. The scheduler allows 8 active sequences and a 4,096-token budget. Panel B chunks prefill at 512 tokens. Memory is not a constraint here (3,634 blocks, peak about 580).

**What to observe.**

- Admission waits on sequence slots: the head is blocked by the active limit in about 200 admission decisions in each panel.
- TTFT p50 is 1.1 s in both panels because most requests wait for a slot. The spread differs. TTFT p90 is 1,972 ms in A and 2,006 ms in B. ITL max is 90 ms in A and 77 ms in B.
- 8 of 24 requests meet TTFT ≤ 400 ms and TPOT ≤ 20 ms in each panel. The request-level table shows which ones, and which request moves between panels.

**Assumption that matters.** Admission is strict FIFO, so a slow head request delays everyone behind it.

**What this does not establish.** A real router or engine may reorder, shed, or autoscale. This trace is one fixed synthetic burst, not a load test.

## Edge cases (`edge-cases`)

A 17 GiB device leaves a 50-block pool (800 tokens). Four requests:

- `OneToken` (P = 96, G = 1) finishes after its prefill. It has no decode iteration and its TPOT is N/A. It holds 96 = P + G − 1 KV positions before release.
- `TooBig` (P = 1,200, G = 16) fits the 8,192-token context but needs ceil(1,215 / 16) = 76 blocks to finish. The empty pool has 50, so it is rejected at arrival and leaves the queue without blocking anyone.
- `R3` and `R4` run normally.

**What to observe.** Infeasible requests stay in the counts and in the SLO denominator. Attainment is 3 of 4, not 3 of 3.

**Assumption that matters.** Maximum context length is a validity limit. It is separate from how many KV positions a request occupies.

**What this does not establish.** Real servers may truncate, offload, or return an error instead of rejecting a request this way.

## Making your own

Edit any preset in the configuration panel. The scenario badge changes to "Custom configuration". Explicit traces of up to 32 requests are editable in place. For larger traces, export JSON, edit the `config.trace.requests` list (up to 512 requests), and import it. Share links work for any configuration that encodes to 8,000 characters or fewer.
