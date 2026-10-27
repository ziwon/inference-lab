# Scenarios

Inference Lab ships four deterministic presets. Each one isolates one mechanism and runs the same trace through both policies. Panel A runs the whole-prefill baseline, and Panel B runs decode-first chunked prefill. Select a preset from **Scenario** in the header, or open `?scenario=<id>`.

Every number on this page is modeled milliseconds from the default cost model in [the model reference](model.md). The numbers come from running each preset through the engine. They are not hardware measurements. They change if you change a coefficient.

| Preset | Id | Mechanism |
| --- | --- | --- |
| Long prefill interruption | `long-prefill` | A long prompt arrives while short requests decode. |
| KV cache pressure | `kv-pressure` | Reservations fill the KV pool, so admission waits. |
| Burst arrivals | `burst` | 32 requests arrive at once and exceed the sequence limit. |
| Edge cases | `edge-cases` | A one-token output, an infeasible request, and an exact block boundary. |

## Long prefill interruption

Six short requests (R1 to R6, prompts of 128 to 256 tokens) arrive in the first 50 ms and start decoding. At 320 ms, LONG arrives with a 4,000-token prompt and 40 output tokens. R7 and R8 arrive at 420 ms and 470 ms, while LONG's prompt is still in progress. The token budget is 4,096, the sequence limit is 16, and Panel B's chunk size is 512.

The preset gives LONG an admission slot and enough reservation capacity in both panels. Both panels admit LONG at the next iteration boundary, 5.9 ms after it arrives. The comparison shows scheduling, not admission.

### What to observe

- Panel A runs LONG's whole prompt in one 281 ms iteration (326 ms to 607 ms). Every decoding request emits nothing during that iteration. R1's largest gap between tokens is 281 ms.
- Panel B splits the prompt into 512-token chunks and runs the decodes first in every iteration. R1's largest gap drops to 56 ms.
- LONG's own first token arrives later in Panel B: 372 ms after arrival, against 287 ms in Panel A. Panel B spreads the prompt over 8 iterations. Each extra iteration pays the 8 ms overhead again, and the decodes and the R7 and R8 prompts that share those iterations add their cost.
- R7 and R8 wait behind LONG's prefill in Panel A. Their TTFTs are 219 ms and 169 ms in Panel A, and 83 ms and 89 ms in Panel B.
- Both panels meet the SLO (TTFT 250 ms, TPOT 20 ms) for 8 of 9 requests. LONG misses the TTFT target in both panels.

### Assumption that matters

Prefill cost grows with prompt length, through the linear term and the causal attention pairs. Every iteration pays a fixed overhead, so splitting work into more iterations costs time.

### What this does not establish

Real chunking benefits depend on kernels, batch shapes, and hardware. The modeled milliseconds show the shape of the trade-off, not its size on a GPU.

### Try this

- Set **Max prefill chunk** to 4096. Panel B then prefills LONG in one chunk, and both panels produce the same batches and the same metrics.
- Set **Max prefill chunk** to 256. LONG's TTFT in Panel B grows to 447 ms, R1's largest gap shrinks to 38 ms, and R7's TTFT drops to 41 ms.

## KV cache pressure

A seeded trace (seed 7) sends 24 requests with a mean gap of 60 ms. Prompts have 1,024 to 2,048 tokens and outputs have 128 to 320 tokens. Device memory is 20 GiB with a 2 GiB runtime allowance, which leaves 1,586 blocks of 16 tokens. The sequence limit is 32, so the KV pool, not the sequence limit, decides admission.

### What to observe

- In the memory inspector, reserved blocks run well ahead of allocated blocks. The difference is reservation headroom, which is capacity promised to admitted requests but not yet populated. At the peak, 1,576 of 1,586 blocks are reserved and at most 1,508 are allocated.
- The queue head waits with "needs N blocks, M unreserved". Requests behind it wait too, even when they are smaller. This is head-of-line blocking. Each panel records 9 admission waits on the KV reservation.
- Allocated blocks grow one block at a time as decodes cross block boundaries. Internal fragmentation stays below one block per request.
- Waiting dominates the latency. TTFT p90 is about 5.6 s in both panels, and 14 of 24 requests meet the SLO (TTFT 2 s, TPOT 30 ms).

### Assumption that matters

This simulator reserves `ceil((P + G - 1) / blockSize)` blocks per request at admission and never preempts. The reservation guarantees that every admitted request finishes. The cost is idle capacity, because no new request can use the headroom.

### What this does not establish

vLLM admits more optimistically and can preempt and recompute requests when KV space runs out. This preset does not show production admission behavior or production KV capacity.

### Try this

- Set **KV element** to 1 byte. The pool doubles to 3,173 blocks and no request waits for KV. TTFT p90 drops to about 1.5 s. SLO attainment falls to 7 of 24 in Panel A and 9 of 24 in Panel B, because larger batches raise TPOT above the 30 ms target.
- Set **Weight precision** to 4 bits instead. The pool grows to 7,308 blocks, and the results match the 1-byte KV run exactly. Weight precision changes memory only, not speed, and neither run waits for KV.
- Raise the output range or the request count under **Workload** to increase the pressure.

## Burst arrivals

A seeded trace (seed 42) sends 32 requests at the same instant, 100 ms. Prompts have 64 to 1,536 tokens and outputs have 32 to 256 tokens. The sequence limit is 16 and the token budget is 2,048. The KV pool has room for every reservation.

### What to observe

- Both panels admit the first 16 requests at 100 ms. The other 16 wait at the sequence limit and enter as earlier requests complete.
- Prefill tokens fill the early iterations, and decodes fill the later ones. While prompts are queued, both policies fill the token budget, so the aggregates are close. TTFT p50 is 811 ms in Panel A and 798 ms in Panel B. Both panels meet the SLO (TTFT 1 s, TPOT 25 ms) for 16 of 32 requests.
- The request rows differ more than the aggregates. R1 has a 949-token prompt. Its TTFT is 67 ms in Panel A and 268 ms in Panel B.
- In Panel A, the first iteration runs only R1's prompt. R2's 1,319-token prompt does not fit the remaining 1,099 tokens, so R2 and every prompt behind it wait for the next iteration. That iteration takes 67 ms.
- In Panel B, the 512-token chunk cap splits R1's prompt over two iterations. The first iteration fills the whole budget with chunks from five prompts and takes 133 ms.
- ITL p99 is 106 ms in Panel A and 78 ms in Panel B.

### Assumption that matters

Iteration time grows with the scheduled tokens. A full 2,048-token budget makes an iteration slow however the prompts are split.

### What this does not establish

A sustained, open-ended load can behave differently. This finite trace does not test starvation or fairness.

### Try this

Open **Scheduler**, then **Panel overrides**, and set Panel B's token budget to 512. Panel B's largest gap between tokens drops from 138 ms to 46 ms. Its TTFT p50 rises from 798 ms to 990 ms.

## Edge cases

This preset collects the boundary cases that the tests also cover. Device memory is 16 GiB with a 0.5 GiB runtime allowance, which leaves 306 blocks of 16 tokens (4,896 positions). The token budget of 8,192 holds every prompt, so both panels produce the same results.

| Request | P | G | What happens |
| --- | --- | --- | --- |
| `ONE` | 200 | 1 | Completes right after prefill, with no decode iteration. TTFT and E2E are both 20.1 ms. TPOT is N/A. |
| `HUGE` | 6,000 | 64 | Needs `ceil(6063 / 16) = 379` blocks, more than the 306 in an empty pool. The engine marks it infeasible with that reason and removes it from the queue. |
| `NEXT` | 300 | 40 | Arrives behind `HUGE` while `ONE` runs. At the next boundary (20.1 ms), the engine removes `HUGE` and then admits `NEXT`. `NEXT` waits only for the running iteration. |
| `EDGE` | 16 | 17 | Prefill fills exactly one block. The first decode allocates a second block. At completion it holds `16 + 17 - 1 = 32` positions, exactly its 2 reserved blocks. |

The results panel counts `HUGE` as infeasible and as not meeting the SLO. It does not drop `HUGE` from the totals, so SLO attainment is 3 of 4.

### Assumption that matters

The engine judges feasibility against the conservative completion reservation of `P + G - 1` positions.

### What this does not establish

An engine with offloading, preemption, or sharding could serve `HUGE`. Those mechanisms are outside this release.

### Try this

Set **Device memory** to 24 GiB. The pool grows to 4,402 blocks and `HUGE` completes, with a TTFT of 474 ms in Panel A and 565 ms in Panel B.
