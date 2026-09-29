# Side Panel Redesign — Design

- **Date**: 2026-09-29
- **Branch**: `feature/yaml_based_pipelines`
- **Scope**: `web/` only — the side panel beside the canvas, and the wiring in `App.tsx` it needs

## Problem

The side panel shows one view at a time — Chat, Settings, Add, Trace or Tests —
and switches views on its own:

- selecting a node switches to **Settings**, so the answer being read disappears;
- sending a message switches back to **Chat** (unless on Trace);
- **Tests** hides the message box;
- a node's own trace sits behind a second, inner Configuration/Trace tab bar.

The core loop — tweak a node, send a message, read the answer, tweak again —
keeps pushing one view out to show another.

## Goals

These pairs must be visible at the same time:

1. node settings + Chat
2. Chat + Trace
3. node settings + that node's trace
4. Tests + node settings

It must work on a laptop (≈1280–1500px wide) and use the room on a large
monitor (≥1600px).

**Success:** select a node, edit it, send a message, read the answer and its
trace — without any view switching away on its own; tests can run while a
node is edited.

## Non-goals

- No visual restyle: theme tokens, type sizes, contrast and all 14 UX review
  fixes (`UX_REVIEW.md`) stay.
- No behavior change to running, editing, undo, saving, validation or the API.
- No change to the top bar (beyond the gear's pressed state) or the canvas
  (beyond the Add button and keeping the selection in view).
- The narrow stacked layout (≤960px) keeps working but is not the design
  target.

## Design

### 1. Layout

The workspace becomes three columns:

```
┌ top bar ─────────────────────────────────────────┐
├────────────────┬─────────────┬───────────────────┤
│                │ path     ✕  │ [Chat] [Tests]    │
│     canvas     │ node b      │                   │
│                │ ▸ Trace     │ › question        │
│  (a)─(b)─(c)   │ ▸ Model     │   ▸ Trace · 3     │
│                │ ▸ Prompts   │   answer …        │
│ [+ Add node]   │ …           ├───────────────────┤
│                │             │ message …    Send │
└────────────────┴─────────────┴───────────────────┘
   canvas          settings        run panel
```

- `canvas | settings | run`, each border a `Splitter`. Defaults: **settings
  380px**, **run 420px**. Chosen widths are remembered per browser under a new
  storage key (`llm-pipeline.panel-sizes.v3`); the v2 value is ignored.
- Widths are clamped as today: each column has a usable minimum (settings
  320px, run 320px) and never squeezes the canvas below 280px.

**When the settings column is open**

| Trigger | Result |
|---|---|
| A node or dependency is selected (canvas click, a node name in any trace, adding a node) | column opens showing it |
| The gear beside the pipeline picker | column opens showing the pipeline's settings |
| Click on empty canvas | selection clears; the column (if open) shows the pipeline's settings |
| ✕ in the column header | column closes; the canvas gets the width back |

- The column is **not** closed by deselecting — that would resize the canvas
  on every pane click and make the graph jump.
- **Esc keeps its one job** — stopping a run or a test run. It does not close
  the column.
- When the column opens or widens and the selected node ends up outside the
  visible canvas, the canvas pans to bring it back into view.

**Adapting to the window**

`settingsPlacement(sizes, windowWidth)` decides by the space the canvas would
keep, not by a fixed breakpoint:

| Canvas would keep | Settings column |
|---|---|
| ≥ 480px | **docked** — its own grid column. (1366px laptop, default widths → canvas ≈ 566px) |
| < 480px | **floating** — overlays the canvas's right edge with a shadow; the run panel keeps its column, the canvas keeps its full width beneath |
| window ≤ 960px | existing **stacked** layout: canvas, then settings (when open), then the run panel; the message box stays sticky at the bottom |

**Run panel**: two tabs, **Chat** and **Tests**. The message box sits under
Chat and stays hidden on Tests (so two different "Run" buttons never share the
screen). Nothing switches these tabs except the user.

**Top bar**: unchanged, except the gear shows `aria-pressed` while the column
is open with the pipeline's settings.

### 2. Settings column

**Header** — a thin bar with the path and a close button:
`consensus-qa › node`, `consensus-qa › dependency`, or `consensus-qa` for the
pipeline itself; clicking the pipeline name opens its settings. This is the
existing breadcrumb, moved out of the node and dependency views into the
column header so it's always in the same place. ✕ sits at the right.

**Node settings**

- The Configuration/Trace sub-tabs are removed.
- The node's trace becomes a foldable **Trace** section — the first section,
  under the node title and any validation problem. It is a regular `Section`,
  so its open/closed state is remembered across nodes like the others.
- Folded, its summary reads e.g. `run 3 · 1.8s`, `run 3 · live` while the
  node is running, or `hasn't run yet`.
- Open, its body is height-capped (≈40% of the column) and scrolls on its
  own, so the node's input/reply can be read while the model and prompt
  fields below stay in view. Latest run first, earlier runs after; it streams
  live.
- Title actions (↻ Re-run from here, Duplicate, Save as preset, ⋯), every
  other section, validation and read-only handling are unchanged.

**Dependency and pipeline settings**: content unchanged; only the breadcrumb
moves to the column header.

The term stays **Trace** everywhere (per UX-010's single-name rule).

### 3. Run panel and "Add node"

**Chat with the trace built in**

- Each turn gets a collapsible **Trace · N nodes** row between the message and
  the answer (where the "node outputs" block is today). Open, it shows what the
  Trace tab showed for that run: every node in start order, what it received
  and replied, streaming live; the latest run's rows carry their ↻ re-run
  buttons.
- Clicking a node name in a trace selects that node — the settings column
  shows it; Chat stays put.
- The "show every node's output" checkbox becomes **open traces**: whether
  each run's trace starts open (kept for the session, like the checkbox it
  replaces). Any single trace can still be folded or opened. The node-output
  cards (`NodeCard`) are removed — the trace holds the
  same outputs and more.
- Scrolling: Chat follows new content **only while already at the bottom**
  (the rule the Trace tab uses today), so a streaming trace doesn't yank the
  view while an earlier turn is being read.
- The Trace tab is removed; its per-run rendering moves into the chat turn,
  still built from `MessageEntry` rows.

**Tests**: unchanged; the message box stays hidden there. Selecting a node
while on Tests opens the settings column beside it.

**"+ Add node" on the canvas**

- A button in the canvas's top-left corner opens a popover with today's
  palette: a blank LLM node, then the presets (with the filter when there are
  more than five, and each preset's ✕ remove). It is placed and behaves like
  the display-settings popover.
- Items work as today: click to add (below the selected node, connected to
  it), or drag onto the canvas. The popover stays open during a drag (removing
  the drag source mid-drag can cancel the drop in some browsers) and closes
  after a node is added, on Esc, or on an outside click.
- While the popover is open, Esc closes it instead of stopping a run.
- Not editable → the button is disabled and its tooltip says why (UX-011).
- Copy that points to the old places is updated to **+ Add node**: the canvas
  hint ("…from the Add tab…"), the save-as-preset dialog ("…from the
  sidebar"), the preset description placeholder and the new-pipeline hint.

## Code structure

| File | Change |
|---|---|
| `ui/SidePanel.tsx` → `ui/RunPanel.tsx` | `PanelTab = "chat" \| "tests"`; tabs + body + message box footer |
| `editor/SettingsColumn.tsx` (new) | column shell: header (path + ✕), docked/floating class; wraps `Inspector` |
| `editor/Inspector.tsx` | drops `NodeTab` state, the sub-tabs and the `Breadcrumb` uses; adds the Trace `Section` |
| `editor/NodeTrace.tsx` (new) | `NodeMessages` moved out of `Inspector.tsx` as `NodeTrace`, plus pure `nodeTraceSummary()` |
| `run/MessagesView.tsx` → `run/RunTrace.tsx` | one turn's trace rows, used inside each chat turn |
| `run/Chat.tsx` | collapsible trace per turn; `verbose` → `openTraces`; `NodeCard` removed; stick-to-bottom scrolling |
| `editor/Sidebar.tsx` → `editor/AddNodeMenu.tsx` | the same palette inside a button + popover |
| `editor/PipelineCanvas.tsx` | `topLeft` slot for the Add button; keeps the selected node in view when the canvas narrows |
| `ui/panelSizes.ts` (new) | pure sizing logic moved out of `Splitter.tsx`: two widths, v3 key, `settingsPlacement()` |
| `ui/Splitter.tsx` | keeps the `Splitter` component and `usePanelSizes` hook, now over two widths |
| `App.tsx` | `settingsOpen` state; removes the selection→tab effect and the Trace/Add branches; three-column JSX; Esc exception while the Add popover is open |
| `style.css` | workspace grid (docked / floating / closed), floating column, stacked layout ≤960px |

Refactoring is limited to what this change needs. The top bar, theme, API
client (`packages/client`) and CLI are untouched.

## Error handling

No new failure paths: sizes and section states already tolerate unavailable
or corrupt `localStorage` (fall back to defaults); the same applies to the v3
key. Run, test and validation errors render exactly as today (the run error
stays in the chat turn; its trace rows show where it stopped).

## Testing

Pure logic, in the existing `node:test` style (`web/test/*.test.ts`):

- `panelSizes.test.ts` (rewritten): clamping both widths; a v2-only value is
  ignored; `settingsPlacement()` is docked at 1280 / 1366 / 1920 and floating
  at 1100 with default widths.
- `canvasHint.test.ts`: the hint names **+ Add node**.
- `nodeTrace.test.ts` (new): summary for never run, finished, and running.
- Off-screen check for keeping the selected node in view.
- Stick-to-bottom predicate.

Gates: `npm run typecheck`, `npm test`, `npm run build` in `web/`.

Browser check (API on `:8000`, Vite on `:5173`): 1366×768, 1100 (floating),
1920 (docked) and 768 (stacked), light and dark; each of the four pairings;
Esc stopping a run vs. closing the Add popover; drag-and-drop and click-to-add
from the popover. A live streaming run is verified only if Ollama is running.
