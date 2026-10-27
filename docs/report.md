# Implementation report

[Back to Inference Lab](../README.md)

This report covers release 1.0.0 of Inference Lab (`inference-lab`), built on the `feat/inference-lab` branch.

## Completed capabilities

| Required capability | Where it lives | Status |
| --- | --- | --- |
| Request lifecycle: arrival, waiting, admission, prefill, decode, completion | `src/sim/state.ts` phases and events, `src/sim/engine.ts` run loop, request timeline | Done |
| Memory model: weights with a declared metadata allowance, runtime allowance, paged KV cache | `src/sim/memory.ts`, memory inspector | Done |
| Continuous batching | Iteration planning at every decision instant, iteration strip, batch inspector | Done |
| Whole-prefill baseline and decode-first chunked prefill | `src/sim/scheduler.ts` (`POLICIES`) | Done |
| Synchronized A/B comparison on the identical trace | `src/sim/compare.ts` merged cursor, shared time axis, override markers | Done |
| Event-derived metrics, share links, JSON export and import | `src/sim/metrics.ts`, `src/sim/serialize.ts`, header actions | Done |
| Three or more curated scenarios, plus a one-token and an infeasible example | `src/sim/scenarios.ts`, [scenarios](scenarios.md) | Four presets |
| Model and scenario documentation, README with build and deployment steps | `docs/`, `README.md` | Done |

Interface details from the brief that are implemented: play, pause, next and previous event, reset, playback speed, scrubber, time window, keyboard shortcuts that skip inputs, a reduced-motion rule (the page has no decorative animation for it to remove, so it only guards future transitions), visible focus outlines, state shapes and labels in addition to color, request and iteration details, an event log, a 390 px layout with a panel switch, and an English string catalog in `src/ui/strings.ts`. The engine returns reason codes, and the catalog is typed against them, so a new code fails the build until it has text.

## Verification performed

- **Unit tests.** `npm test` runs 57 tests on the engine, all passing. They cover every bullet of brief section 12: G = 1 and the P + G − 1 boundary, exact block boundaries and a decode crossing one, per-request rounding and fragmentation, reservation and eventual completion, release-once and block ownership, exact-limit budgets, oversized whole prompts, simultaneous arrivals and arrivals during an iteration, event causality, byte-identical replay, forward and backward stepping against fresh replays, hand-checked metrics, and configuration and export round trips. A property test drains 40 seeded random traces under both policies with zero invariant violations after every event, including peak KV never below current allocation. Cursor tests step through every event of every preset and check that request metrics, wait reasons, and arrival lists agree with the replayed state. Further tests cover the memory caps and exported events keyed by request id.
- **End-to-end tests.** `npm run test:e2e` runs 14 Chromium checks, all passing. They load a preset and play it, step and reset with buttons and keys, confirm shortcuts are ignored inside inputs, change a shared control and a per-panel override, surface a validation error, compare A and B, explain a request and an iteration, round-trip a share link and a broken one, keep edits across a reload, load a link pasted into an open tab, hide the prefill-chunk override on a whole-prefill panel, export and re-import with history verification, open the model dialog, check 390 px for horizontal overflow and the panel switch, and play with reduced motion.
- **Type checks and build.** `npm run check` runs the unit tests, `tsc -b`, and `vite build`. It passes. The production bundle is 323 KB of JavaScript (100 KB gzip) and 11 KB of CSS.
- **Layout inspection.** Desktop at 1440 px and mobile at 390 px were inspected in Chromium screenshots. Fixes made from that inspection: the axis unit label overlapped the last tick, dense token marks read as chevrons, a no-wrap rule squeezed the batch table on phones, the event log did not follow the playhead, per-request memory rows hid tokens being written, and identical FIFO wait reasons repeated once per request.
- **Cost.** Measured in Node 24.9: the shipped presets build both panels in under 4 ms. A 512-request trace near the 250,000-output-token cap builds both panels in about 157 ms, retains about 98 MiB of heap, and seeks to a random event in at most 0.2 ms. Adversarial share links of about 1.1 KB, which built 1.5 GiB or more before the memory caps (an extrapolated 23 GiB for one), now either fail validation or stop as truncated runs within about 200 to 265 MiB of heap in 0.2 to 0.4 s. Browser numbers were not measured.

## Decisions worth knowing

- **One reducer for the run and for every read.** The engine applies each event through `applyEvent` as it emits it. The UI replays the same events from checkpoints, so a displayed state is always one the engine produced. This replaced a design that stored a full snapshot per event, whose probe measured about 57 MB for an A/B pair at 200 requests and 5,000 iterations.
- **Allocate at iteration start, populate at iteration end.** This mirrors schedulers that allocate slots before the forward pass. Between iterations, allocated blocks equal `ceil(cachedTokens / blockSize)` exactly.
- **Context overruns are input errors, memory overruns are per-request rejections.** P + G above the context limit invalidates the configuration, as the brief calls it an input rule. A reservation larger than the empty pool marks only that request infeasible.
- **Policy A's budget check skips infeasible requests.** A request rejected at arrival never needs a prefill, so it does not make the A/B configuration incompatible.
- **Share links use the URL fragment,** so the configuration never reaches a server.
- **The dev server uses port 5188.** The companion project's dev server commonly holds 5173, and Playwright would otherwise reuse it outside CI.

## Adversarial review

Two reviewers checked the full branch, and every finding below was reproduced with a script before it was acted on. Fixed:
- Unbounded memory from small share links.
- Exported events pointing at the wrong requests for unsorted traces.
- History-derived metrics and timeline marks running ahead of the replayed state.
- Stale wait reasons.
- Peak KV below current allocation.
- Truncated runs dropping unreached requests from the SLO denominator.
- Unreachable scheduler branches.
- A URL fragment that went stale after edits and ignored pasted links.
- Selections that followed an index across rebuilds.
- A prefill-chunk override offered on a panel whose policy ignores it.

The findings left open are listed below.

## Remaining limitations

- Nothing has been deployed. The Cloudflare Pages settings are documented and `wrangler.jsonc` is ready.
- Heap use for traces near the size cap was measured in Node, not in a phone browser. Per-iteration entry records probably dominate it, since that run holds about 500,000 of them. That is a guess from the counts, not a profile. The engine runs on the main thread, and a Web Worker would be the next step if large imports feel slow.
- Only Chromium runs in the end-to-end suite.
- Explicit traces are editable in the panel up to 32 requests. Larger ones go through JSON import.
- The timeline virtualizes rows and thins marks when they get dense. It does not aggregate iterations in the strip, so whole-run views of several thousand iterations draw one rectangle each.
- The model's cost coefficients are illustrative. Fitting them to the owner's GPU experiments, live benchmark import, prefix caching, preemption, and multi-GPU serving are outside this release.
- Policy B can hold a prompt back indefinitely if decodes keep filling the budget. The finite presets end, but no starvation freedom is claimed.
- An error boundary catches an engine invariant failure, which would be a bug, during the first load or while drawing, and offers the default scenario. A failure inside an edit, a scenario pick, a hash change, or an import is not routed to it. The previous run stays on screen and the error reaches only the console.
- Scenario prose quotes engine outputs (the 166 ms iteration, 871 ms makespan). Only the block counts are checked by a test, so a cost-default change could leave the text stale.
- Iterations keep `prefillTokens` and `decodeTokens` beside the same counts in `cost`, and checkpoints replay the event log a second time after the run. Both are small duplications.
- Skip records are stored per iteration. The record cap bounds them, but a recompute-on-demand design would remove them.
