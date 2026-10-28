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
| Synchronized A/B comparison on the identical trace | `src/sim/compare.ts` merged cursor, shared time axis, differences strip | Done |
| Event-derived metrics for the full run or at the cursor, share links, JSON export and import | `src/sim/metrics.ts`, `src/ui/Results.tsx`, `src/sim/serialize.ts`, header actions | Done |
| KV blocks, batch size, and queue length over time | `src/sim/series.ts`, `src/ui/OverTime.tsx` | Done |
| Three or more curated scenarios, plus a one-token and an infeasible example | `src/sim/scenarios.ts`, [scenarios](scenarios.md) | Four presets |
| Model and scenario documentation, README with build and deployment steps | `docs/`, `README.md` | Done |

Interface details that are implemented: play, pause, next and previous event, reset, end, playback speed, a scrubber in 1/200 steps of the run, a time window, a clock that reads "623 ms / 871 ms (modeled)", a playback bar pinned while the page scrolls, keyboard shortcuts that skip inputs and a dialog that lists them, a faint preview of the whole run under the played part of each timeline, a strip that lists what differs between panels, a reduced-motion rule (the page has no decorative animation for it to remove, so it only guards future transitions), visible focus outlines, state shapes and labels in addition to color, request and iteration details, an event log, a 390 px layout with icon header actions and a panel switch, and an English string catalog in `src/ui/strings.ts`. The engine returns reason codes, and the catalog is typed against them, so a new code fails the build until it has text.

## How this release combines two implementations

This release replaces the earlier Inference Lab at [inference-lab.pages.dev](https://inference-lab.pages.dev), which was built independently. Each idea below was kept from the implementation that did it better, and the second one was rebuilt on this repository's engine rather than copied.

From this repository:
- **Integer microsecond time.** Every time is an integer count of microseconds (`msToUs`, `durationUs` in `src/sim/units.ts`). Event order and equality are exact, so replays are byte-identical and the two panels merge onto one cursor without tie-breaking epsilons. The earlier site kept times as fractional milliseconds and compared them with a `1e-9` tolerance in its UI code.
- **A single reducer.** `applyEvent` in `src/sim/state.ts` is the only writer of simulation state. The run loop applies each event as it emits it, and every read at a cursor replays the same events from checkpoints, so any state on screen is one the engine produced.
- **Memory caps.** Validation bounds total output tokens and total KV blocks, and the run stops at 100,000 iterations or 400,000 scheduled records. A 1 KB share link can no longer ask the browser for gigabytes.
- **Cursor-consistency tests.** Tests step through every event of every preset and check that request metrics, wait reasons, arrival lists, and now the over-time samples agree with the replayed state.

From the earlier site:
- **Faint full-run preview** (3e3dbde), so the shape of the run is visible before Play.
- **Pinned playback bar** (a48caa4), so Play and the scrubber stay reachable while the inspectors are in view.
- **What differs between panels** (fc9a755), so one strip states every policy and limit difference instead of markers spread over the page.
- **Shortcuts dialog** (9ed7a59), so the keys are discoverable, rendered from the same table the key handler reads.
- **Results at the cursor** (6215b58), so the metrics can agree with the inspectors at the playhead. This release keeps Final as the default, where the earlier site opened on the cursor, so the A/B outcome shows on first load.
- **Over-time charts** (dfada72), because the inspectors show one instant and cannot show how memory and the queue trend. This release draws A and B on one shared y scale per measure and on the timelines' time axis, window, and playhead, and samples them in one replay into typed arrays.
- **Deploy script** (8b94796), so `npm run deploy` runs the full check before it uploads.
- **Head-count check** (8889a55), because MHA and GQA need the query-head count to be a multiple of the KV-head count, and a shape such as 32 query heads over 6 KV heads used to pass validation.

## Verification performed

- **Unit tests.** `npm test` runs 67 tests on the engine, all passing. They cover every bullet of brief section 12: G = 1 and the P + G − 1 boundary, exact block boundaries and a decode crossing one, per-request rounding and fragmentation, reservation and eventual completion, release-once and block ownership, exact-limit budgets, oversized whole prompts, simultaneous arrivals and arrivals during an iteration, event causality, byte-identical replay, forward and backward stepping against fresh replays, hand-checked metrics, and configuration and export round trips. A property test drains 40 seeded random traces under both policies with zero invariant violations after every event, including peak KV never below current allocation. Cursor tests step through every event of every preset and check that request metrics, wait reasons, arrival lists, and each over-time sample agree with the replayed state. Further tests cover the memory caps, exported events keyed by request id, and idle gaps in the over-time series.
- **End-to-end tests.** `npm run test:e2e` runs 31 Chromium checks, all passing. They load a preset and play it, preview the run faintly before Play, keep Play on screen at 1440 px and 390 px while scrolling, step and reset with buttons and keys, check End, speed, and the shortcuts dialog, confirm shortcuts are ignored inside inputs, read the clock and the scrubber's announced value, change a shared control and a per-panel override and read them in the differences strip, surface validation errors in words, compare A and B, switch the results to the cursor and match them against the timelines, draw the over-time charts and seek by clicking one, explain a request and an iteration, round-trip a share link and a broken one, open links from the earlier site, keep edits across a reload, load a link pasted into an open tab, export and re-import with history verification, recover from an injected engine fault, open the model dialog, check 390 px for horizontal overflow, the compact header, and the panel switch, and play with reduced motion. The tests added for results at the cursor, the over-time series and charts, the clock, and the compact header were each run against the code before their change and failed there.
- **Type checks and build.** `npm run check` runs the unit tests, `tsc -b`, and `vite build`. It passes. The production bundle is 339 KB of JavaScript (104 KB gzip) and 15 KB of CSS (4.0 KB gzip).
- **Layout inspection.** Desktop at 1440 px and mobile at 390 px were inspected in Chromium screenshots, compared against the earlier site's. Fixes made from that inspection include: the axis unit label overlapped the last tick, dense token marks read as chevrons, a no-wrap rule squeezed the batch table on phones, the event log did not follow the playhead, per-request memory rows hid tokens being written, identical FIFO wait reasons repeated once per request, the clock with its run length overflowed the 390 px bar, and the KV chart's scale rounded a 518-block peak up to 1,000.
- **Chart colors.** The over-time pairs were checked with a color-vision validator against the panel surface: lime against gray separates by ΔE 20.8 under deuteranopia, and gray against amber by 14.8 under protanopia and 16.3 with normal vision. Lime against amber failed the normal-vision floor (ΔE 13.6), so the batch area is gray.
- **Cost.** Measured in Node 24.9 on the engine alone. Browser numbers were not measured.
  - The shipped presets build both panels in a median of at most 0.95 ms (kv-pressure, 60 runs, p90 2.9 ms).
  - A 512-request trace near the 250,000-output-token cap builds in 155 to 196 ms on a cold first run (three processes) and 83 ms warm (median of 20), retains 98 MiB of heap, and seeks to a random event in at most 0.28 ms.
  - Before the memory caps, adversarial share links of about 1.1 KB built 1.5 GiB or more. Today one of the three fails validation, one drains in about 135 ms retaining 106 MiB, and one stops at the record cap in 58 ms retaining 76 MiB.
  - The over-time series for both panels cost a median 0.061 ms for the largest preset (burst, 1,340 events, 60 runs), about 8.5% of building the comparison, and 8.0 ms for the near-cap trace (8.6%). The pass replays the event log once through `applyEvent`, the same work as the checkpoint pass inside the build, which is why the share holds steady. That limiter is read from the code, not from a profile.
  - Summarizing one panel at the cursor costs a median of at most 0.072 ms on the presets, so At cursor recomputes on every playhead move without memoizing beyond the state.

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
- The timeline virtualizes rows and thins marks when they get dense. It does not aggregate iterations in the strip, so whole-run views of several thousand iterations draw one rectangle each. The over-time charts draw one step per iteration the same way.
- The over-time charts sample at iteration starts, so a request that arrives during an iteration joins the waiting line at the next sample. Their accessible names summarize peaks, and the hover readout lists every series at one time, but there is no table view of the samples.
- The design system's state colors are lighter than the color validator's lightness band for chart series, and the reserved line is a deliberate neutral gray below its chroma floor. Separation passes, and each series also differs by shape (area or line) and has a legend.
- Header action tooltips use the native `title` attribute, which touch screens do not show. On a phone the label is still the accessible name, but a sighted user sees only the icon.
- At 390 px the playback bar grew from 120 px to 137 px to fit the run length on the clock. The header shrank from 182 px to 98 px, so the pair takes 67 px less than before.
- The model's cost coefficients are illustrative. Fitting them to the owner's GPU experiments, live benchmark import, prefix caching, preemption, and multi-GPU serving are outside this release.
- Policy B can hold a prompt back indefinitely if decodes keep filling the budget. The finite presets end, but no starvation freedom is claimed.
- An error boundary catches an engine invariant failure, which would be a bug, during the first load or while drawing, and offers the default scenario. A failure inside an edit, a scenario pick, a hash change, or an import is not routed to it. The previous run stays on screen and the error reaches only the console.
- Scenario prose quotes engine outputs (the 166 ms iteration, 871 ms makespan). Only the block counts are checked by a test, so a cost-default change could leave the text stale. A rerun for this release found one such drift: `Long` TTFT in B is 240 ms, not 241 ms, in the README and the scenarios page.
- Iterations keep `prefillTokens` and `decodeTokens` beside the same counts in `cost`, and checkpoints replay the event log a second time after the run. Both are small duplications.
- Skip records are stored per iteration. The record cap bounds them, but a recompute-on-demand design would remove them.
