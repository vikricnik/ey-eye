# Single Left Panel — Design

- **Date**: 2026-09-30
- **Branch**: `feature/yaml_based_pipelines`
- **Scope**: `web/` only
- **Mockup** (the agreed look and behaviour): `.superdesign/drafts/left-panel-c.html` (v3; `left-panel-c-v1.html`, `-v2.html` are earlier iterations)
- **Replaces** the layout from `docs/superpowers/specs/2026-09-29-side-panel-redesign-design.md` (top bar · canvas · settings column · run panel).

## Goal

One panel on the left, admin-panel style, holding everything that isn't the
canvas as foldable sections — so the canvas gets the full height and the rest
of the window, and every tool lives in one predictable place.

**Success:**

- the top bar is gone; its controls live in the panel header;
- node settings, chat, pipeline settings, tests and the node palette are
  sections of one panel; any number can be open at once, sharing its height;
- a message can be sent whichever sections are open;
- the panel can be resized and hidden;
- nothing the app does today is lost (undo, save, validation, re-run, traces,
  tests, notices, Esc to stop).

## Non-goals

- No visual restyle: same tokens (colors, JetBrains Mono, type scale,
  radius), same component styles. Only the layout changes.
- No behaviour change to running, editing, saving, validation, tests or the API.
- No change to the node/dependency settings' content or to the small
  foldable sections inside them (`editor/Section.tsx`, their saved folds).

## Layout

```
.app  (grid: panel | canvas; stacked at ≤ 960px)
├── LeftPanel (340–760px, default 440; hidden → 48px rail)
│   ├── PanelHeader    row 1: "LLM Pipeline" · status chip (● valid · unsaved) · API/Ollama dots · Aa · hide
│   │                  row 2: pipeline picker · ↶ ↷ · Save · File ▾
│   ├── Notices        undo offers, errors, Ollama outage, read-only
│   ├── Sections       split: open sections share the height; drag a header to re-split
│   │   ├── Node       node settings / dependency settings / hint when nothing is selected
│   │   ├── Chat       conversation picker, transcript + traces, toggles; folded: preview of the last exchange
│   │   ├── Pipeline   pipeline settings (today's foldable sections)
│   │   ├── Tests      TestsView as it is
│   │   └── Add node   the node palette
│   ├── Dock           the message box (Composer) — always there while the panel is shown
│   └── Rail           (hidden) show · state dot · one icon per section
├── Splitter           panel's right edge
└── Canvas             PipelineCanvas, full height
```

### Panel header

- **Row 1:** "LLM Pipeline" (accent, `--fs-lg`) · the status chip with the
  unsaved dot folded in (`● valid · unsaved`, `saved`, `invalid · node`,
  `N warnings`, `checking…`, `can't validate` — today's chip states,
  clickable when invalid as today) · the API and Ollama health lights as two
  dots (tooltip: `API · <url> · online|offline`, `Ollama · online|offline:
  <reason>`) · **Aa** (display settings, unchanged) · **hide** button
  (tooltip "Hide panel (⌘\)").
- **Row 2:** pipeline picker (takes the remaining width) · ↶ ↷ · **Save** ·
  **File ▾** (unchanged menu).
- When the panel is narrower than 400px, the status chip shows only its
  coloured dot; its text moves to the chip's tooltip.
- The ⚙ pipeline-settings button is removed — Pipeline is a section.

### Notices

The notices row (undo offers, errors with actions, the Ollama outage notice,
the read-only notice) moves from under the top bar to directly under the
panel header, full panel width. Behaviour is unchanged (auto-dismiss, Undo,
Retry, "reload latest").

### Sections

Order: **Node, Chat, Pipeline, Tests, Add node.**

Each section has a header row (32px): chevron · icon · title · one-line
summary (right-aligned, ellipsised) · a grip while it can be dragged. An open
section's header has a 3px accent bar on its left and an accent icon.

| Section | Title | Summary |
|---|---|---|
| Node | `Node · <id>`; `Dependency · <from> → <to>`; `Node` when nothing (existing) is selected | node: `<provider:model> · T <temperature>` (or `pipeline default · T …`); dependency: `<to> waits for <from>`; none: `nothing selected` |
| Chat | `Chat` | `N runs · last <duration>`; `running…` with a pulsing dot during a run; `no messages yet` |
| Pipeline | `Pipeline` | `<outputSummary> · history <off\|N turns>` |
| Tests | `Tests` | `N cases · P/N passed` after a run; `running k/N` during one; `N cases` before any; `no test cases` |
| Add node | `Add node` | `LLM node · N presets` |

- **Fold/open:** clicking the header's chevron/icon/title toggles it.
- **Split:** any number of sections can be open; open sections share the
  height between the header/notices and the dock, each scrolling on its own.
  Dragging the header of an open section that has an open section above it
  moves the boundary between the two (pointer drag; ↑/↓ on the focused
  header by 16px, Shift 64px). No open section is shorter than 76px.
- **First visit:** Node and Chat open, split 1 : 1.2; the rest folded.
- **Selecting** a node or dependency (canvas, a trace's node name, the
  invalid chip, adding or duplicating a node) opens the Node section. It
  does not un-hide a hidden panel.
- A selection whose node no longer exists (deleted, renamed, undone) shows
  as nothing selected — the existing `settingsSubject` rule.

**Section content**

- **Node:** today's node or dependency settings (`Inspector.tsx`), minus the
  node-name heading (the header shows it); title actions first (↻ Re-run from
  here, Duplicate, Save as preset, ⋯). With nothing selected: "Select a node
  or dependency on the canvas."
- **Chat:** today's `Chat` (conversation picker, transcript with a trace per
  run, format/open-traces toggles) — without the message box.
  - **Folded:** a preview under the header — the latest message
    (`› …`, one line) and the first two lines of its answer, live while it
    streams; `stopped`/`failed` shown for such runs; nothing when there are no
    messages. Clicking the preview opens Chat.
- **Pipeline:** today's pipeline settings, including their name/description
  and foldable sub-sections.
- **Tests:** today's `TestsView`, unchanged (its own Run buttons).
- **Add node:** today's palette (LLM node, presets with filter and ✕ remove);
  click adds below the selected node, drag onto the canvas adds there. The
  canvas's **+ Add node** button and popover are removed.

### Dock

Today's `Composer`, docked at the bottom of the panel, visible whenever the
panel is shown — including with Tests open (Tests' buttons say "Run …", the
dock's says "Send", so the two never read the same).

- One-line textarea that grows with its text (max ≈ 6 lines).
- Placeholder `Message <pipeline>…`; tooltip "Enter sends · Shift+Enter new
  line · Esc stops a run".
- Button: **Send**, **Save & send** with unsaved changes, **Stop** during a
  run; disabled with its reason as today.

### Resizing

The panel's right edge is the existing `Splitter` (grow +1):

- drag to resize; **340px** minimum; maximum **min(760px, 60% of the window)**;
- double-click resets to **440px**; ←/→ by 16px (Shift 64px) when focused;
- dragging it narrower than **240px** hides the panel.

The canvas keeps the selected node in sight when it narrows or widens
(`revealNode`), as today.

### Hiding

- **Hide/show:** the header's hide button, **⌘\ / Ctrl+\** (anywhere), or
  dragging the edge below 240px.
- **Hidden:** a 48px rail replaces the panel:
  - a show button (tooltip "Show panel (⌘\)");
  - the pipeline state as a dot: `--valid` saved, `--warn` unsaved,
    `--invalid` invalid; tooltip is the status chip's text;
  - one icon per section (tooltip = title · summary); open sections marked
    with an accent bar; a pulsing dot on Chat during a run and on Tests
    during a test run;
  - clicking a section icon shows the panel with that section open.
- The dock is hidden with the panel; Esc still stops a run.
- Showing the panel restores its width and sections as they were.

### Remembered

In the browser, under **`llm-pipeline.panel-layout.v1`**: width, hidden,
which sections are open, and the split weights. Unreadable or partial data
falls back to defaults per field. `llm-pipeline.panel-sizes.v3` (the old
column widths) is ignored. The node sub-sections' folds
(`llm-pipeline.inspector-sections`) are unchanged.

### Narrow screens (≤ 960px): stacked

- One column: the panel first (full width, 80vh, same sections and split),
  the canvas below (55vh); the page scrolls.
- The dock sticks to the bottom of the screen while any of the panel is in
  view (as the message box does today).
- No hide button, rail or edge resizing; the saved width and hidden state are
  left untouched for wide windows.

## Code structure

| File | Change |
|---|---|
| `web/src/ui/panelLayout.ts` (new) | pure layout logic: defaults, `readPanelLayout`, width clamp, hide threshold, fold/open, split re-weighting with the 76px minimum; replaces `ui/panelSizes.ts` |
| `web/src/ui/LeftPanel.tsx` (new) | panel shell: header, notices, sections area, dock, rail, edge splitter; owns `usePanelLayout` (state + persistence + ⌘\) |
| `web/src/ui/PanelSection.tsx` (new) | one section: header row (fold, split drag, summary, grip) and its scrolling body; optional folded preview |
| `web/src/ui/PanelRail.tsx` (new) | the hidden-panel rail |
| `web/src/ui/icons.tsx` | + section icons (node, chat, pipeline, tests, add, panel show/hide) |
| `web/src/editor/PipelineSettings.tsx` (new) | `PipelineInspector`, `HistorySettings`, `NodeDefaultsSettings` moved out of `Inspector.tsx` |
| `web/src/editor/Inspector.tsx` | node/dependency settings only; node heading removed |
| `web/src/editor/selection.ts` (new) | `settingsSubject` (+ `opensSettings`) moved from `SettingsColumn.tsx` |
| `web/src/run/chatPreview.ts` (new) | pure: the folded-Chat preview and the Chat summary line |
| `web/src/tests/testsSummary.ts` (new) | pure: the Tests summary line |
| `web/src/editor/AddNodeMenu.tsx` | → the palette only (button, popover, Esc/outside-click handling removed) |
| `web/src/editor/PipelineCanvas.tsx` | `topLeft` and `coveredRight` props removed |
| `web/src/editor/revealNode.ts` | `revealCenter` without the covered-width parameter |
| `web/src/App.tsx` | top bar and workspace replaced by `.app` = `LeftPanel` + canvas; ⚙ removed; `settingsOpen` / `panelTab` replaced by the panel layout |
| `web/src/style.css` | panel, header, section, rail, dock styles (existing tokens); top bar, workspace, settings column, run panel, floating/covered rules removed |
| deleted | `ui/RunPanel.tsx`, `editor/SettingsColumn.tsx`, `ui/panelSizes.ts` (+ `test/panelSizes.test.ts`, replaced) |
| `web/README.md` | Layout paragraph, file tree |

## Error handling

No new failure paths. Layout state reads fall back to defaults per field on
unavailable or corrupt storage (as `panelSizes` does today); writes that
fail are ignored for the page's lifetime.

## Testing

Unit (`node:test`, `web/test/`):

- `panelLayout.test.ts` — defaults; unreadable / partial / old-shape data;
  width clamp against the window; hide below 240px; fold/open; split
  re-weighting keeps both sections ≥ 76px and the total weight.
- `chatPreview.test.ts` — last exchange; streaming answer; stopped / failed;
  no messages; the Chat summary line.
- `testsSummary.test.ts` — no cases; before a run; during; after.
- `selection.test.ts` — the moved `settingsSubject` / `opensSettings` tests.
- `revealNode.test.ts` — updated for `revealCenter` without covered width.

Gates: `npm run typecheck`, `npm test`, `npm run build` in `web/`.

Browser checks (user's servers on :8000 / :5173) at 1920×1080, 1440×900,
1366×768, 1024×768 and 768×1024 (stacked), light and dark:

- editing a node while reading Chat; sending from the dock with Chat folded
  (preview streams);
- hide/show by button, ⌘\ and drag; rail icons, state dot, pulses; section
  icons open their section;
- resize limits, double-click reset, keyboard; the layout survives a reload;
- section fold/split, 76px minimum;
- Esc stops a run; notices under the header; File menu stays on screen;
  selection stays in view as the panel resizes;
- stacked layout: dock sticky, no rail/resizer.
