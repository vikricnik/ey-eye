# Single Left Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top bar, settings column and run panel with one resizable, hideable panel on the left whose foldable sections (Node, Chat, Pipeline, Tests, Add node) share its height, with the message box docked at its bottom.

**Architecture:** The layout's rules (widths, hiding, which sections are open, how the height is split, what's saved) are pure functions in `ui/panelLayout.ts`, used by a `usePanelLayout` hook that saves them in the browser. `LeftPanel` renders the header, notices, `PanelSection`s and the dock (or `PanelRail` when hidden); `App` supplies each section's content, which is today's components (`Inspector`, `Chat`, `PipelineSettings`, `TestsView`, `NodePalette`). Header lines for each section are pure functions too.

**Tech Stack:** React 19, TypeScript 5.7, Vite 6, `@xyflow/react` 12, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-30-single-left-panel-design.md` · mockup `.superdesign/drafts/left-panel-c.html`

## Global Constraints

- Only `web/` changes; no new dependencies. Never stage `.superdesign/`.
- Panel width: default **440px**, min **340px**, max **min(760px, 60% of the window)**; dragging below **240px** hides it; the rail is **48px**; an open section is never shorter than **76px**; stacked at a window **≤ 960px**.
- First visit: **Node** and **Chat** open, split **1 : 1.2**; Pipeline, Tests, Add node folded. Section order: Node, Chat, Pipeline, Tests, Add node.
- Saved under **`llm-pipeline.panel-layout.v1`**; `llm-pipeline.panel-sizes.v3` is ignored; `llm-pipeline.inspector-sections` (node sub-section folds) is unchanged.
- Hide/show: header button, **⌘\ / Ctrl+\**, or dragging the edge below 240px. Tooltips: "Hide panel (⌘\ / Ctrl+\)", "Show panel (⌘\ / Ctrl+\)".
- Dock placeholder `Message <pipeline>…`; tooltip "Enter sends · Shift+Enter new line · Esc stops a run".
- Styling: existing tokens only (`--panel`, `--border`, `--accent`, …); every `font-size` from `--fs-*` (`test/readability.test.ts` enforces it).
- Gate after every task, from `web/`: `npm run typecheck` and `npm test`. Tasks 4–7 also `npm run build`.
- Commit after each task (`feat(web): …` / `refactor(web): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A layout saved on a wide monitor, opened on a laptop** (`width: 760`, window 1100): the panel shows at 660px (60%), and the saved 760 is untouched for the monitor. Pinned by `clampWidth` tests (Task 1) and a browser check (Task 7).
2. **Saved state that's odd but valid, or broken** — every section folded, unknown ids, negative weights, the old `{"settings","run"}` shape: the panel loads, folded stays folded, junk falls back per field. Pinned by `readPanelLayout` tests (Task 1).
3. **A window so short that two open sections can't both have 76px**: dragging between them changes nothing and nothing collapses to zero or negative. Pinned by a `resizeSplit` test (Task 1).
4. **Hidden panel + narrow window** (hidden saved, then the window is 800px wide): the stacked panel shows; widening the window again brings back the rail. Pinned by `shownHidden` tests (Task 1) and a browser check (Task 7).
5. **Hiding the panel mid-run**: the run keeps going, Esc still stops it, the rail's Chat icon pulses, and showing the panel brings back the dock and the Chat preview. Browser check in Task 7; the code is Tasks 4–5.

---

### Task 1: Panel layout logic

**Files:**
- Create: `web/src/ui/panelLayout.ts`
- Test: `web/test/panelLayout.test.ts`

**Interfaces:**
- Produces (in `web/src/ui/panelLayout.ts`):
  - `type SectionId = "node" | "chat" | "pipeline" | "tests" | "add"`; `SECTION_ORDER: readonly SectionId[]`
  - `interface PanelLayout { width: number; hidden: boolean; open: Record<SectionId, boolean>; weights: Record<SectionId, number> }`
  - constants `DEFAULT_WIDTH` 440, `MIN_WIDTH` 340, `MAX_WIDTH` 760, `HIDE_BELOW` 240, `RAIL_WIDTH` 48, `MIN_SECTION_HEIGHT` 76, `STACKED_MAX_WIDTH` 960, `PANEL_LAYOUT_STORAGE_KEY`, `DEFAULT_LAYOUT: PanelLayout`
  - `readPanelLayout(raw: string | null): PanelLayout`
  - `clampWidth(width: number, windowWidth: number): number`
  - `dragWidth(layout: PanelLayout, width: number, windowWidth: number): PanelLayout`
  - `toggleSection(layout: PanelLayout, id: SectionId): PanelLayout`; `openSection(layout, id): PanelLayout`
  - `openAbove(layout: PanelLayout, id: SectionId): SectionId | null`
  - `resizeSplit(layout: PanelLayout, above: SectionId, below: SectionId, heights: { above: number; below: number }, dy: number): PanelLayout`
  - `isStacked(windowWidth: number): boolean`; `shownHidden(layout: PanelLayout, windowWidth: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `web/test/panelLayout.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_LAYOUT,
  HIDE_BELOW,
  MIN_SECTION_HEIGHT,
  clampWidth,
  dragWidth,
  isStacked,
  openAbove,
  openSection,
  readPanelLayout,
  resizeSplit,
  shownHidden,
  toggleSection,
} from "../src/ui/panelLayout";

describe("readPanelLayout", () => {
  it("uses the defaults when nothing (readable) was saved", () => {
    for (const raw of [null, "{oops", "null", "[]", "5"]) assert.deepEqual(readPanelLayout(raw), DEFAULT_LAYOUT, String(raw));
  });

  it("ignores the old column widths", () => {
    assert.deepEqual(readPanelLayout('{"settings":380,"run":420}'), DEFAULT_LAYOUT);
  });

  it("reads what was saved, field by field", () => {
    const saved = {
      width: 520,
      hidden: true,
      open: { node: false, chat: true, pipeline: true, tests: false, add: false },
      weights: { node: 1, chat: 2, pipeline: 0.5, tests: 1, add: 0.8 },
    };
    assert.deepEqual(readPanelLayout(JSON.stringify(saved)), saved);
  });

  it("falls back per field for what's missing or unreadable", () => {
    const layout = readPanelLayout(
      '{"width":"wide","hidden":1,"open":{"tests":true,"chat":"yes","nope":true},"weights":{"chat":-1,"node":3}}'
    );
    assert.equal(layout.width, DEFAULT_LAYOUT.width);
    assert.equal(layout.hidden, false);
    assert.deepEqual(layout.open, { ...DEFAULT_LAYOUT.open, tests: true });
    assert.deepEqual(layout.weights, { ...DEFAULT_LAYOUT.weights, node: 3 });
  });

  it("keeps a layout with every section folded", () => {
    const allFolded = { node: false, chat: false, pipeline: false, tests: false, add: false };
    assert.deepEqual(readPanelLayout(JSON.stringify({ open: allFolded })).open, allFolded);
  });
});

describe("clampWidth", () => {
  it("keeps a width between 340px and 760px — or 60% of a smaller window", () => {
    assert.equal(clampWidth(440, 1440), 440);
    assert.equal(clampWidth(100, 1440), 340);
    assert.equal(clampWidth(2000, 1440), 760);
    assert.equal(clampWidth(760, 1100), 660, "a monitor's width, shown on a laptop");
  });

  it("never goes below 340px, even in a small window", () => {
    assert.equal(clampWidth(440, 500), 340);
  });
});

describe("dragWidth", () => {
  it("resizes, within the limits", () => {
    assert.equal(dragWidth(DEFAULT_LAYOUT, 600, 1440).width, 600);
    assert.equal(dragWidth(DEFAULT_LAYOUT, 5000, 1440).width, 760);
  });

  it("hides the panel when dragged below 240px, keeping the width to come back to", () => {
    const hidden = dragWidth({ ...DEFAULT_LAYOUT, width: 520 }, HIDE_BELOW - 1, 1440);
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.width, 520);
  });

  it("shows it again when dragged back out", () => {
    assert.equal(dragWidth({ ...DEFAULT_LAYOUT, hidden: true }, 400, 1440).hidden, false);
  });
});

describe("toggleSection / openSection", () => {
  it("folds an open section and opens a folded one", () => {
    assert.equal(toggleSection(DEFAULT_LAYOUT, "chat").open.chat, false);
    assert.equal(toggleSection(DEFAULT_LAYOUT, "tests").open.tests, true);
  });

  it("opens a section, leaving an open one as it is", () => {
    assert.equal(openSection(DEFAULT_LAYOUT, "tests").open.tests, true);
    assert.equal(openSection(DEFAULT_LAYOUT, "node"), DEFAULT_LAYOUT);
  });
});

describe("openAbove", () => {
  it("finds the nearest open section above — the one a header drag re-splits with", () => {
    const layout = { ...DEFAULT_LAYOUT, open: { node: true, chat: false, pipeline: true, tests: true, add: false } };
    assert.equal(openAbove(layout, "pipeline"), "node");
    assert.equal(openAbove(layout, "tests"), "pipeline");
    assert.equal(openAbove(layout, "node"), null);
  });
});

describe("resizeSplit", () => {
  const heights = { above: 300, below: 300 };
  const layout = { ...DEFAULT_LAYOUT, weights: { ...DEFAULT_LAYOUT.weights, node: 1, chat: 1 } };

  it("moves the boundary, keeping the pair's combined weight", () => {
    const next = resizeSplit(layout, "node", "chat", heights, 60);
    assert.ok(Math.abs(next.weights.node - 1.2) < 1e-9);
    assert.ok(Math.abs(next.weights.chat - 0.8) < 1e-9);
    assert.equal(next.weights.pipeline, layout.weights.pipeline);
  });

  it("stops at 76px for either section", () => {
    const up = resizeSplit(layout, "node", "chat", heights, -1000);
    assert.ok(Math.abs(up.weights.node - (2 * MIN_SECTION_HEIGHT) / 600) < 1e-9);
    const down = resizeSplit(layout, "node", "chat", heights, 1000);
    assert.ok(Math.abs(down.weights.chat - (2 * MIN_SECTION_HEIGHT) / 600) < 1e-9);
  });

  it("leaves two sections too short to split as they are", () => {
    assert.equal(resizeSplit(layout, "node", "chat", { above: 70, below: 70 }, 20), layout);
  });
});

describe("isStacked / shownHidden", () => {
  it("stacks at 960px and below, like the CSS", () => {
    assert.equal(isStacked(961), false);
    assert.equal(isStacked(960), true);
  });

  it("never hides a stacked panel, but keeps the saved choice for a wide window", () => {
    const layout = { ...DEFAULT_LAYOUT, hidden: true };
    assert.equal(shownHidden(layout, 800), false);
    assert.equal(shownHidden(layout, 1440), true);
    assert.equal(layout.hidden, true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `node --import tsx --test test/panelLayout.test.ts`
Expected: FAIL — cannot find module `../src/ui/panelLayout`.

- [ ] **Step 3: Write `web/src/ui/panelLayout.ts`**

```ts
/** The panel's sections, top to bottom. */
export type SectionId = "node" | "chat" | "pipeline" | "tests" | "add";
export const SECTION_ORDER: readonly SectionId[] = ["node", "chat", "pipeline", "tests", "add"];

/** How the left panel is laid out — what's remembered in the browser. */
export interface PanelLayout {
  /** The width someone chose; the window only limits what's shown (clampWidth). */
  width: number;
  /** Hidden to the rail (a stacked panel is never hidden — see shownHidden). */
  hidden: boolean;
  /** Which sections are open; any number can be. */
  open: Record<SectionId, boolean>;
  /** Each open section's share of the panel's height (relative). */
  weights: Record<SectionId, number>;
}

export const DEFAULT_WIDTH = 440;
export const MIN_WIDTH = 340;
export const MAX_WIDTH = 760;
/** Dragging the edge narrower than this hides the panel. */
export const HIDE_BELOW = 240;
/** The hidden panel's rail. */
export const RAIL_WIDTH = 48;
/** No open section gets shorter — a header and a line or two of content. */
export const MIN_SECTION_HEIGHT = 76;
/** At or below this window width everything stacks — keep in step with the
 * `@media (max-width: 960px)` block in style.css. */
export const STACKED_MAX_WIDTH = 960;

export const PANEL_LAYOUT_STORAGE_KEY = "llm-pipeline.panel-layout.v1";

export const DEFAULT_LAYOUT: PanelLayout = {
  width: DEFAULT_WIDTH,
  hidden: false,
  open: { node: true, chat: true, pipeline: false, tests: false, add: false },
  weights: { node: 1, chat: 1.2, pipeline: 1, tests: 1, add: 0.8 },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The layout as saved; anything missing or unreadable is its default,
 * field by field (and section by section). */
export function readPanelLayout(raw: string | null): PanelLayout {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "{}");
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!isRecord(saved)) return DEFAULT_LAYOUT;
  const open = isRecord(saved.open) ? saved.open : {};
  const weights = isRecord(saved.weights) ? saved.weights : {};
  return {
    width: typeof saved.width === "number" && Number.isFinite(saved.width) ? saved.width : DEFAULT_LAYOUT.width,
    hidden: typeof saved.hidden === "boolean" ? saved.hidden : DEFAULT_LAYOUT.hidden,
    open: Object.fromEntries(
      SECTION_ORDER.map((id) => {
        const value = open[id];
        return [id, typeof value === "boolean" ? value : DEFAULT_LAYOUT.open[id]];
      })
    ) as Record<SectionId, boolean>,
    weights: Object.fromEntries(
      SECTION_ORDER.map((id) => {
        const value = weights[id];
        return [id, typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_LAYOUT.weights[id]];
      })
    ) as Record<SectionId, number>,
  };
}

/** The widest the panel may be in a window this wide: 760px, or 60% of it. */
function maxWidth(windowWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(windowWidth * 0.6)));
}

/** A width as shown in a window this wide. */
export function clampWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth(windowWidth)));
}

/** Dragging the edge to `width`: below 240px hides the panel (keeping the
 * width it comes back at); otherwise that width, within the limits. */
export function dragWidth(layout: PanelLayout, width: number, windowWidth: number): PanelLayout {
  if (width < HIDE_BELOW) return layout.hidden ? layout : { ...layout, hidden: true };
  return { ...layout, hidden: false, width: clampWidth(width, windowWidth) };
}

export function toggleSection(layout: PanelLayout, id: SectionId): PanelLayout {
  return { ...layout, open: { ...layout.open, [id]: !layout.open[id] } };
}

export function openSection(layout: PanelLayout, id: SectionId): PanelLayout {
  return layout.open[id] ? layout : { ...layout, open: { ...layout.open, [id]: true } };
}

/** The nearest open section above `id` — the one dragging `id`'s header
 * re-splits the height with — or null. */
export function openAbove(layout: PanelLayout, id: SectionId): SectionId | null {
  for (let i = SECTION_ORDER.indexOf(id) - 1; i >= 0; i--) {
    const candidate = SECTION_ORDER[i]!;
    if (layout.open[candidate]) return candidate;
  }
  return null;
}

/** Moves the boundary between two adjacent open sections `dy` px down,
 * from the `heights` they had when the drag started. Both keep at least
 * 76px, and their combined weight stays the same, so the other open
 * sections keep their share. Two sections too short for that stay as
 * they are. */
export function resizeSplit(
  layout: PanelLayout,
  above: SectionId,
  below: SectionId,
  heights: { above: number; below: number },
  dy: number
): PanelLayout {
  const total = heights.above + heights.below;
  if (total < 2 * MIN_SECTION_HEIGHT) return layout;
  const a = Math.min(Math.max(heights.above + dy, MIN_SECTION_HEIGHT), total - MIN_SECTION_HEIGHT);
  const combined = layout.weights[above] + layout.weights[below];
  return {
    ...layout,
    weights: { ...layout.weights, [above]: (combined * a) / total, [below]: (combined * (total - a)) / total },
  };
}

export function isStacked(windowWidth: number): boolean {
  return windowWidth <= STACKED_MAX_WIDTH;
}

/** Whether the panel shows as the rail: never while stacked — the saved
 * choice waits for a wide window. */
export function shownHidden(layout: PanelLayout, windowWidth: number): boolean {
  return layout.hidden && !isStacked(windowWidth);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/panelLayout.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add web/src/ui/panelLayout.ts web/test/panelLayout.test.ts
git commit -m "$(printf 'feat(web): layout rules for the single left panel\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 2: Section header lines and the Chat preview

**Files:**
- Create: `web/src/editor/selection.ts` (moved from `SettingsColumn.tsx`)
- Create: `web/src/ui/sectionSummaries.ts`
- Create: `web/src/run/lastExchange.ts`
- Modify: `web/src/editor/SettingsColumn.tsx`, `web/src/App.tsx` (imports only)
- Rename + edit: `web/test/settingsSubject.test.ts` → `web/test/selection.test.ts`
- Test: `web/test/sectionSummaries.test.ts`, `web/test/lastExchange.test.ts`

> `lastExchange.ts`, not `chatPreview.ts`: Task 4 adds `run/ChatPreview.tsx`, and macOS file systems ignore case.
> The spec listed a separate `tests/testsSummary.ts`; all five section header lines live together in `ui/sectionSummaries.ts` instead, since they change together.

**Interfaces:**
- Produces (in `web/src/editor/selection.ts`): `type SettingsSubject = "pipeline" | "node" | "dependency"`, `settingsSubject(definition, selection)`, `opensSettings(selection)` — unchanged behaviour, new home.
- Produces (in `web/src/ui/sectionSummaries.ts`):
  - `selectionHeading(definition: PipelineDefinition, selection: Selection | null): { title: string; detail?: string }`
  - `selectionSummary(definition, selection): string`
  - `chatSummary(turns: readonly Turn[], running: boolean): string`
  - `pipelineSectionSummary(definition): string`
  - `testsSummary(caseCount: number, run: TestRunState | null): string`
  - `paletteSummary(presetCount: number): string`
  - `type StateTone = "ok" | "warn" | "error"`; `pipelineState(doc: { dirty: boolean } | null, validation: ValidationState): { tone: StateTone; label: string }`
- Produces (in `web/src/run/lastExchange.ts`): `interface LastExchange { prompt: string; answer: string; state: "running" | "done" | "stopped" | "failed" }`, `lastExchange(turns: readonly Turn[], pendingAnswer: string | undefined): LastExchange | null`

- [ ] **Step 1: Move the selection tests, and write the new failing tests**

Run (from `web/`): `git mv test/settingsSubject.test.ts test/selection.test.ts`, then in it replace `import { opensSettings, settingsSubject } from "../src/editor/SettingsColumn";` with `import { opensSettings, settingsSubject } from "../src/editor/selection";`.

Create `web/test/sectionSummaries.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PipelineDefinition } from "@llm-pipeline/client";

import {
  chatSummary,
  paletteSummary,
  pipelineSectionSummary,
  pipelineState,
  selectionHeading,
  selectionSummary,
  testsSummary,
} from "../src/ui/sectionSummaries";
import type { Turn } from "../src/run/Chat";
import type { TestRunState } from "../src/tests/TestsView";

const definition = {
  name: "p",
  nodes: [
    { id: "a", model: { provider: "ollama", name: "llama3", temperature: 0.3 } },
    { id: "b" },
  ],
  defaults: { model: { provider: "ollama", name: "qwen", temperature: 0.7 } },
  output_nodes: ["b"],
} as unknown as PipelineDefinition;

const turn = (status: Turn["status"], elapsedMs?: number) =>
  ({ id: 1, pipeline: "p", prompt: "hi", history: [], status, nodeOutputs: [], log: [], elapsedMs }) as unknown as Turn;

describe("selectionHeading", () => {
  it("names the selected node or dependency", () => {
    assert.deepEqual(selectionHeading(definition, { kind: "node", id: "a" }), { title: "Node", detail: "a" });
    assert.deepEqual(selectionHeading(definition, { kind: "edge", from: "a", to: "b" }), { title: "Dependency", detail: "a → b" });
  });

  it("is just Node with nothing selected, or a node that's gone", () => {
    assert.deepEqual(selectionHeading(definition, null), { title: "Node" });
    assert.deepEqual(selectionHeading(definition, { kind: "node", id: "gone" }), { title: "Node" });
  });
});

describe("selectionSummary", () => {
  it("gives a node's model and temperature — its own, or the pipeline default's", () => {
    assert.equal(selectionSummary(definition, { kind: "node", id: "a" }), "ollama:llama3 · T 0.3");
    assert.equal(selectionSummary(definition, { kind: "node", id: "b" }), "pipeline default · T 0.7");
  });

  it("says what a dependency means, or that nothing is selected", () => {
    assert.equal(selectionSummary(definition, { kind: "edge", from: "a", to: "b" }), "b waits for a");
    assert.equal(selectionSummary(definition, null), "nothing selected");
  });
});

describe("chatSummary", () => {
  it("counts the runs, with how long the last one took", () => {
    assert.equal(chatSummary([], false), "no messages yet");
    assert.equal(chatSummary([turn("done", 752)], false), "1 run · last 752ms");
    assert.equal(chatSummary([turn("done", 1000), turn("done", 2400), turn("error")], false), "3 runs");
  });

  it("says so while a run is going", () => {
    assert.equal(chatSummary([turn("running")], true), "running…");
  });
});

describe("pipelineSectionSummary", () => {
  it("names the answering node and the history setting", () => {
    assert.equal(pipelineSectionSummary(definition), "answer from b · history 6 turns");
    assert.equal(
      pipelineSectionSummary({ ...definition, history: { max_turns: 0 } } as PipelineDefinition),
      "answer from b · history off"
    );
    assert.equal(
      pipelineSectionSummary({ ...definition, history: { max_turns: 1 } } as PipelineDefinition),
      "answer from b · history 1 turn"
    );
  });
});

describe("testsSummary", () => {
  const result = (testCase: string, passed: boolean | null) => ({
    case: testCase, variant: "current", passed, expectations: [], duration_ms: 1, prompt_tokens: 0, completion_tokens: 0,
  });
  const run = (status: TestRunState["status"], results: ReturnType<typeof result>[]): TestRunState => ({
    status,
    cases: ["a", "b", "c", "d"],
    variants: ["current"],
    results: Object.fromEntries(results.map((r) => [`${r.case}\u0000current`, r])),
  });

  it("counts the cases before any run", () => {
    assert.equal(testsSummary(0, null), "no test cases");
    assert.equal(testsSummary(4, null), "4 cases");
  });

  it("shows progress during a run", () => {
    assert.equal(testsSummary(4, run("running", [result("a", true), result("b", false)])), "running 2/4");
  });

  it("gives the pass count after a run, ignoring cases with nothing to check", () => {
    assert.equal(testsSummary(4, run("done", [result("a", true), result("b", false), result("c", true), result("d", null)])), "4 cases · 2/3 passed");
  });

  it("says when the run was stopped or failed", () => {
    assert.equal(testsSummary(4, run("stopped", [result("a", true)])), "4 cases · stopped");
    assert.equal(testsSummary(4, { ...run("error", []), error: "boom" }), "4 cases · test run failed");
  });
});

describe("paletteSummary", () => {
  it("counts the presets beside the blank node", () => {
    assert.equal(paletteSummary(0), "LLM node · no presets");
    assert.equal(paletteSummary(1), "LLM node · 1 preset");
    assert.equal(paletteSummary(2), "LLM node · 2 presets");
  });
});

describe("pipelineState", () => {
  it("is ok when saved", () => {
    assert.deepEqual(pipelineState({ dirty: false }, { status: "idle" }), { tone: "ok", label: "saved" });
  });

  it("is a warning while there are unsaved changes", () => {
    assert.deepEqual(pipelineState({ dirty: true }, { status: "valid", modelIssues: [], warnings: [] }), { tone: "warn", label: "valid · unsaved" });
    assert.deepEqual(
      pipelineState({ dirty: true }, { status: "valid", modelIssues: [{ nodeId: "a", message: "x" }], warnings: [{ nodeId: null, message: "y" }] }),
      { tone: "warn", label: "valid · 2 warnings" }
    );
    assert.deepEqual(pipelineState({ dirty: true }, { status: "checking" }), { tone: "warn", label: "checking…" });
    assert.deepEqual(pipelineState({ dirty: true }, { status: "unavailable", message: "down" }), { tone: "warn", label: "can't validate" });
    assert.deepEqual(pipelineState({ dirty: true }, { status: "idle" }), { tone: "warn", label: "unsaved" });
  });

  it("is an error when invalid", () => {
    assert.deepEqual(pipelineState({ dirty: true }, { status: "invalid", message: "m", nodeId: "a" }), { tone: "error", label: "invalid · a" });
    assert.deepEqual(pipelineState({ dirty: true }, { status: "invalid", message: "m", nodeId: null }), { tone: "error", label: "invalid" });
  });

  it("says so before a pipeline has loaded", () => {
    assert.deepEqual(pipelineState(null, { status: "idle" }), { tone: "warn", label: "no pipeline loaded" });
  });
});
```

Create `web/test/lastExchange.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { lastExchange } from "../src/run/lastExchange";
import type { Turn } from "../src/run/Chat";

const turn = (fields: Partial<Turn>) =>
  ({ id: 1, pipeline: "p", prompt: "Why short functions?", history: [], status: "done", nodeOutputs: [], log: [], ...fields }) as Turn;

describe("lastExchange", () => {
  it("is nothing before the first message", () => {
    assert.equal(lastExchange([], undefined), null);
  });

  it("gives the latest message and its answer", () => {
    const done = turn({ status: "done", result: { final_answer: "They do one thing." } as Turn["result"] });
    assert.deepEqual(lastExchange([turn({ prompt: "older" }), done], undefined), {
      prompt: "Why short functions?",
      answer: "They do one thing.",
      state: "done",
    });
  });

  it("shows the answer as it streams", () => {
    assert.deepEqual(lastExchange([turn({ status: "running" })], "They do"), { prompt: "Why short functions?", answer: "They do", state: "running" });
    assert.deepEqual(lastExchange([turn({ status: "running" })], undefined), { prompt: "Why short functions?", answer: "", state: "running" });
  });

  it("says when the run was stopped or failed", () => {
    assert.deepEqual(lastExchange([turn({ status: "stopped" })], undefined), {
      prompt: "Why short functions?",
      answer: "stopped — nothing from this run was added",
      state: "stopped",
    });
    assert.deepEqual(lastExchange([turn({ status: "error", error: { message: "Ollama is down" } })], undefined), {
      prompt: "Why short functions?",
      answer: "failed — Ollama is down",
      state: "failed",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/selection.test.ts test/sectionSummaries.test.ts test/lastExchange.test.ts`
Expected: FAIL — cannot find modules `../src/editor/selection`, `../src/ui/sectionSummaries`, `../src/run/lastExchange`.

- [ ] **Step 3: Move the selection rules into `web/src/editor/selection.ts`**

Create `web/src/editor/selection.ts`:

```ts
import type { PipelineDefinition } from "@llm-pipeline/client";
import type { Selection } from "./editorState";

/** What the Node section shows: a node, a dependency, or — nothing
 * selected — the hint ("pipeline" for historical reasons). */
export type SettingsSubject = "pipeline" | "node" | "dependency";

/** A selected node that no longer exists (deleted, renamed, undone) counts
 * as nothing selected — as the Inspector does. */
export function settingsSubject(definition: PipelineDefinition, selection: Selection | null): SettingsSubject {
  if (selection?.kind === "node") return definition.nodes.some((n) => n.id === selection.id) ? "node" : "pipeline";
  return selection?.kind === "edge" ? "dependency" : "pipeline";
}

/** Selecting a node or dependency opens its settings — each time it's
 * selected. Clearing the selection leaves them as they are. */
export function opensSettings(selection: Selection | null): boolean {
  return selection?.kind === "node" || selection?.kind === "edge";
}
```

In `web/src/editor/SettingsColumn.tsx`, delete the `SettingsSubject` type, `settingsSubject` and `opensSettings` (with their doc comments) and replace its imports with:

```tsx
import type { ReactNode } from "react";
import type { SettingsPlacement } from "../ui/panelSizes";
import type { SettingsSubject } from "./selection";
```

In `web/src/App.tsx`, replace `import { SettingsColumn, opensSettings, settingsSubject } from "./editor/SettingsColumn";` with:

```tsx
import { SettingsColumn } from "./editor/SettingsColumn";
import { opensSettings, settingsSubject } from "./editor/selection";
```

- [ ] **Step 4: Write `web/src/ui/sectionSummaries.ts`**

```ts
import { effectiveModel, modelIdentity } from "@llm-pipeline/client";
import type { PipelineDefinition } from "@llm-pipeline/client";
import type { Selection, ValidationState } from "../editor/editorState";
import { settingsSubject } from "../editor/selection";
import { outputSummary } from "../editor/pipelineSummaries";
import { formatDuration } from "../format";
import type { Turn } from "../run/Chat";
import { resultKey } from "../tests/TestsView";
import type { TestRunState } from "../tests/TestsView";

// The one-line headers of the left panel's sections (ui/LeftPanel.tsx):
// what each holds, readable while it's folded.

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Node section's title — "Node", or "Dependency" — and what's selected. */
export function selectionHeading(
  definition: PipelineDefinition,
  selection: Selection | null
): { title: string; detail?: string } {
  const subject = settingsSubject(definition, selection);
  if (subject === "node" && selection?.kind === "node") return { title: "Node", detail: selection.id };
  if (subject === "dependency" && selection?.kind === "edge") {
    return { title: "Dependency", detail: `${selection.from} → ${selection.to}` };
  }
  return { title: "Node" };
}

/** A node's model and temperature (as its Model section says), what a
 * dependency means, or that nothing is selected. */
export function selectionSummary(definition: PipelineDefinition, selection: Selection | null): string {
  const subject = settingsSubject(definition, selection);
  if (subject === "node" && selection?.kind === "node") {
    const node = definition.nodes.find((n) => n.id === selection.id)!;
    const temperature = effectiveModel(definition, node)?.temperature ?? 0.2;
    return `${node.model ? modelIdentity(node.model) : "pipeline default"} · T ${temperature}`;
  }
  if (subject === "dependency" && selection?.kind === "edge") return `${selection.to} waits for ${selection.from}`;
  return "nothing selected";
}

/** How many runs the conversation has, and how long the last one took. */
export function chatSummary(turns: readonly Turn[], running: boolean): string {
  if (running) return "running…";
  if (turns.length === 0) return "no messages yet";
  const runs = count(turns.length, "run");
  const last = turns.at(-1)!;
  return last.elapsedMs !== undefined ? `${runs} · last ${formatDuration(last.elapsedMs)}` : runs;
}

/** Which node answers, and how much history the nodes see (6 turns unless set). */
export function pipelineSectionSummary(definition: PipelineDefinition): string {
  const turns = definition.history?.max_turns ?? 6;
  return `${outputSummary(definition.output_nodes)} · history ${turns === 0 ? "off" : count(turns, "turn")}`;
}

/** The test cases, and how the draft did in the latest test run. */
export function testsSummary(caseCount: number, run: TestRunState | null): string {
  if (caseCount === 0) return "no test cases";
  const cases = count(caseCount, "case");
  if (!run) return cases;
  const results = run.cases.map((c) => run.results[resultKey(c, "current")]).filter((r) => r !== undefined);
  if (run.status === "running") return `running ${results.length}/${run.cases.length}`;
  if (run.status === "error") return `${cases} · test run failed`;
  if (run.status === "stopped") return `${cases} · stopped`;
  const judged = results.filter((r) => r.passed !== null);
  if (judged.length === 0) return cases;
  return `${cases} · ${judged.filter((r) => r.passed).length}/${judged.length} passed`;
}

/** What the Add node section offers. */
export function paletteSummary(presetCount: number): string {
  return `LLM node · ${presetCount === 0 ? "no presets" : count(presetCount, "preset")}`;
}

export type StateTone = "ok" | "warn" | "error";

/** The pipeline's state as a tone and a line — the status chip's words;
 * the rail's dot, and the header's dot when the panel is too narrow for
 * the chip. */
export function pipelineState(
  doc: { dirty: boolean } | null,
  validation: ValidationState
): { tone: StateTone; label: string } {
  if (!doc) return { tone: "warn", label: "no pipeline loaded" };
  if (!doc.dirty) return { tone: "ok", label: "saved" };
  switch (validation.status) {
    case "checking":
      return { tone: "warn", label: "checking…" };
    case "valid": {
      const issues = validation.modelIssues.length + validation.warnings.length;
      return { tone: "warn", label: issues > 0 ? `valid · ${count(issues, "warning")}` : "valid · unsaved" };
    }
    case "invalid":
      return { tone: "error", label: validation.nodeId ? `invalid · ${validation.nodeId}` : "invalid" };
    case "unavailable":
      return { tone: "warn", label: "can't validate" };
    default:
      return { tone: "warn", label: "unsaved" };
  }
}
```

- [ ] **Step 5: Write `web/src/run/lastExchange.ts`**

```ts
import type { Turn } from "./Chat";

/** The folded Chat section's preview: the latest message and its answer. */
export interface LastExchange {
  prompt: string;
  /** The answer so far — or, for a stopped or failed run, what happened. */
  answer: string;
  state: "running" | "done" | "stopped" | "failed";
}

/** The latest exchange in the conversation, live while it streams
 * (`pendingAnswer` is the output node's text so far); null before any. */
export function lastExchange(turns: readonly Turn[], pendingAnswer: string | undefined): LastExchange | null {
  const last = turns.at(-1);
  if (!last) return null;
  switch (last.status) {
    case "running":
      return { prompt: last.prompt, answer: pendingAnswer ?? "", state: "running" };
    case "done":
      return { prompt: last.prompt, answer: last.result?.final_answer ?? "", state: "done" };
    case "stopped":
      return { prompt: last.prompt, answer: "stopped — nothing from this run was added", state: "stopped" };
    case "error":
      return { prompt: last.prompt, answer: `failed — ${last.error?.message ?? "the run failed"}`, state: "failed" };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test test/selection.test.ts test/sectionSummaries.test.ts test/lastExchange.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add -A web/src/editor/selection.ts web/src/editor/SettingsColumn.tsx web/src/ui/sectionSummaries.ts web/src/run/lastExchange.ts web/src/App.tsx web/test
git commit -m "$(printf 'feat(web): section header lines and the chat preview\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 3: Pipeline settings in their own file

**Files:**
- Create: `web/src/editor/PipelineSettings.tsx`
- Modify: `web/src/editor/Inspector.tsx`

**Interfaces:**
- Produces: `PipelineSettings(props: InspectorProps)` in `web/src/editor/PipelineSettings.tsx` (today's `PipelineInspector`, renamed).
- Produces: `export type Edit` from `web/src/editor/Inspector.tsx` (was module-private).
- Consumes: `InspectorProps`, `Edit` (type-only import from `./Inspector`).

This task moves code without changing behaviour; its test is the existing suite plus the typecheck.

- [ ] **Step 1: Export `Edit` from `Inspector.tsx`**

Replace `type Edit = (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string, removed?: string) => void;` with `export type Edit = (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string, removed?: string) => void;`.

- [ ] **Step 2: Create `web/src/editor/PipelineSettings.tsx` with the moved code**

Start the file with:

```tsx
import { useId } from "react";
import { modelWithIdentity, modelWithOption, setOutput, setPipelineSetting } from "@llm-pipeline/client";
import type { NodeModelConfig, PipelineDefinition, PipelineSection, PipelineSections } from "@llm-pipeline/client";
import { CommitInput, Field, ModelPicker, NumberField, OllamaOptionsForm, useModelLimits } from "./fields";
import { Section } from "./Section";
import { defaultsSummary, executionSummary, historySummary, outputSummary, routingSummary } from "./pipelineSummaries";
import type { Edit, InspectorProps } from "./Inspector";

// The pipeline's own settings — the Pipeline section of the left panel.
```

Then **cut** these from `Inspector.tsx` and paste them below, in this order:

1. The comment `// The server's built-in history defaults …` and the two constants `DEFAULT_TURN_TEMPLATE` and `DEFAULT_SUMMARY_PROMPT` (just above `Edit`'s doc comment).
2. Everything from `function PipelineInspector(props: InspectorProps) {` to the end of the file (`PipelineInspector`, `usePipelineSetter`, `withTemperature`, `HistorySettings`, `NodeDefaultsSettings`).

In the pasted code, replace `function PipelineInspector(props: InspectorProps) {` with:

```tsx
/** Name and description, then Output, Execution, Conversation history,
 * Defaults for all nodes and Routing as foldable sections. */
export function PipelineSettings(props: InspectorProps) {
```

- [ ] **Step 3: Point `Inspector` at it**

In `Inspector.tsx`, add `import { PipelineSettings } from "./PipelineSettings";` after `import { Section } from "./Section";`, and replace `        <PipelineInspector {...props} />` with `        <PipelineSettings {...props} />`.

- [ ] **Step 4: Drop the imports `Inspector.tsx` no longer uses**

Run (from `web/`):

```bash
for name in setOutput setPipelineSetting modelWithOption modelWithIdentity PipelineSection PipelineSections CommitInput NumberField OllamaOptionsForm ModelPicker useModelLimits defaultsSummary executionSummary historySummary outputSummary routingSummary useId; do n=$(grep -c "\b$name\b" src/editor/Inspector.tsx); [ "$n" -le 1 ] && echo "unused: $name"; done
```

Remove every name it prints from `Inspector.tsx`'s import lists (and the whole `pipelineSummaries` import line if all five are printed). Run it again: expected no output.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

Run: `grep -n "PipelineInspector\|HistorySettings\|NodeDefaultsSettings\|DEFAULT_TURN_TEMPLATE" src/editor/Inspector.tsx`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add web/src/editor/PipelineSettings.tsx web/src/editor/Inspector.tsx
git commit -m "$(printf 'refactor(web): pipeline settings in their own file\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 4: The left panel

**Files:**
- Create: `web/src/ui/usePanelLayout.ts`, `web/src/ui/PanelSection.tsx`, `web/src/ui/LeftPanel.tsx`, `web/src/run/ChatPreview.tsx`
- Rename + rewrite: `web/src/editor/AddNodeMenu.tsx` → `web/src/editor/NodePalette.tsx`
- Modify: `web/src/ui/icons.tsx`, `web/src/ui/ServerStatus.tsx`, `web/src/run/Chat.tsx` (Composer), `web/src/editor/Inspector.tsx`, `web/src/editor/PipelineCanvas.tsx` (one comment), `web/src/editor/canvasHint.ts`, `web/test/canvasHint.test.ts`, `web/src/App.tsx`, `web/src/style.css`

**Interfaces:**
- Consumes: Task 1's `panelLayout.ts`; Task 2's `sectionSummaries.ts`, `lastExchange.ts`, `selection.ts`; Task 3's `PipelineSettings`.
- Produces (in `web/src/ui/usePanelLayout.ts`): `usePanelLayout(): PanelLayoutApi` with `interface PanelLayoutApi { layout: PanelLayout; width: number; stacked: boolean; hidden: boolean; style: CSSProperties; toggleSection(id: SectionId): void; openSection(id: SectionId): void; resizeSplit(above: SectionId, below: SectionId, heights: { above: number; below: number }, dy: number): void; dragWidth(px: number): void; resetWidth(): void; setHidden(hidden: boolean): void }`. `style` sets `--panel-w`.
- Produces (in `web/src/ui/LeftPanel.tsx`): `interface PanelSectionSpec { id: SectionId; title: string; detail?: string | undefined; summary: string; icon: ReactNode; busy?: boolean; fill?: boolean; preview?: ReactNode; content: ReactNode }` and `LeftPanel(props: { panel: PanelLayoutApi; header: ReactNode; notices: ReactNode; sections: PanelSectionSpec[]; placeholder: ReactNode; dock: ReactNode })`.
- Produces: `NodePalette(props: { editable: boolean; presets: NodePreset[]; onAdd(presetName: string | undefined): void; onDeletePreset(name: string): void })`; icons `NodeIcon`, `ChatIcon`, `PipelineIcon`, `TestsIcon`, `AddNodeIcon`; `Composer`'s new optional prop `pipeline?: string | undefined`; `ServerStatus`'s new optional prop `compact?: boolean`.

- [ ] **Step 1: Point the canvas hint at the new place (failing test first)**

In `web/test/canvasHint.test.ts`, replace `/\+ Add node/` with `/Add node section/`.
Run: `node --import tsx --test test/canvasHint.test.ts` — expected FAIL (the hint still says "+ Add node").
In `web/src/editor/canvasHint.ts`, replace `"Add more nodes with + Add node — drag one onto the canvas, or click it."` with `"Add more nodes from the panel's Add node section — drag one onto the canvas, or click it."`.
Run it again — expected PASS.

- [ ] **Step 2: Section icons in `web/src/ui/icons.tsx`**

Add at the top: `import type { ReactNode } from "react";` and at the end:

```tsx
/** The left panel's section icons (and its rail's): 15px, stroked in the
 * current text color. */
function StrokeIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function NodeIcon() {
  return (
    <StrokeIcon>
      <rect x="3" y="4" width="10" height="8" rx="1.5" />
      <circle cx="8" cy="2.5" r="1" />
      <circle cx="8" cy="13.5" r="1" />
    </StrokeIcon>
  );
}

export function ChatIcon() {
  return (
    <StrokeIcon>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </StrokeIcon>
  );
}

export function PipelineIcon() {
  return (
    <StrokeIcon>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5v6M5.4 4.3l5.2 3" />
    </StrokeIcon>
  );
}

export function TestsIcon() {
  return (
    <StrokeIcon>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8.2l2 2 4-4.4" />
    </StrokeIcon>
  );
}

export function AddNodeIcon() {
  return (
    <StrokeIcon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.5v5M5.5 8h5" />
    </StrokeIcon>
  );
}
```

- [ ] **Step 3: `web/src/ui/usePanelLayout.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  DEFAULT_LAYOUT,
  DEFAULT_WIDTH,
  PANEL_LAYOUT_STORAGE_KEY,
  RAIL_WIDTH,
  clampWidth,
  dragWidth,
  isStacked,
  openSection,
  readPanelLayout,
  resizeSplit,
  shownHidden,
  toggleSection,
} from "./panelLayout";
import type { PanelLayout, SectionId } from "./panelLayout";

export interface PanelLayoutApi {
  layout: PanelLayout;
  /** The width as shown: the chosen one, fitted to the window. */
  width: number;
  /** A window 960px wide or less: everything stacks; no hiding or resizing. */
  stacked: boolean;
  /** Shown as the rail. */
  hidden: boolean;
  /** Sets --panel-w, the panel's grid column. */
  style: CSSProperties;
  toggleSection(id: SectionId): void;
  openSection(id: SectionId): void;
  resizeSplit(above: SectionId, below: SectionId, heights: { above: number; below: number }, dy: number): void;
  /** Dragging the edge (below 240px hides the panel). */
  dragWidth(px: number): void;
  resetWidth(): void;
  setHidden(hidden: boolean): void;
}

function load(): PanelLayout {
  try {
    return readPanelLayout(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_LAYOUT; // storage unavailable (private mode, blocked) — defaults are fine
  }
}

/** The left panel's layout (see panelLayout.ts), remembered in this
 * browser; ⌘\ / Ctrl+\ hides or shows the panel from anywhere. */
export function usePanelLayout(): PanelLayoutApi {
  const [layout, setLayout] = useState<PanelLayout>(load);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const update = useCallback((change: (current: PanelLayout) => PanelLayout) => {
    setLayout((current) => {
      const next = change(current);
      if (next === current) return current;
      try {
        window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // not remembered — still applied for this page
      }
      return next;
    });
  }, []);

  const stacked = isStacked(windowWidth);
  const hidden = shownHidden(layout, windowWidth);
  const width = clampWidth(layout.width, windowWidth);

  useEffect(() => {
    if (stacked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        update((l) => ({ ...l, hidden: !l.hidden }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stacked, update]);

  return {
    layout,
    width,
    stacked,
    hidden,
    style: { "--panel-w": `${hidden ? RAIL_WIDTH : width}px` } as CSSProperties,
    toggleSection: useCallback((id) => update((l) => toggleSection(l, id)), [update]),
    openSection: useCallback((id) => update((l) => openSection(l, id)), [update]),
    resizeSplit: useCallback(
      (above, below, heights, dy) => update((l) => resizeSplit(l, above, below, heights, dy)),
      [update]
    ),
    dragWidth: useCallback((px) => update((l) => dragWidth(l, px, window.innerWidth)), [update]),
    resetWidth: useCallback(() => update((l) => ({ ...l, width: DEFAULT_WIDTH, hidden: false })), [update]),
    setHidden: useCallback((next) => update((l) => (l.hidden === next ? l : { ...l, hidden: next })), [update]),
  };
}
```

- [ ] **Step 4: `web/src/ui/PanelSection.tsx`**

```tsx
import { useId } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, Ref } from "react";

/**
 * One section of the left panel: a header row — fold/open, title,
 * one-line summary — and its body. Open, it takes its share of the
 * panel's height (`weight`); `resizable` sections (an open one above)
 * re-split the height by dragging the header, or ↑/↓ on it.
 */
export function PanelSection(props: {
  title: string;
  /** What's selected — shown beside the title, as typed. */
  detail?: string | undefined;
  summary: string;
  icon: ReactNode;
  open: boolean;
  weight: number;
  resizable: boolean;
  /** Something's running in it (a pulsing dot). */
  busy: boolean;
  /** The content fills the body and scrolls itself (Chat, node settings). */
  fill: boolean;
  /** Shown under the header while folded (Chat's last exchange). */
  preview?: ReactNode;
  onToggle: () => void;
  onSplitStart: (e: PointerEvent<HTMLElement>) => void;
  onSplitKey: (dy: number) => void;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  const bodyId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // the fold button's own keys
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowUp") props.onSplitKey(-step);
    else if (e.key === "ArrowDown") props.onSplitKey(step);
    else return;
    e.preventDefault();
  };
  return (
    <section
      ref={props.ref}
      className={props.open ? "psec open" : "psec"}
      style={props.open ? { flexGrow: props.weight } : undefined}
      aria-label={props.title}
    >
      <div
        className={props.resizable ? "psec-head resizable" : "psec-head"}
        tabIndex={props.resizable ? 0 : undefined}
        title={props.resizable ? "Drag to change how the height is split (↑ ↓ when focused)" : undefined}
        onPointerDown={props.resizable ? props.onSplitStart : undefined}
        onKeyDown={props.resizable ? onKeyDown : undefined}
      >
        <button
          type="button"
          className="psec-toggle"
          aria-expanded={props.open}
          aria-controls={props.open ? bodyId : undefined}
          onClick={props.onToggle}
        >
          <span className="psec-chev" aria-hidden="true">
            {props.open ? "▾" : "▸"}
          </span>
          <span className="psec-icon">{props.icon}</span>
          <span className="psec-title">{props.title}</span>
          {props.detail && <span className="psec-detail">{props.detail}</span>}
        </button>
        {props.busy && <span className="pulse-dot" aria-hidden="true" />}
        <span className="psec-summary" title={props.summary}>
          {props.summary}
        </span>
        {props.resizable && <span className="psec-grip" aria-hidden="true" />}
      </div>
      {!props.open && props.preview}
      {props.open && (
        <div id={bodyId} className={props.fill ? "psec-body fill" : "psec-body"}>
          {props.children}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: `web/src/ui/LeftPanel.tsx`**

```tsx
import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { PanelSection } from "./PanelSection";
import { openAbove } from "./panelLayout";
import type { SectionId } from "./panelLayout";
import type { PanelLayoutApi } from "./usePanelLayout";

/** One section as App describes it: its header line and its content. */
export interface PanelSectionSpec {
  id: SectionId;
  title: string;
  detail?: string | undefined;
  summary: string;
  icon: ReactNode;
  busy?: boolean;
  fill?: boolean;
  preview?: ReactNode;
  content: ReactNode;
}

/**
 * The one panel, on the left: the header (what the top bar held), the
 * notices, the sections — any number open, sharing the height, each
 * scrolling on its own — and the message box docked at the bottom.
 */
export function LeftPanel(props: {
  panel: PanelLayoutApi;
  header: ReactNode;
  notices: ReactNode;
  sections: PanelSectionSpec[];
  /** Shown instead of the sections before a pipeline has loaded. */
  placeholder: ReactNode;
  dock: ReactNode;
}) {
  const { panel } = props;
  const { layout } = panel;
  const elements = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});

  /** An open section and the open one above it, with their heights now. */
  const pair = (id: SectionId) => {
    const above = openAbove(layout, id);
    const aboveEl = above ? elements.current[above] : null;
    const el = elements.current[id];
    if (!above || !aboveEl || !el) return null;
    return { above, heights: { above: aboveEl.getBoundingClientRect().height, below: el.getBoundingClientRect().height } };
  };

  const startSplit = (id: SectionId, e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const start = pair(id);
    if (!start) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const move = (ev: globalThis.PointerEvent) => panel.resizeSplit(start.above, id, start.heights, ev.clientY - startY);
    const end = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", end);
      head.removeEventListener("pointercancel", end);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  };

  const keySplit = (id: SectionId, dy: number) => {
    const now = pair(id);
    if (now) panel.resizeSplit(now.above, id, now.heights, dy);
  };

  return (
    <aside className="left-panel" aria-label="Pipeline panel">
      <header className="panel-head">{props.header}</header>
      <div className="panel-notices">{props.notices}</div>
      <div className="psections">
        {props.sections.length === 0
          ? props.placeholder
          : props.sections.map((s) => (
              <PanelSection
                key={s.id}
                ref={(el) => {
                  elements.current[s.id] = el;
                }}
                title={s.title}
                detail={s.detail}
                summary={s.summary}
                icon={s.icon}
                busy={s.busy ?? false}
                fill={s.fill ?? false}
                preview={s.preview}
                open={layout.open[s.id]}
                weight={layout.weights[s.id]}
                resizable={layout.open[s.id] && openAbove(layout, s.id) !== null}
                onToggle={() => panel.toggleSection(s.id)}
                onSplitStart={(e) => startSplit(s.id, e)}
                onSplitKey={(dy) => keySplit(s.id, dy)}
              >
                {s.content}
              </PanelSection>
            ))}
      </div>
      <div className="dock">{props.dock}</div>
    </aside>
  );
}
```

- [ ] **Step 6: `web/src/run/ChatPreview.tsx`**

```tsx
import type { LastExchange } from "./lastExchange";

/** Folded Chat's preview: the latest message and the start of its answer,
 * live while it streams. Clicking it opens Chat. */
export function ChatPreview({ exchange, onOpen }: { exchange: LastExchange | null; onOpen: () => void }) {
  if (!exchange) return null;
  const answer = exchange.answer || (exchange.state === "running" ? "waiting for the answer…" : "");
  return (
    <button type="button" className="chat-preview" title="Open Chat" onClick={onOpen}>
      <span className="chat-preview-q">
        <span className="marker" aria-hidden="true">
          ›
        </span>{" "}
        {exchange.prompt}
      </span>
      {answer && <span className={`chat-preview-a ${exchange.state}`}>{answer}</span>}
    </button>
  );
}
```

- [ ] **Step 7: The palette without its popover — `NodePalette.tsx`**

Run (from `web/`): `git mv src/editor/AddNodeMenu.tsx src/editor/NodePalette.tsx`

In `web/src/editor/NodePalette.tsx`:
- Replace the first import line `import { useEffect, useId, useRef, useState } from "react";` with `import { useState } from "react";`.
- Replace `function Palette(props: {` with:

```tsx
export function NodePalette(props: {
```

- In its props, delete the lines:

```tsx
  /** An item was dropped on the canvas — not a drag that was cancelled. */
  onDropped: () => void;
```

- Replace `  const { editable, presets, onAdd, onDropped, onDeletePreset } = props;` with `  const { editable, presets, onAdd, onDeletePreset } = props;`.
- Delete the item's drag-end handler:

```tsx
      onDragEnd={(e) => {
        // "none" when the drag was cancelled (Esc, or dropped off the canvas).
        if (e.dataTransfer.dropEffect !== "none") onDropped();
      }}
```

- Delete everything from the doc comment `/**\n * "+ Add node" in the canvas corner:` to the end of the file (the `AddNodeMenu` component).
- Replace the palette's doc comment (above `export function NodePalette`) with:

```tsx
/** The Add node section: a blank LLM node, or a node from a preset. Drag
 * onto the canvas, or click to add (below the selected node, connected to
 * it). */
```

In `web/src/editor/PipelineCanvas.tsx`, replace `/** Drag-and-drop payload type set by the + Add node palette\n * (AddNodeMenu.tsx). The value is a preset name, or "" for a plain node. */` with:

```ts
/** Drag-and-drop payload type set by the node palette (NodePalette.tsx,
 * the Add node section). The value is a preset name, or "" for a plain node. */
```

- [ ] **Step 8: The Composer as the dock's message box (`web/src/run/Chat.tsx`)**

Replace `import { useEffect, useImperativeHandle, useRef, useState } from "react";` with `import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";`.

Replace the Composer's doc comment `/** The message box, at the bottom of the panel on every tab but Tests\n * (whose Run buttons run test cases). Its button says Send, so "Run"\n * means one thing on screen. */` with:

```tsx
/** The message box, docked at the bottom of the left panel. Its button
 * says Send, so "Run" (Tests) means one thing on screen. It starts one
 * line tall and grows with what's typed. */
```

In its props, after `  disabledReason: string | null;` add:

```tsx
  /** The open pipeline's name, for the placeholder. */
  pipeline?: string | undefined;
```

After `  const box = useRef<HTMLTextAreaElement>(null);` add:

```tsx
  // Grows with its text (CSS caps it at about six lines, then it scrolls).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [prompt]);
```

Replace:

```tsx
          rows={2}
          aria-label="Message"
          placeholder={props.disabledReason ?? "Type a message…  (Enter to send, Shift+Enter for a new line)"}
```

with:

```tsx
          rows={1}
          aria-label="Message"
          placeholder={props.disabledReason ?? `Message ${props.pipeline ?? "the pipeline"}…`}
          title="Enter sends · Shift+Enter new line · Esc stops a run"
```

- [ ] **Step 9: Compact server lights (`web/src/ui/ServerStatus.tsx`)**

Replace the `Indicator` function with:

```tsx
/** One health light. Beside its name, "offline" is spelled out, so the
 * state doesn't rest on the dot's color alone; compact (in the panel
 * header), it's just the dot — the name and state are its tooltip and
 * read by screen readers. */
function Indicator({ label, health, detail, compact }: { label: string; health: Health; detail: string; compact: boolean }) {
  const state = health === "ok" ? "online" : health === "down" ? "offline" : "checking";
  return (
    <span className={`indicator ${health}`} title={compact ? `${label} · ${detail}` : detail}>
      <span className={`status-dot ${health === "ok" ? "online" : health === "down" ? "offline" : ""}`} aria-hidden="true" />
      {compact ? (
        <span className="visually-hidden">{`${label} ${state}`}</span>
      ) : (
        <>
          {label}
          {health === "down" ? " offline" : <span className="visually-hidden">{` ${state}`}</span>}
        </>
      )}
    </span>
  );
}
```

In `ServerStatus`'s props, after `  readOnly: boolean;` add `  /** Dots only (the panel header). */\n  compact?: boolean;`. Replace `  const { baseUrl, online, ollama } = props;` with `  const { baseUrl, online, ollama } = props;\n  const compact = props.compact ?? false;`, add `compact={compact}` to both `<Indicator` elements, and replace `{props.readOnly && <span className="chip-status">read-only</span>}` with `{props.readOnly && !compact && <span className="chip-status">read-only</span>}`.

- [ ] **Step 10: The Node section's content (`web/src/editor/Inspector.tsx`)**

Replace `        <PipelineSettings {...props} />` with:

```tsx
        <div className="inspector-body">
          <p className="dim">Select a node or dependency on the canvas.</p>
        </div>
```

Delete the `import { PipelineSettings } from "./PipelineSettings";` line. In `NodeInspector`, delete the line `        <h2>{id}</h2>` (the section header shows the name). In `EdgeInspector`, delete:

```tsx
      <header className="inspector-title">
        <h2>
          {from} → {to}
        </h2>
      </header>
```

- [ ] **Step 11: App — imports and state**

In `web/src/App.tsx`, replace these imports:

```tsx
import { AddNodeMenu } from "./editor/AddNodeMenu";
```
```tsx
import { GearIcon } from "./ui/icons";
```
```tsx
import { Splitter, usePanelSizes } from "./ui/Splitter";
```
```tsx
import { RunPanel } from "./ui/RunPanel";
import type { PanelTab } from "./ui/RunPanel";
import { SettingsColumn } from "./editor/SettingsColumn";
import { opensSettings, settingsSubject } from "./editor/selection";
```

with (in the same places, one after another):

```tsx
import { NodePalette } from "./editor/NodePalette";
import { PipelineSettings } from "./editor/PipelineSettings";
import { AddNodeIcon, ChatIcon, NodeIcon, PipelineIcon, TestsIcon } from "./ui/icons";
import { LeftPanel } from "./ui/LeftPanel";
import type { PanelSectionSpec } from "./ui/LeftPanel";
import { usePanelLayout } from "./ui/usePanelLayout";
import {
  chatSummary,
  paletteSummary,
  pipelineSectionSummary,
  pipelineState,
  selectionHeading,
  selectionSummary,
  testsSummary,
} from "./ui/sectionSummaries";
import { opensSettings } from "./editor/selection";
import { lastExchange } from "./run/lastExchange";
import { ChatPreview } from "./run/ChatPreview";
```

Replace:

```tsx
  // Which tab of the run panel is showing (see ui/RunPanel.tsx), and
  // whether the settings column is open (see editor/SettingsColumn.tsx).
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
```

with nothing (delete the four lines). Replace `  const panels = usePanelSizes();` with `  const panel = usePanelLayout();`.

Replace the `select` callback:

```tsx
  // Selecting a node or edge — on the canvas, in a trace, by adding one —
  // opens the settings column on it, each time: one that stayed selected
  // while the column was closed opens it again. Nothing else changes what's
  // showing.
  const select = useCallback((next: Selection | null) => {
    setSelection(next);
    if (opensSettings(next)) setSettingsOpen(true);
  }, []);
```

with:

```tsx
  // Selecting a node or edge — on the canvas, in a trace, by adding one —
  // opens the Node section on it, each time (a hidden panel stays hidden).
  const { openSection } = panel;
  const select = useCallback(
    (next: Selection | null) => {
      setSelection(next);
      if (opensSettings(next)) openSection("node");
    },
    [openSection]
  );
```

Update the copy that pointed at the canvas button:
- `      /* optional feature — + Add node just lists none */` → `      /* optional feature — the Add node section just lists none */`
- `          with + Add node on the canvas.` → `          from the Add node section.`
- `          placeholder: "what it's for — shown under + Add node",` → `          placeholder: "what it's for — shown in the Add node section",`
- `                hint: "add more with + Add node on the canvas",` → `                hint: "add more from the Add node section",`

- [ ] **Step 12: App — derived values**

Delete the block from `  // The column, while there's a pipeline to show settings for.` through the closing `  };` of `togglePipelineSettings` (13 lines).

After the `validationChip` block (the line `  })();` that ends it), add:

```tsx
  const state = pipelineState(doc, validation);

  // What node, dependency and pipeline settings are given.
  const inspectorProps = doc
    ? {
        doc,
        selection,
        editable,
        models,
        presets,
        turns,
        validation: doc.dirty ? validation : ({ status: "idle" } as ValidationState),
        onEdit: edit,
        onSelect: select,
        onRefreshModels: () => void refreshModels(true),
        onSaveAsPreset: (id: string) => void saveNodeAsPreset(id),
        onDuplicate: duplicate,
        rerunnable,
        onRerun: (id: string) => void run("", id),
        previewContext,
      }
    : null;

  // The panel's sections, top to bottom (ui/LeftPanel.tsx).
  const sections: PanelSectionSpec[] =
    doc && inspectorProps
      ? [
          {
            id: "node",
            ...selectionHeading(doc.definition, selection),
            summary: selectionSummary(doc.definition, selection),
            icon: <NodeIcon />,
            fill: true,
            content: <Inspector {...inspectorProps} />,
          },
          {
            id: "chat",
            title: "Chat",
            summary: chatSummary(turns, running),
            icon: <ChatIcon />,
            busy: running,
            fill: true,
            preview: <ChatPreview exchange={lastExchange(turns, pendingAnswer)} onOpen={() => openSection("chat")} />,
            content: (
              <Chat
                turns={turns}
                running={running}
                pendingAnswer={pendingAnswer}
                openTraces={openTraces}
                onOpenTraces={setOpenTraces}
                outputNodeIds={outputIds}
                onSelectNode={(nodeId) => select({ kind: "node", id: nodeId })}
                rerunnable={rerunnable}
                onRerun={(id) => void run("", id)}
                formatted={formatted}
                onFormatted={setFormatted}
                conversations={conversations}
                currentConversation={conversationId.current}
                onOpenConversation={(id) => void openConversation(id)}
                onDeleteConversation={(id) => void removeConversation(id)}
                onNewConversation={resetRunState}
                onRetry={retry}
                retryDisabledReason={runDisabled}
                onEditMessage={(prompt) => composer.current?.fill(prompt)}
              />
            ),
          },
          {
            id: "pipeline",
            title: "Pipeline",
            summary: pipelineSectionSummary(doc.definition),
            icon: <PipelineIcon />,
            content: <PipelineSettings {...inspectorProps} />,
          },
          {
            id: "tests",
            title: "Tests",
            summary: testsSummary(testCases(doc.definition).length, testRun),
            icon: <TestsIcon />,
            busy: testRun?.status === "running",
            content: (
              <TestsView
                definition={doc.definition}
                editable={editable}
                models={models}
                onEdit={edit}
                onRefreshModels={() => void refreshModels(true)}
                run={testRun}
                onRun={(request) => void runTests(request)}
                onStop={() => stopTests.current?.abort()}
                lastMessage={lastTurn?.prompt ?? null}
              />
            ),
          },
          {
            id: "add",
            title: "Add node",
            summary: paletteSummary(presets.length),
            icon: <AddNodeIcon />,
            content: (
              <NodePalette
                editable={editable}
                presets={presets}
                onAdd={(preset) => addNodeAt(undefined, preset)}
                onDeletePreset={(name) => void deletePreset(name)}
              />
            ),
          },
        ]
      : [];
```

- [ ] **Step 13: App — the new render**

Replace everything from the last `  return (` in `App` to the end of the file with:

```tsx
  // The panel header: what the top bar held.
  const header = (
    <>
      <div className="brand-row">
        <h1 className="brand">LLM Pipeline</h1>
        <span className="head-status" title={state.label}>
          <span className={`state-dot ${state.tone}`} aria-hidden="true" />
          {doc?.dirty && (
            <span className="dirty-dot" aria-hidden="true">
              ●
            </span>
          )}
          {validationChip}
        </span>
        <span className="spacer" />
        <ServerStatus
          compact
          baseUrl={BASE_URL}
          online={online}
          ollama={ollama}
          readOnly={serverInfo !== null && !serverInfo.editing_enabled}
        />
        <DisplayMenu settings={display.settings} onChange={display.update} />
      </div>
      <div className="actions-row">
        <select
          className="pipeline-select"
          aria-label="Pipeline"
          value={doc?.definition.name ?? ""}
          onChange={(e) => {
            const name = e.target.value;
            void confirmDiscard().then((ok) => {
              if (ok) void openPipeline(name);
            });
          }}
        >
          {isNew && doc && <option value={doc.definition.name}>{doc.definition.name} (new)</option>}
          {!doc && <option value="">{online === false ? "server unreachable" : "loading…"}</option>}
          {pipelines.map((p) => (
            <option key={p.name} value={p.name} title={p.description}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost icon"
          onClick={undo}
          disabled={undoBlocked !== null}
          title={undoBlocked ? `Undo — ${undoBlocked}` : "Undo (⌘Z / Ctrl+Z)"}
          aria-label="Undo"
        >
          ↶
        </button>
        <button
          type="button"
          className="ghost icon"
          onClick={redo}
          disabled={redoBlocked !== null}
          title={redoBlocked ? `Redo — ${redoBlocked}` : "Redo (⇧⌘Z / Ctrl+Y)"}
          aria-label="Redo"
        >
          ↷
        </button>
        {/* Disabled, it says why — and the status chip shows it too. */}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saveBlocked !== null}
          title={saveBlocked ? `Save — ${saveBlocked}` : "Save (⌘S / Ctrl+S)"}
        >
          Save
        </button>
        {/* Save stays the one filled button; the rest of the file actions
            are in this menu, with Delete last and set apart. */}
        <MenuButton label="File" items={fileMenu} align="end" />
        <input
          ref={importInput}
          type="file"
          accept=".yaml,.yml"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
    </>
  );

  const notices = (
    <>
      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              className="link"
              onClick={() => {
                notice.action?.run();
                setNotice(null);
              }}
            >
              {notice.action.label}
            </button>
          )}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
      {outage && online !== false && <OutageNotice message={outageMessage(outage)} onRetry={() => refreshModels(true)} />}
      {serverInfo && !serverInfo.editing_enabled && (
        <div className="notice info subtle">
          {serverInfo.editing_disabled_reason ? (
            <>Read-only: {serverInfo.editing_disabled_reason}</>
          ) : (
            <>
              Read-only: this server has editing disabled. Set <code>PIPELINE_EDITING_ENABLED=true</code> on the server
              to build and save pipelines here.
            </>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="app" style={panel.style}>
      <LeftPanel
        panel={panel}
        header={header}
        notices={notices}
        sections={sections}
        placeholder={<div className="empty-state">{loadError ?? "loading…"}</div>}
        dock={
          <Composer
            ref={composer}
            pipeline={doc?.definition.name}
            running={running}
            saveFirst={doc?.dirty ?? false}
            disabledReason={runDisabled}
            onSubmit={(prompt) => void run(prompt)}
            onStop={() => stopRun.current?.abort()}
          />
        }
      />
      <main className="canvas-wrap">
        {doc ? (
          <PipelineCanvas
            key={canvasKey}
            nodes={flow.nodes}
            edges={flow.edges}
            editable={editable}
            colorMode={display.theme}
            textScale={display.settings.textScale}
            selectedNodeId={selection?.kind === "node" ? selection.id : null}
            selectedEdgeId={selection?.kind === "edge" ? dependencyEdgeId(selection.from, selection.to) : null}
            fitSignal={fitSignal}
            coveredRight={0}
            onConnect={(from, to) => edit((d) => connect(d, from, to))}
            onDelete={(deletion) => {
              edit((d) => applyCanvasDeletion(d, deletion), undefined, deletionSummary(deletion));
              if (deletion.nodeIds.length > 0) setSelection(null);
            }}
            onMoveNodes={(moves) =>
              edit((d) =>
                moves.reduce((acc, m) => {
                  const layout = acc.nodes.find((n) => n.id === m.id)?.layout;
                  return layout && Math.round(m.x) === layout.x && Math.round(m.y) === layout.y
                    ? acc
                    : moveNode(acc, m.id, m.x, m.y);
                }, d)
              )
            }
            onSelect={select}
            onDropNode={(position, preset) => addNodeAt(position, preset)}
            onAutoLayout={autoLayoutPipeline}
          />
        ) : (
          <div className="canvas-empty">{loadError ?? "loading…"}</div>
        )}
      </main>
    </div>
  );
}
```

Run: `grep -n "panelTab\|setPanelTab\|settingsOpen\|settingsShown\|panels\.\|togglePipelineSettings\|GearIcon\|AddNodeMenu\|RunPanel\|SettingsColumn" src/App.tsx`
Expected: no output.

- [ ] **Step 14: CSS — the panel (`web/src/style.css`)**

Replace the `.app` rule:

```css
.app {
  height: 100%;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr); /* top bar, notices, workspace */
  /* One column no wider than the window: content that can't shrink must
     wrap or clip inside it, never widen the page (on a phone that pushes
     the bottom of the screen — and the message box — out of view). */
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
}
```

with:

```css
.app {
  height: 100%;
  position: relative; /* anchors the panel's edge splitter */
  display: grid;
  /* The left panel (--panel-w, from ui/usePanelLayout.ts), then the canvas. */
  grid-template-columns: var(--panel-w, 440px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}
```

Append at the end of the file:

```css
/* ---------- The left panel (ui/LeftPanel.tsx) ---------- */
.left-panel {
  position: relative;
  z-index: 2; /* its menus and popovers paint over the canvas */
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  container-type: inline-size;
}
.panel-head { flex: none; padding: 9px 12px; display: grid; gap: 7px; border-bottom: 1px solid var(--border); }
.brand-row, .actions-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.brand-row .brand { margin: 0; font-size: var(--fs-lg); font-weight: 700; letter-spacing: 0.02em; color: var(--accent); white-space: nowrap; }
.brand-row .spacer { flex: 1; }
.head-status { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.state-dot { display: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.state-dot.ok { background: var(--valid); }
.state-dot.warn { background: var(--warn); }
.state-dot.error { background: var(--invalid); }
.brand-row .status { gap: 6px; }
.actions-row .pipeline-select { flex: 1; max-width: none; }
/* A narrow panel keeps the pipeline's state as a dot (its tooltip says it). */
@container (max-width: 400px) {
  .head-status .chip-status, .head-status .dirty-dot { display: none; }
  .head-status .state-dot { display: inline-block; }
}
.panel-notices { flex: none; }
.panel-notices .notice { padding: 7px 12px; }

/* Sections: open ones share the height (flex-grow = their weight). */
.psections { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.psec { display: flex; flex-direction: column; min-height: 0; flex: none; }
.psec.open { flex: 1 1 0; min-height: 76px; }
.psec-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px 0 6px;
  border-bottom: 1px solid var(--border);
}
.psec.open > .psec-head { box-shadow: inset 3px 0 0 var(--accent); }
.psec-head.resizable { cursor: row-resize; }
.psec-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.psec-toggle {
  background: none;
  border: none;
  height: 100%;
  padding: 0 6px;
  gap: 8px;
  color: var(--text);
  font-size: var(--fs-xs);
  flex-shrink: 1;
  min-width: 0;
}
.psec-toggle:hover:not(:disabled) { opacity: 1; color: var(--accent); }
.psec-chev { width: 0.8em; color: var(--text-dim); }
.psec-icon { display: inline-flex; color: var(--text-dim); }
.psec.open .psec-icon { color: var(--accent); }
.psec-title { letter-spacing: 0.07em; white-space: nowrap; }
.psec-detail { text-transform: none; letter-spacing: normal; font-weight: 600; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.psec-summary { flex: 1; min-width: 0; text-align: right; font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psec-grip { flex: none; width: 18px; height: 3px; border-top: 1px solid var(--text-faint); border-bottom: 1px solid var(--text-faint); }
.psec-body { flex: 1; min-height: 0; overflow-y: auto; }
.psec-body.fill { display: flex; flex-direction: column; overflow: hidden; }
.psec-body.fill > * { flex: 1; min-height: 0; }
.psec-body > .palette { padding: 10px 12px; }

/* Folded Chat: the last exchange. */
.chat-preview {
  display: grid;
  justify-items: start;
  gap: 3px;
  width: 100%;
  padding: 6px 12px 8px 36px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  color: var(--text-dim);
  font-size: var(--fs-sm);
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
  text-align: left;
}
.chat-preview:hover:not(:disabled) { opacity: 1; background: var(--panel-raised); }
.chat-preview-q { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-preview-q .marker { color: var(--accent); }
.chat-preview-a { color: var(--text); line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.chat-preview-a.failed { color: var(--invalid); }
.chat-preview-a.stopped { color: var(--text-dim); }

/* The docked message box. */
.dock { flex: none; padding: 8px 12px 9px; border-top: 1px solid var(--border); background: var(--panel); box-shadow: 0 -6px 16px var(--shadow); }
.dock .input-row { align-items: flex-end; }
.dock .input-row textarea { min-height: 34px; max-height: 8.5rem; padding: 7px 8px; }
.dock .input-row button { min-width: 88px; height: 34px; padding: 0 12px; }
```

- [ ] **Step 15: Run the gate and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; `fail 0`; `✓ built`.

- [ ] **Step 16: Smoke-check in the browser**

With the API on :8000 and Vite on :5173 (the user's own servers, or `preview_start` by name from `.claude/launch.json`), open `http://localhost:5173` at 1440×900 and check:
- the panel is on the left with the header (title, status chip, dots, Aa / picker, ↶ ↷, Save, File ▾) and Node + Chat open, Pipeline / Tests / Add node folded; no top bar;
- selecting a node shows `NODE other` with its settings; clicking empty canvas shows the "Select a node…" hint;
- folding Chat shows its preview; dragging the Chat header re-splits Node/Chat;
- a message sent from the dock appears in Chat (or the preview, when folded);
- the Add node palette adds a node on click; Pipeline shows the pipeline's settings; Tests shows TestsView.

Fix anything that fails before committing.

- [ ] **Step 17: Commit**

```bash
git add -A web/src web/test
git commit -m "$(printf 'feat(web): one panel on the left, with foldable sections and a docked message box\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 5: Resize, hide, and the rail

**Files:**
- Create: `web/src/ui/PanelRail.tsx`
- Modify: `web/src/ui/icons.tsx`, `web/src/ui/LeftPanel.tsx`, `web/src/App.tsx`, `web/src/style.css`

**Interfaces:**
- Consumes: `PanelLayoutApi` (`width`, `stacked`, `hidden`, `dragWidth`, `resetWidth`, `setHidden`, `openSection`); `Splitter` from `web/src/ui/Splitter.tsx` (`axis`, `grow`, `value`, `onResize(px)`, `onReset()`, `label`, `className`); `StateTone` from `sectionSummaries.ts`.
- Produces: `PanelRail(props: { sections: RailSection[]; state: { tone: StateTone; label: string }; onShow(): void; onOpenSection(id: SectionId): void })`; `LeftPanel`'s new prop `state: { tone: StateTone; label: string }`; icons `PanelHideIcon`, `PanelShowIcon`.

- [ ] **Step 1: The show/hide icons (`web/src/ui/icons.tsx`)**

Append:

```tsx
export function PanelHideIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M11 6l-2 2 2 2" />
    </StrokeIcon>
  );
}

export function PanelShowIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M9 6l2 2-2 2" />
    </StrokeIcon>
  );
}
```

- [ ] **Step 2: `web/src/ui/PanelRail.tsx`**

```tsx
import type { ReactNode } from "react";
import { PanelShowIcon } from "./icons";
import type { SectionId } from "./panelLayout";
import type { StateTone } from "./sectionSummaries";

/** A section as the rail shows it. */
export interface RailSection {
  id: SectionId;
  title: string;
  summary: string;
  icon: ReactNode;
  open: boolean;
  busy: boolean;
}

/**
 * The hidden panel: a 48px rail — show the panel, see the pipeline's
 * state, or jump straight to a section (which shows the panel with it
 * open). Open sections are marked; running ones pulse.
 */
export function PanelRail(props: {
  sections: RailSection[];
  state: { tone: StateTone; label: string };
  onShow: () => void;
  onOpenSection: (id: SectionId) => void;
}) {
  return (
    <nav className="rail" aria-label="Panel (hidden)">
      <button type="button" className="rail-btn" onClick={props.onShow} title="Show panel (⌘\ / Ctrl+\)" aria-label="Show panel">
        <PanelShowIcon />
      </button>
      <span className={`rail-state ${props.state.tone}`} role="img" aria-label={props.state.label} title={props.state.label} />
      <span className="rail-sep" aria-hidden="true" />
      {props.sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className={s.open ? "rail-btn rail-sec open" : "rail-btn rail-sec"}
          title={`${s.title} · ${s.summary}`}
          aria-label={`${s.title}: ${s.summary}`}
          onClick={() => props.onOpenSection(s.id)}
        >
          {s.icon}
          {s.busy && <span className="pulse-dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Rail and edge in `web/src/ui/LeftPanel.tsx`**

Add imports:

```tsx
import { PanelRail } from "./PanelRail";
import { Splitter } from "./Splitter";
import type { StateTone } from "./sectionSummaries";
```

Add the prop after `  dock: ReactNode;`:

```tsx
  /** The pipeline's state, for the rail's dot. */
  state: { tone: StateTone; label: string };
```

Replace `  return (\n    <aside className="left-panel" aria-label="Pipeline panel">` with:

```tsx
  if (panel.hidden) {
    return (
      <aside className="left-panel hidden" aria-label="Pipeline panel (hidden)">
        <PanelRail
          sections={props.sections.map((s) => ({
            id: s.id,
            title: s.detail ? `${s.title} · ${s.detail}` : s.title,
            summary: s.summary,
            icon: s.icon,
            open: layout.open[s.id],
            busy: s.busy ?? false,
          }))}
          state={props.state}
          onShow={() => panel.setHidden(false)}
          onOpenSection={(id) => {
            panel.openSection(id);
            panel.setHidden(false);
          }}
        />
      </aside>
    );
  }

  return (
    <>
    <aside className="left-panel" aria-label="Pipeline panel">
```

and replace the closing `    </aside>\n  );\n}` with:

```tsx
    </aside>
    {/* The right edge: drag to resize (below 240px hides it), double-click
        to reset, ←/→ when focused. Not while stacked. */}
    {!panel.stacked && (
      <Splitter
        axis="x"
        grow={1}
        value={panel.width}
        onResize={panel.dragWidth}
        onReset={panel.resetWidth}
        label="Resize the panel"
        className="splitter-panel-edge"
      />
    )}
    </>
  );
}
```

- [ ] **Step 4: The hide button and rail state in `web/src/App.tsx`**

Replace `import { AddNodeIcon, ChatIcon, NodeIcon, PipelineIcon, TestsIcon } from "./ui/icons";` with `import { AddNodeIcon, ChatIcon, NodeIcon, PanelHideIcon, PipelineIcon, TestsIcon } from "./ui/icons";`.

In `header`, after `        <DisplayMenu settings={display.settings} onChange={display.update} />` add:

```tsx
        {!panel.stacked && (
          <button
            type="button"
            className="ghost icon"
            aria-label="Hide panel"
            title="Hide panel (⌘\ / Ctrl+\)"
            onClick={() => panel.setHidden(true)}
          >
            <PanelHideIcon />
          </button>
        )}
```

In `<LeftPanel`, after `        panel={panel}` add `        state={state}`.

- [ ] **Step 5: CSS for the edge, hiding and the rail (`web/src/style.css`)**

Append:

```css
/* Resizing and hiding the panel (ui/LeftPanel.tsx, ui/PanelRail.tsx). */
.app { transition: grid-template-columns 0.18s ease; }
body.resizing-x .app { transition: none; }
.splitter-panel-edge { left: calc(var(--panel-w) - 4px); }
.left-panel.hidden { align-items: center; }
.rail { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 9px 0; }
.rail-btn {
  position: relative;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-dim);
}
.rail-btn:hover:not(:disabled) { background: var(--panel-raised); color: var(--text); opacity: 1; }
.rail-sec.open { color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
.rail-btn .pulse-dot { position: absolute; top: 4px; right: 4px; margin: 0; }
.rail-state { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); margin: 2px 0; }
.rail-state.ok { background: var(--valid); }
.rail-state.warn { background: var(--warn); }
.rail-state.error { background: var(--invalid); }
.rail-sep { width: 20px; height: 1px; background: var(--border); margin: 2px 0; }
@media (prefers-reduced-motion: reduce) { .app { transition: none; } }
```

- [ ] **Step 6: Run the gate and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; `fail 0`; `✓ built`.

- [ ] **Step 7: Smoke-check in the browser**

At 1440×900: drag the panel edge (width follows; stops at 340 and 760; double-click → 440; ←/→ when focused); drag it far left → the rail; the rail's show button, a section icon (opens that section) and ⌘\ bring it back; the hide button hides it; reload keeps width/hidden/sections.

- [ ] **Step 8: Commit**

```bash
git add -A web/src
git commit -m "$(printf 'feat(web): resize and hide the left panel, with a rail\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 6: Narrow screens, and removing the old layout

**Files:**
- Delete: `web/src/ui/RunPanel.tsx`, `web/src/editor/SettingsColumn.tsx`, `web/src/ui/panelSizes.ts`, `web/test/panelSizes.test.ts`
- Modify: `web/src/ui/Splitter.tsx` (drop `usePanelSizes`), `web/src/ui/icons.tsx` (drop `GearIcon`), `web/src/editor/PipelineCanvas.tsx`, `web/src/editor/revealNode.ts`, `web/test/revealNode.test.ts`, `web/src/App.tsx`, `web/src/style.css`, `web/README.md`

**Interfaces:**
- Produces: `revealCenter(node: FlowRect): { x: number; y: number }` (was `(node, zoom, coveredRight)`); `PipelineCanvasProps` without `topLeft` and `coveredRight`.

- [ ] **Step 1: The simpler `revealCenter` (failing test first)**

In `web/test/revealNode.test.ts`, replace the whole `describe("revealCenter", …)` block with:

```ts
describe("revealCenter", () => {
  it("is the node's centre, which setCenter puts in the middle of the canvas", () => {
    assert.deepEqual(revealCenter(node), { x: 200, y: 140 });
  });
});
```

and in the `needsReveal` block delete the test `"counts a node under the floating settings column as hidden"`.

Run: `npm run typecheck`
Expected: FAIL — `revealCenter` expects 3 arguments.

- [ ] **Step 2: Simplify `revealNode.ts` and the canvas**

In `web/src/editor/revealNode.ts`, replace the `needsReveal` doc comment's first two lines `/** Whether a node's center is outside the part of the canvas that can be\n * seen — the canvas less what covers its right edge (the floating settings\n * column).` with `/** Whether a node's center is outside the canvas.`, and replace the whole `revealCenter` function and its doc comment with:

```ts
/** The flow point to hand React Flow's setCenter to bring a node into the
 * middle of the canvas. */
export function revealCenter(node: FlowRect): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
```

In `web/src/editor/PipelineCanvas.tsx`:
- replace `import type { CSSProperties, DragEvent, ReactNode, RefObject } from "react";` with `import type { DragEvent, RefObject } from "react";`;
- delete the `topLeft` prop (`  /** Shown in the canvas's top-left corner: the + Add node menu. */\n  topLeft?: ReactNode;`) and the `coveredRight` prop (its 3-line doc comment and `  coveredRight: number;`);
- replace `  const { editable, selectedNodeId, selectedEdgeId, textScale, coveredRight } = props;` with `  const { editable, selectedNodeId, selectedEdgeId, textScale } = props;`;
- in the reveal effects replace `  }, [selectedNodeId, size, coveredRight]);` with `  }, [selectedNodeId, size]);`, `    if (!needsReveal(rect, viewport, { width: size.width - coveredRight, height: size.height })) return;` with `    if (!needsReveal(rect, viewport, size)) return;`, `    const center = revealCenter(rect, viewport.zoom, coveredRight);` with `    const center = revealCenter(rect);`, and `  }, [flow, selectedNodeId, size, coveredRight, nodes]);` with `  }, [flow, selectedNodeId, size, nodes]);`;
- replace the canvas div's `      className={\`canvas${compact ? " detail-compact" : ""}${coveredRight > 0 ? " covered" : ""}\`}` with `      className={compact ? "canvas detail-compact" : "canvas"}` and delete the three lines after it (the `// The canvas's own right-hand controls…` comment pair and `style={{ "--covered-right": … }}`);
- delete `        {props.topLeft && <Panel position="top-left">{props.topLeft}</Panel>}`;
- update the reveal effect's comment: replace `  // Keeps the selected node in sight when the canvas narrows or the floating\n  // settings column covers it — e.g. right after selecting it opens the\n  // column.` with `  // Keeps the selected node in sight when the canvas narrows or widens —\n  // the panel being resized, hidden or shown.`.

In `web/src/App.tsx`, delete the line `            coveredRight={0}`.

Run: `npm run typecheck && node --import tsx --test test/revealNode.test.ts`
Expected: no type errors; PASS.

- [ ] **Step 3: Delete the old layout's files**

Run (from `web/`):

```bash
git rm src/ui/RunPanel.tsx src/editor/SettingsColumn.tsx src/ui/panelSizes.ts test/panelSizes.test.ts
```

In `web/src/ui/Splitter.tsx`, replace everything above the `/**` comment that begins "A draggable border between two panels" with:

```tsx
import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

```

In `web/src/ui/icons.tsx`, delete `GearIcon` and its doc comment.

Run: `grep -rn "RunPanel\|SettingsColumn\|panelSizes\|usePanelSizes\|GearIcon\|settingsPlacement\|AddNodeMenu" src test`
Expected: no output.

- [ ] **Step 4: Narrow screens, and the old layout's CSS (`web/src/style.css`)**

Delete these rules (each is dead now — `grep -n` its selector first to find it):
- `.topbar { … }`, `.title-block { … }`, `.title-block h1 { … }`, `.subtitle { … }`, `.toolbar { … }`, `.toolbar .sep { … }`, `.notices { grid-row: 2; }`
- the whole block from `/* ---------- Workspace ---------- */` through the end of the `.panel-footer { … }` rule (`.workspace`, `.workspace.settings-docked`, the settings column, `.run-panel`, `.panel-tabs`, `.panel-body`, `.panel-footer`)
- `.splitter-run { … }`, `.splitter-settings { … }`
- the `/* "+ Add node" in the canvas's top-left corner … */` comment with `.add-node-menu { … }`, `.add-node-menu > button { … }`, `.add-node-popover { … }`
- the `/* While the floating settings column covers the canvas's right edge … */` comment with `.canvas .react-flow__panel.right { … }`, `.canvas .react-flow__panel.top.center { … }`, and the `/* What's left uncovered is under 480px … */` comment with `.canvas.covered .canvas-hint { … }`
- in `:root`, the lines `  --settings-w: 380px;` and `  --run-w: 420px;`

Replace the whole `@media (max-width: 960px) { … }` block (under `/* ---------- Narrow screens: stack the panels ---------- */`) with:

```css
@media (max-width: 960px) {
  .splitter { display: none; } /* stacked: nothing side by side to resize */
  .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto; height: auto; min-height: 100%; }
  .left-panel { height: 80vh; border-right: none; border-bottom: 1px solid var(--border); }
  .canvas-wrap { height: 55vh; }
  /* The message box stays at the bottom of the screen while any of the
     panel is in view. */
  .dock { position: sticky; bottom: 0; z-index: 10; }
}
```

Run: `grep -n "topbar\|workspace\|settings-column\|run-panel\|panel-tabs\|panel-body\|panel-footer\|add-node-\|covered\|--run-w\|--settings-w" src/style.css`
Expected: no output.

- [ ] **Step 5: README (`web/README.md`)**

Replace the **Layout** paragraph (from `**Layout**:` to the blank line after it) with:

```
**Layout**: one **panel** on the left, the canvas taking the rest of the
window. The panel's header holds what a top bar would: the pipeline's
status, the API/Ollama lights, display settings, the pipeline picker,
undo/redo, **Save** and **File ▾**; notices sit under it. Below are
foldable sections — **Node** (the selected node's or dependency's
settings), **Chat**, **Pipeline** (the pipeline's own settings),
**Tests** and **Add node** (the node palette). Any number can be open;
open sections share the panel's height, each scrolling on its own — drag
a section's header (or ↑/↓ on it) to change the split. Folded, Chat shows
the latest message and the start of its answer. The message box is
docked at the bottom of the panel, so a message can be sent whatever is
open. Drag the panel's right edge to resize it (340–760px; double-click
resets); hide it with the button in its header, **⌘\ / Ctrl+\**, or by
dragging the edge far left — a narrow rail keeps the pipeline's state and
a button per section. Width, hiding, open sections and the split are
remembered in this browser. On a narrow screen (960px or less) the panel
sits above the canvas and the message box stays at the bottom of the
screen as you scroll.
```

Then:
- `- **Add nodes** with **+ Add node** in the canvas corner: drag "LLM node"` → `- **Add nodes** from the **Add node** section: drag "LLM node"`
- `  **+ Add node** menu (hover for the details, filter when there are many): drag or` → `  **Add node** section (hover for the details, filter when there are many): drag or`
- `- **Configure a node** in the **settings column**, in sections that fold — each` → `- **Configure a node** in the **Node** section, in sections that fold — each`
- `- **Pipeline settings** (**⚙** beside the pipeline picker, the pipeline's\n  name at the top of the settings column, or click empty canvas while the\n  column is open): description, output node(s),` → `- **Pipeline settings** (the **Pipeline** section): description, output node(s),`
- `**Tests** (a tab in the run panel): the pipeline's test cases — a message` → `**Tests** (a section of the panel): the pipeline's test cases — a message`
- `turns are summarized are per-pipeline settings (⚙ beside the pipeline\npicker → Conversation history).` → `turns are summarized are per-pipeline settings (Pipeline → Conversation\nhistory).`

In the file tree, replace the lines for `SettingsColumn.tsx`, `AddNodeMenu.tsx`, `RunPanel.tsx` and `panelSizes.ts` with:

```
    │   ├── NodePalette.tsx     # the Add node section: blank node, presets
    │   ├── PipelineSettings.tsx # the Pipeline section: the pipeline's own settings
    │   ├── selection.ts        # what's selected, and what selecting opens
```
```
    │   ├── ChatPreview.tsx     # folded Chat: the latest message and its answer
    │   ├── lastExchange.ts     # what that preview shows
```
```
        ├── LeftPanel.tsx       # the one panel: header, notices, sections, dock
        ├── PanelSection.tsx    # a foldable section that shares the panel's height
        ├── PanelRail.tsx       # the hidden panel's rail
        ├── panelLayout.ts      # width, hiding, open sections and the split — the rules
        ├── usePanelLayout.ts   # …remembered in this browser, and ⌘\
        ├── sectionSummaries.ts # each section's one-line header
```

(`ChatPreview`/`lastExchange` under `run/`, the rest under `editor/` and `ui/` where their siblings are.) Keep `Splitter.tsx` with the comment `# the panel's resizable edge`.

- [ ] **Step 6: Run the gate and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; `fail 0`; `✓ built`.

- [ ] **Step 7: Commit**

```bash
git add -A web
git commit -m "$(printf 'refactor(web): stacked narrow layout; remove the old top bar, columns and run panel\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 7: Browser checks

**Files:**
- Modify: whatever the checks show is wrong (then gate and commit the fix).

- [ ] **Step 1: Full gate**

Run (from `web/`): `npm run typecheck && npm test && npm run build`
Expected: no type errors; `fail 0`; `✓ built`.

- [ ] **Step 2: Wide windows (1920×1080, 1440×900)**

- Node + Chat open on first visit (clear `llm-pipeline.panel-layout.v1` first); section headers show the right titles and summaries; the header rows fit.
- Edit a node's prompt while reading Chat; send from the dock (**Save & send** with changes); the answer streams in Chat; fold Chat — the preview streams.
- Open Pipeline and Tests too: four-way split; drag headers and ↑/↓ on them; nothing gets shorter than 76px.
- Add node section: click adds below the selected node; drag onto the canvas adds there.
- The File menu and Aa stay on screen; notices (e.g. delete a node → "Deleted … · Undo") appear under the header.

- [ ] **Step 3: Resize and hide**

- Edge: drag (340–760), double-click (440), ←/→; at 1100×800 a saved 760 shows as 660 and stays 760 in storage (Review Focus 1).
- Hide by button, ⌘\ and dragging far left; the rail shows the state dot (amber with unsaved changes), open sections marked; a section icon opens it; ⌘\ brings the panel back as it was.
- During a run: hide the panel — the rail's Chat icon pulses; Esc stops the run; show the panel — the dock and Chat preview are back (Review Focus 5).
- The selected node stays in view as the panel resizes or hides/shows.
- Reload: width, hidden, open sections and split are kept.

- [ ] **Step 4: Odd saved state (Review Focus 2)**

Set `localStorage["llm-pipeline.panel-layout.v1"]` to `{"open":{"node":false,"chat":false,"pipeline":false,"tests":false,"add":false}}` and reload: every section folded, headers usable, the dock visible. Then set it to `{"weights":{"node":-3},"width":"x"}` and reload: defaults, no errors in the console.

- [ ] **Step 5: 1366×768, 1024×768, and 768×1024 (stacked)**

- 1366 and 1024: the same checks at a glance; at 1024 the panel's max is 614px.
- 768: panel above the canvas, full width; no hide button, no rail, no edge; the dock sticks to the bottom of the screen while the panel is in view; with `hidden: true` saved the panel still shows, and widening the window brings back the rail (Review Focus 4).

- [ ] **Step 6: Light and dark**

Switch the theme (Aa) at 1440×900: panel, sections, preview, rail and dock read clearly in both.

- [ ] **Step 7: Fix, re-check, commit**

For anything that failed: fix it in the file that owns it, run the gate, repeat the failed check, and commit (`fix(web): …`, with the Co-Authored-By line). Report which checks passed and which couldn't run (e.g. streaming without Ollama).
