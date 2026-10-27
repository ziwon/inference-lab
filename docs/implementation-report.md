# Implementation report

This report covers Inference Lab 1.0.0 (configuration version 1, export schema version 1). It lists what the release delivers, how it was verified on 2026-10-27, and what it leaves out.

## Delivered capabilities

### Simulation engine

- A pure TypeScript discrete-event engine in `src/engine/`, separate from React. Identical configuration, seed, and trace give identical event logs.
- The request lifecycle: arrival, FIFO waiting, admission, prefill, decode, and completion. Runs end in an explicit `completed` or `blocked` state, and an idle engine jumps to the next arrival.
- The token convention from [the model reference](model.md#requests-and-token-conventions). The final prefill chunk emits token 1. Each decode consumes the previous token. A request reaches `P + G - 1` populated positions before it completes. `G = 1` completes after prefill.
- A memory model with weights, a declared quantization-metadata allowance, a runtime allowance, and a paged KV pool. Weight precision and KV precision are independent inputs, and neither one changes the cost model.
- A per-request block allocator with completion-capacity reservations at admission, FIFO head-of-line blocking, and infeasible-request removal. The allocator checks its invariants, and the tests run those checks after every iteration.
- Two scheduling policies: the whole-prefill baseline and decode-first chunked prefill. They share one round-robin decode order. The whole-prefill panel reports an incompatible configuration if a prompt exceeds its token budget.
- A four-term cost model in modeled milliseconds, with the causal attention term `q * c + q * (q + 1) / 2`. Validation rejects coefficients that allow zero-duration iterations.
- Event-derived metrics: queue delay, TTFT, ITL, TPOT, E2E, throughput over a defined window, SLO attainment, and goodput. An empty sample gives N/A. Percentiles use nearest rank and show the sample count.

### Interface

- A request timeline with A and B lanes on one time axis. It shows waiting, prefill chunks, decode iterations, output-token ticks, and completion. Each state has a label and a shape as well as a color. The timeline has its own scroll container and zoom.
- A batch inspector for the current iteration. It shows the scheduled requests, the token and sequence budgets, the cost breakdown, and the reason for every run or deferral.
- A memory inspector that shows weights, the runtime allowance, allocated blocks, reservation headroom, unreserved blocks, populated positions, and internal fragmentation.
- A details inspector for a selected request or iteration, and an event log.
- A configuration panel with validated fields. An invalid draft shows an error, and the simulation keeps the last valid value.
- Playback controls: play, pause, next event, previous event, reset, jump to end, speed, and a scrubber. Keyboard shortcuts ignore keys typed into a field.
- An A/B bar that lists every setting that differs between the panels. A results panel compares aggregates and requests at the cursor or at the end of the run.
- Share links, JSON export, and validated JSON import.
- Four presets with an explanation of what to observe, the assumption that matters, and what the result does not establish.
- A model panel that shows the equations with the live values.
- A layout that works at 390 px and on desktop, visible focus states, and a skip link. With reduced motion requested, the app turns off CSS transitions and animations. Playback never starts on its own.
- English strings in `src/i18n/en.ts`, organized for more languages.

### Documentation

- [README](../README.md) with setup, development, test, build, and Cloudflare Pages deployment steps.
- [Model reference](model.md) with the token conventions, equations, units, allocator and reservation policy, scheduler behavior, exclusions, and references.
- [Scenario guide](scenarios.md) with modeled numbers from each preset.

## Verification

All commands ran in this workspace on Node.js 24.9.0.

| Check | Command | Result |
| --- | --- | --- |
| Type checking | `npm run typecheck` | No errors. |
| Unit tests | `npm test` | 51 of 51 pass in 5 files. |
| End-to-end tests | `npm run test:e2e` | 7 of 7 pass in Chromium. |
| Production build | `npm run build` | `dist/` holds 355 kB of JavaScript (108 kB gzip) and 29 kB of CSS. |

The unit tests cover the items in the original test plan:

- `accounting.test.ts` covers the token and KV accounting, `G = 1`, the `P + G - 1` boundary, exact block boundaries, and a decode that crosses into a new block. It also covers per-request rounding, fragmentation, KV heads against query heads, weight precision independence, double frees, and allocations beyond a reservation.
- `scheduler.test.ts` covers reservation blocking with eventual completion, infeasible removal, the sequence limit at admission, and exact-limit token budgets. It also covers oversized whole prompts, round-robin decodes, simultaneous arrivals, arrivals during an iteration, event causality, deterministic replay, and backward and forward stepping.
- `metrics.test.ts` checks every metric against a small trace computed by hand, including N/A for empty samples and infeasible requests in the SLO denominator.
- `serialization.test.ts` covers share-link and export round trips, malformed and oversized input, unknown keys, schema versions, and seeded trace generation.
- `scenarios.test.ts` checks that every preset completes deterministically and shows its mechanism. One test checks that LONG is admitted while the short requests still decode.

The end-to-end tests load a preset, play, pause, and step. They check that shortcuts do not fire inside fields and that changing **Max prefill chunk** re-simulates and updates the link. They also cover the synchronized A/B view, sharing, export and re-import, an invalid link, and the 390 px layout.

These checks ran in addition to the test suites:

- A script ran every preset and the variations in the scenario guide through the engine. Each "Try this" claim in the app and in [the scenario guide](scenarios.md) matches the engine output.
- The production build was served with `vite preview` and captured at 1440 by 1000 and at 390 by 844. The captures showed no horizontal page overflow and no console errors.

## Changes in the final session

- An end-to-end test located **Max prefill chunk** by its label text. The hint glyph inside the label broke the exact match, so the test timed out. It now locates the field by its accessible name.
- `selectBatch` now looks up policies in a typed `SELECTORS` table. The share-link parser and the policy menus read `POLICIES` instead of their own lists. Behavior is unchanged, and every test passes.
- The README, the model reference, the scenario guide, and this report are new.

## Limitations

- The model has one logical GPU and full-attention MHA or GQA. MLA, sliding-window attention, hybrid models, parallelism, prefix caching, speculative decoding, offloading, and preemption are outside this release.
- Admission is this simulator's conservative reservation policy. It is not vLLM's admission algorithm. The preset results do not describe production capacity.
- Cost coefficients are illustrative and are not fitted to hardware. The model sums the parts of a mixed batch and does not model overlap.
- The policies are not proven free of starvation under unlimited incoming load. The demo traces are finite and complete.
- Runs stop after 60,000 iterations. A trace can hold at most 500 requests and 400,000 output tokens.
- The end-to-end tests run only in Chromium. Firefox and Safari were not tested.
- The vLLM pages could not be fetched from docs.vllm.ai during this session because the server returned HTTP 429. The references were checked against the vLLM documentation sources in the vLLM repository, which can differ slightly from the published stable pages.
- The workspace is not a Git repository. `package-lock.json` is present, but nothing has been committed.
- The site has not been deployed.
