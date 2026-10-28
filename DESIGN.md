# Inference Lab visual system

Direction: a quiet engineering instrument. The request timeline is the main visual material. Everything else explains the timeline at the playhead. The style follows the companion [NCCL Lab](https://nccl-lab.pages.dev/): neutral charcoal surfaces, compact controls, monospace only for counters and computed values.

## Tokens

All colors, spacing, and type live as CSS custom properties in `src/ui/styles.css`. Components never hard-code a color.

- Surfaces: page `#121416`, inset `#15181b`, panel `#1b1f23`, raised `#22272c`, hover `#2b3138`. Separators `#363e47`. Control borders `#616c78`, which are stronger than separators.
- Text: primary `#e6e9ed`, secondary `#b6bfc9`, muted `#a0aab6`. Muted text keeps at least 4.5:1 contrast on panel surfaces.
- Accent: pale lime `#b2e879` marks primary actions, selection, and keyboard focus.
- Type: the system UI sans-serif stack and the system monospace stack. No web fonts, so the page makes no third-party requests.

## Request states

Every state has a shape and a text label as well as a color, so the timeline stays readable without color.

| State | Timeline mark | Color token |
| --- | --- | --- |
| Waiting (arrived, not admitted) | Dashed outline bar | amber `--state-waiting` |
| Admitted, awaiting first prefill | Thin outline bar | gray `--state-admitted` |
| Prefill chunk | Tall solid block, one per chunk | cyan `--state-prefill` |
| Decode iteration | Short solid tick on a thin bar | lime `--state-decode` |
| Output token emitted | Small diamond at the emit time | text color |
| Completed | Square end cap and a check glyph | lime |
| Infeasible | Cross glyph and the reason label | red `--state-error` |

Each timeline draws the whole run faintly (`--ghost-opacity`) under the played part, so the shape of the run is visible before Play. The faint layer is the same marks read at the run's final state, and it thins dense rows by the same rule as the played layer: a row draws individual decode ticks and tokens only when the visible window has room for them.

The legend repeats the shapes. Batch and memory inspectors reuse the same tokens. Prefill is cyan and decode is lime everywhere.

## Composition

Desktop, 1200 px and wider:

1. Header: product name, the "Educational model, not a hardware benchmark" note, and the actions Model assumptions, Keyboard shortcuts, Import, Export JSON, and Share link.
2. Playback bar, across both columns and pinned to the top of the viewport while the page scrolls: reset, previous event, play or pause, next event, the scrubber, the modeled time with the event counter, speed, and time window. One scrubber step is 1/200 of the run, and the scrubber announces its value as modeled time, such as "37.4 ms of 871 ms (modeled)".
3. Left column: scenario picker with the scenario's explanation (what to observe, the assumption that matters, what it does not establish), then the compact configuration groups.
4. Main column, top to bottom:
   - What differs between panels: each panel's policy, then every scheduler limit that a panel sets away from the shared value, with both panel values and the shared value. A limit that a panel's policy ignores is struck through for that panel and marked "not used by panel A". The strip ends with what both panels share. It is the one place that lists differences, so panel headers carry only the panel letter and policy name.
   - Request timelines for A and B on one shared time axis with one playhead. Each timeline has an iteration strip above its request rows. The strip draws every iteration as a bar whose width is its modeled duration. Each timeline scrolls inside its own container.
   - Batch and memory inspectors, A beside B.
   - Details inspector for the selected request, iteration, or event, beside the event log.
   - Comparison results: aggregate metrics with sample counts, then request-level outcomes.

Narrow screens, down to 390 px, stack the same sections in reading order. The playback bar comes right after the header in a compact three-row form, so Play is on screen on first load and stays pinned while the page scrolls. A segmented control picks panel A or B for the inspectors. The configuration groups collapse. The page itself never scrolls horizontally. Wide content such as timelines and tables scrolls inside its own container.

## Behavior

- Keyboard: `Space` plays or pauses, `←` and `→` step one event, `Home` resets, `End` jumps to the end, `+` and `-` move through the speed options, and `?` opens the shortcuts dialog, which the Keyboard shortcuts button in the header also opens. The dialog renders from the same table the key handler reads, so it lists every shortcut. Esc or Close shuts it and focus returns to what opened it. Shortcuts are ignored while focus is in an input, select, textarea, editable element, or open dialog.
- Focus: every interactive element shows a 2 px lime outline on `:focus-visible`.
- Reduced motion: with `prefers-reduced-motion: reduce`, transitions and smooth scrolling are off. Playback still advances, because it changes state rather than decorating it.
- Copy: short sentences for engineers. Each estimate names the model that produced it. Units are explicit: bytes shown as KiB, MiB, or GiB (binary), time as "ms (modeled)".
- Strings live in `src/ui/strings.ts`. Components read text from it, and the engine returns reason codes with parameters rather than English sentences.
