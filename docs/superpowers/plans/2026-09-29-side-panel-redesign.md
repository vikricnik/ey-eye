# Side Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web client's one-view-at-a-time side panel with `canvas | settings column | run panel (Chat, Tests)`, so node settings, Chat, traces and Tests can be seen together and nothing switches views on its own.

**Architecture:** Pure logic (column widths and placement, the node trace summary, stick-to-bottom, keeping the selected node in view, which settings are showing) lives in small `.ts`/`.tsx` exports with `node:test` tests. The UI changes happen in order, each leaving the app working: widths → a node's trace becomes a section → traces move into Chat → "Add node" moves to the canvas → the settings column takes over from the Settings tab → the canvas keeps the selected node in sight. A final task checks everything in the browser.

**Tech Stack:** React 19, TypeScript 5.7, Vite 6, `@xyflow/react` 12, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-29-side-panel-redesign-design.md`

## Global Constraints

- Only `web/` changes. `packages/client`, `cli/` and `llm_pipeline/` are untouched. No new dependencies.
- Column widths: settings **380px** default, run **420px** default; each column at least **320px**; the canvas never under **280px**; the settings column docks only while the canvas keeps **≥ 480px**, else it floats; at a window **≤ 960px** everything stacks. Storage key `llm-pipeline.panel-sizes.v3` (v2's value is ignored).
- The term is **Trace** everywhere (UX-010). The Add button's label is **+ Add node**.
- Styling follows `UX_REVIEW.md`: every `font-size` comes from the `--fs-*` scale and every color from the theme tokens (`test/readability.test.ts` enforces the first); no hard-coded colors.
- Disabled controls say why in their `title` (UX-011).
- Comments match the codebase's style: plain-language JSDoc saying *why*, not *what*.
- Gate after every task, from `web/`: `npm run typecheck` and `npm test`. The last task also runs `npm run build`.
- Commit after each task, message `feat(web): …` / `refactor(web): …`, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The selected node disappears while its settings are open** (deleted from the canvas, renamed, or removed by undo): the column's header and body must fall back to the pipeline, not show "› node" over pipeline settings. Pinned by `settingsSubject` tests in Task 5.
2. **Clicking a node whose spot the floating column is about to cover**: after the column opens, the node must be panned clear of it, not left underneath. Pinned by `needsReveal` / `revealCenter` tests in Task 6.
3. **Stored sizes from before this change, or unreadable storage** (v2's `{"panel":440}`, `"null"`, bad JSON, a string width): defaults are used and nothing throws. Pinned by `readPanelSizes` tests in Task 1.
4. **Reading an earlier trace while a new run streams**: the transcript must not jump to the bottom; sending a new message must. Pinned by `isNearBottom` tests in Task 3, plus the browser check in Task 7.
5. **Esc while the + Add node popover is open during a run**: only the popover closes; the run keeps going. A cancelled drag from the popover (dropped outside the canvas, or Esc mid-drag) adds nothing and leaves the popover open. There's no DOM test harness here, so both are browser checks in Task 7; the code that makes them true is in Task 4.

---

### Task 1: Two column widths and where the settings column goes

**Files:**
- Create: `web/src/ui/panelSizes.ts`
- Modify: `web/src/ui/Splitter.tsx` (replace lines 1–80: the sizing code; the `Splitter` component below it stays)
- Modify: `web/src/App.tsx` (the panel `Splitter` near the end of the JSX)
- Modify: `web/src/style.css` (`:root`, `.workspace`, `.splitter-panel`)
- Modify: `web/README.md` (file tree)
- Test: `web/test/panelSizes.test.ts` (rewrite)

**Interfaces:**
- Produces (in `web/src/ui/panelSizes.ts`):
  - `interface PanelSizes { settings: number; run: number }`
  - `type SettingsPlacement = "docked" | "floating" | "stacked"`
  - `const DEFAULT_PANEL_SIZES: PanelSizes` = `{ settings: 380, run: 420 }`
  - `const PANEL_SIZES_STORAGE_KEY = "llm-pipeline.panel-sizes.v3"`
  - `function clampPanelSizes(sizes: PanelSizes, width: number): PanelSizes`
  - `function readPanelSizes(raw: string | null): PanelSizes`
  - `function settingsPlacement(sizes: PanelSizes, width: number): SettingsPlacement`
- Produces (in `web/src/ui/Splitter.tsx`): `usePanelSizes(): { sizes: PanelSizes; placement: SettingsPlacement; setSize(column: keyof PanelSizes, px: number): void; resetSize(column: keyof PanelSizes): void; style: CSSProperties }`. `style` sets the CSS variables `--settings-w` and `--run-w`.

- [ ] **Step 1: Write the failing test**

Replace all of `web/test/panelSizes.test.ts` with:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_PANEL_SIZES, clampPanelSizes, readPanelSizes, settingsPlacement } from "../src/ui/panelSizes";

describe("clampPanelSizes", () => {
  it("keeps the defaults in a laptop-sized window", () => {
    assert.deepEqual(clampPanelSizes(DEFAULT_PANEL_SIZES, 1366), DEFAULT_PANEL_SIZES);
  });

  it("keeps both columns usable", () => {
    assert.deepEqual(clampPanelSizes({ settings: 100, run: 100 }, 1400), { settings: 320, run: 320 });
  });

  it("leaves the canvas 280px beside the run panel, then beside both columns", () => {
    assert.equal(clampPanelSizes({ settings: 380, run: 1300 }, 1400).run, 1120);
    assert.equal(clampPanelSizes({ settings: 900, run: 420 }, 1400).settings, 700);
  });

  it("gives a tiny window usable columns anyway", () => {
    assert.deepEqual(clampPanelSizes(DEFAULT_PANEL_SIZES, 500), { settings: 320, run: 320 });
  });
});

describe("readPanelSizes", () => {
  it("reads the widths someone chose as they were saved — the window fits them later", () => {
    assert.deepEqual(readPanelSizes('{"settings":500,"run":600}'), { settings: 500, run: 600 });
    assert.equal(clampPanelSizes(readPanelSizes('{"settings":500,"run":600}'), 1000).run, 600);
  });

  it("fills in a width that's missing or unreadable with its default", () => {
    assert.deepEqual(readPanelSizes('{"run":600}'), { settings: 380, run: 600 });
    assert.deepEqual(readPanelSizes('{"settings":"wide","run":600}'), { settings: 380, run: 600 });
  });

  it("falls back to the defaults when nothing (readable) was saved — including v2's single width", () => {
    assert.deepEqual(readPanelSizes(null), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes("{oops"), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes("null"), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes('{"panel":600}'), DEFAULT_PANEL_SIZES);
  });
});

describe("settingsPlacement", () => {
  it("docks the settings column while the canvas keeps 480px", () => {
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1920), "docked");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1366), "docked");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1280), "docked", "exactly 480px left");
  });

  it("floats it over the canvas when docking would leave less", () => {
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1279), "floating");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1100), "floating");
    assert.equal(settingsPlacement({ settings: 600, run: 600 }, 1600), "floating");
  });

  it("stacks everything in a narrow window, like the CSS does", () => {
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 961), "floating");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 960), "stacked");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 375), "stacked");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `node --import tsx --test test/panelSizes.test.ts`
Expected: FAIL — cannot find module `../src/ui/panelSizes`.

- [ ] **Step 3: Write `web/src/ui/panelSizes.ts`**

```ts
/** Widths of the two columns beside the canvas. */
export interface PanelSizes {
  /** The settings column: the selected node's, dependency's or pipeline's settings. */
  settings: number;
  /** The run panel: Chat and Tests. */
  run: number;
}

/** Where the settings column goes: its own grid column; floating over the
 * canvas's right edge, when docking would leave the canvas too narrow; or
 * stacked with everything else in a narrow window. */
export type SettingsPlacement = "docked" | "floating" | "stacked";

export const DEFAULT_PANEL_SIZES: PanelSizes = { settings: 380, run: 420 };

// v3: the settings and run columns (v2 stored one panel width).
export const PANEL_SIZES_STORAGE_KEY = "llm-pipeline.panel-sizes.v3";

/** Narrower, and a column's fields stop fitting. */
const MIN_COLUMN_WIDTH = 320;
/** Smallest the canvas may get when a column grows. */
const MIN_CANVAS_WIDTH = 280;
/** Docked, the settings column must leave the canvas at least this much —
 * less, and it floats over the canvas instead. */
const MIN_DOCKED_CANVAS_WIDTH = 480;
/** At or below this window width everything stacks — keep in step with
 * the `@media (max-width: 960px)` block in style.css. */
const STACKED_MAX_WIDTH = 960;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Keeps both columns usable, and leaves the canvas room, in a window this wide. */
export function clampPanelSizes(sizes: PanelSizes, width: number): PanelSizes {
  const run = clamp(sizes.run, MIN_COLUMN_WIDTH, width - MIN_CANVAS_WIDTH);
  const settings = clamp(sizes.settings, MIN_COLUMN_WIDTH, width - run - MIN_CANVAS_WIDTH);
  return { settings, run };
}

/** The widths someone chose, as saved — not fitted to any window. A width
 * that's missing or unreadable is its default. */
export function readPanelSizes(raw: string | null): PanelSizes {
  try {
    const saved = JSON.parse(raw ?? "{}") as Partial<Record<keyof PanelSizes, unknown>>;
    return {
      settings: typeof saved.settings === "number" ? saved.settings : DEFAULT_PANEL_SIZES.settings,
      run: typeof saved.run === "number" ? saved.run : DEFAULT_PANEL_SIZES.run,
    };
  } catch {
    return DEFAULT_PANEL_SIZES; // unreadable (or "null") — defaults are fine
  }
}

/** Docked while the canvas keeps 480px beside both columns, else floating;
 * stacked in a narrow window. `sizes` are the widths as shown (clamped). */
export function settingsPlacement(sizes: PanelSizes, width: number): SettingsPlacement {
  if (width <= STACKED_MAX_WIDTH) return "stacked";
  return width - sizes.settings - sizes.run >= MIN_DOCKED_CANVAS_WIDTH ? "docked" : "floating";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/panelSizes.test.ts`
Expected: PASS (all 10 tests).

- [ ] **Step 5: Rewrite the sizing hook in `web/src/ui/Splitter.tsx`**

Replace everything from the top of the file down to (and including) the closing `}` of `usePanelSizes` — the lines above the `/**` comment that starts "A draggable border between two panels" — with:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { DEFAULT_PANEL_SIZES, PANEL_SIZES_STORAGE_KEY, clampPanelSizes, readPanelSizes, settingsPlacement } from "./panelSizes";
import type { PanelSizes, SettingsPlacement } from "./panelSizes";

function loadSizes(): PanelSizes {
  try {
    return readPanelSizes(window.localStorage.getItem(PANEL_SIZES_STORAGE_KEY));
  } catch {
    return DEFAULT_PANEL_SIZES; // storage unavailable (private mode, blocked) — defaults are fine
  }
}

/** The columns' widths, remembered in this browser and applied as the CSS
 * variables the workspace grid uses, and where the settings column goes.
 * What's remembered is the width someone chose (dragging, or resetting);
 * the window only limits what's shown — so a narrow window, even a visit
 * on a phone, doesn't shrink it for good. */
export function usePanelSizes(): {
  sizes: PanelSizes;
  placement: SettingsPlacement;
  setSize: (column: keyof PanelSizes, px: number) => void;
  resetSize: (column: keyof PanelSizes) => void;
  style: CSSProperties;
} {
  const [chosen, setChosen] = useState<PanelSizes>(loadSizes);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const sizes = clampPanelSizes(chosen, windowWidth);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** A width someone picked: fitted to the window it was picked in, and saved. */
  const choose = useCallback((next: (current: PanelSizes) => PanelSizes) => {
    setChosen((current) => {
      const width = window.innerWidth;
      const fitted = clampPanelSizes(next(clampPanelSizes(current, width)), width);
      try {
        window.localStorage.setItem(PANEL_SIZES_STORAGE_KEY, JSON.stringify(fitted));
      } catch {
        // not persisted — still applied for this page
      }
      return fitted;
    });
  }, []);

  return {
    sizes,
    placement: settingsPlacement(sizes, windowWidth),
    setSize: useCallback((column, px) => choose((s) => ({ ...s, [column]: Math.round(px) })), [choose]),
    resetSize: useCallback((column) => choose((s) => ({ ...s, [column]: DEFAULT_PANEL_SIZES[column] })), [choose]),
    style: { "--settings-w": `${sizes.settings}px`, "--run-w": `${sizes.run}px` } as CSSProperties,
  };
}
```

- [ ] **Step 6: Point the existing panel splitter at the run width in `web/src/App.tsx`**

Replace:

```tsx
            value={panels.sizes.panel}
            onResize={(px) => panels.setSize("panel", px)}
            onReset={() => panels.resetSize("panel")}
            label="Resize the panel"
            className="splitter-panel"
```

with:

```tsx
            value={panels.sizes.run}
            onResize={(px) => panels.setSize("run", px)}
            onReset={() => panels.resetSize("run")}
            label="Resize the run panel"
            className="splitter-run"
```

- [ ] **Step 7: Rename the CSS variable and splitter class in `web/src/style.css`**

In `:root`, replace `  --panel-w: 440px;` with:

```css
  --settings-w: 380px;
  --run-w: 420px;
```

In `.workspace`, replace `  grid-template-columns: minmax(0, 1fr) var(--panel-w);` with `  grid-template-columns: minmax(0, 1fr) var(--run-w);`.

Replace `.splitter-panel { right: calc(var(--panel-w) - 4px); }` with `.splitter-run { right: calc(var(--run-w) - 4px); }`.

Then run `grep -n "panel-w\|splitter-panel" src/ -r`. Expected: no output.

- [ ] **Step 8: Update the file tree in `web/README.md`**

Replace:

```
        ├── Splitter.tsx        # resizing the panel
```

with:

```
        ├── Splitter.tsx        # resizing the columns
        ├── panelSizes.ts       # column widths, and where the settings column goes
```

- [ ] **Step 9: Run the gate**

Run (from `web/`): `npm run typecheck && npm test`
Expected: typecheck prints nothing; tests report `fail 0`.

- [ ] **Step 10: Commit**

```bash
git add web/src/ui/panelSizes.ts web/src/ui/Splitter.tsx web/src/App.tsx web/src/style.css web/README.md web/test/panelSizes.test.ts
git commit -m "$(printf 'refactor(web): two column widths and settings placement\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 2: A node's trace becomes a section of its settings

**Files:**
- Create: `web/src/editor/traceSummary.ts`
- Create: `web/src/editor/NodeTrace.tsx`
- Modify: `web/src/editor/Inspector.tsx` (imports; `Inspector`; `NodeInspector`; delete `NodeMessages`)
- Modify: `web/src/style.css` (`.tabs` goes, `.node-trace` added)
- Modify: `web/README.md`
- Test: `web/test/traceSummary.test.ts`

> Why `traceSummary.ts` and not `nodeTrace.ts`: macOS file systems ignore case, so `./nodeTrace` and `./NodeTrace` could resolve to the same file.

**Interfaces:**
- Produces: `nodeTraceSummary(nodeId: string, turns: readonly { log: readonly Pick<RunLogEntry, "nodeId" | "status" | "durationMs">[] }[]): string` in `web/src/editor/traceSummary.ts`.
- Produces: `NodeTrace(props: { nodeId: string; turns: Turn[]; isOutput: boolean })` in `web/src/editor/NodeTrace.tsx`.
- Consumes: `Turn` from `web/src/run/Chat.tsx`; `MessageEntry` from `web/src/run/MessageEntry.tsx`; `Section` from `web/src/editor/Section.tsx` (`id`, `title`, `summary`, `defaultOpen`).

- [ ] **Step 1: Write the failing test**

Create `web/test/traceSummary.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { RunLogEntry } from "@llm-pipeline/client";

import { nodeTraceSummary } from "../src/editor/traceSummary";

const entry = (nodeId: string, status: RunLogEntry["status"], durationMs: number | null = null) => ({
  nodeId,
  status,
  durationMs,
});

describe("nodeTraceSummary", () => {
  it("says so when the node hasn't run in this session", () => {
    assert.equal(nodeTraceSummary("b", []), "hasn't run yet");
    assert.equal(nodeTraceSummary("b", [{ log: [entry("a", "complete", 900)] }]), "hasn't run yet");
  });

  it("describes the latest run the node took part in, numbered among all runs", () => {
    const turns = [
      { log: [entry("a", "complete", 400), entry("b", "complete", 1800)] },
      { log: [entry("a", "complete", 300)] },
    ];
    assert.equal(nodeTraceSummary("b", turns), "run 1 · 1.8s");
    assert.equal(nodeTraceSummary("a", turns), "run 2 · 300ms");
  });

  it("uses the node's last execution in a run — a loop's final pass", () => {
    const turns = [{ log: [entry("b", "complete", 500), entry("b", "complete", 2500)] }];
    assert.equal(nodeTraceSummary("b", turns), "run 1 · 2.5s");
  });

  it("marks a node that's running, failed or was stopped", () => {
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "running")] }]), "run 1 · live");
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "failed", 200)] }]), "run 1 · failed");
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "stopped")] }]), "run 1 · stopped");
  });

  it("leaves out a duration the server didn't report", () => {
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "complete", null)] }]), "run 1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/traceSummary.test.ts`
Expected: FAIL — cannot find module `../src/editor/traceSummary`.

- [ ] **Step 3: Write `web/src/editor/traceSummary.ts`**

```ts
import type { RunLogEntry } from "@llm-pipeline/client";
import { formatDuration } from "../format";

type TraceEntry = Pick<RunLogEntry, "nodeId" | "status" | "durationMs">;

/** The folded Trace section's line for one node: its latest run in this
 * session — "run 3 · 1.8s", "run 3 · live" while it runs — or that it
 * hasn't run. `turns` are the session's runs, oldest first; within a run
 * the node's last execution (a loop's final pass) is the one described. */
export function nodeTraceSummary(nodeId: string, turns: readonly { log: readonly TraceEntry[] }[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const last = turns[i]!.log.filter((entry) => entry.nodeId === nodeId).at(-1);
    if (!last) continue;
    const run = `run ${i + 1}`;
    if (last.status === "running") return `${run} · live`;
    if (last.status === "failed" || last.status === "stopped") return `${run} · ${last.status}`;
    return last.durationMs !== null ? `${run} · ${formatDuration(last.durationMs)}` : run;
  }
  return "hasn't run yet";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/traceSummary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Create `web/src/editor/NodeTrace.tsx`**

This is `NodeMessages` from `Inspector.tsx`, moved and renamed, with the empty-state text updated (the message box is no longer "below"):

```tsx
import { MessageEntry } from "../run/MessageEntry";
import type { Turn } from "../run/Chat";

/** What this node received and replied in each run of the session, newest
 * first — including loop re-runs, and live while it runs. The Trace
 * section of the node's settings. */
export function NodeTrace({ nodeId, turns, isOutput }: { nodeId: string; turns: Turn[]; isOutput: boolean }) {
  const runs = turns
    .map((turn, index) => ({ turn, index, entries: turn.log.filter((e) => e.nodeId === nodeId) }))
    .filter((r) => r.entries.length > 0)
    .reverse();
  if (runs.length === 0) {
    return (
      <p className="dim">
        <b>{nodeId}</b> hasn&apos;t run in this session yet. Send a message in Chat — what it receives and replies
        shows up here, live.
      </p>
    );
  }
  return (
    <div className="node-messages">
      {runs.map(({ turn, index, entries }) => (
        <section key={turn.id} className="node-messages-run">
          <h3>
            run {index + 1} <span className="dim">› {turn.prompt}</span>
          </h3>
          {entries
            .slice()
            .reverse()
            .map((entry) => (
              <MessageEntry key={entry.key} entry={entry} isOutput={isOutput} showNodeId={false} />
            ))}
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Swap the imports in `web/src/editor/Inspector.tsx`**

Replace:

```ts
import { MessageEntry } from "../run/MessageEntry";
```

with:

```ts
import { NodeTrace } from "./NodeTrace";
import { nodeTraceSummary } from "./traceSummary";
```

In `InspectorProps`, replace the comment `  /** This session's runs — the node's Trace tab shows its part of them. */` with `  /** This session's runs — a node's Trace section shows its part of them. */`.

- [ ] **Step 7: Remove the sub-tab state from `Inspector`**

Replace:

```tsx
type NodeTab = "config" | "trace";

export function Inspector(props: InspectorProps) {
  const { doc, selection } = props;
  // Kept while moving between nodes, so you can step through each node's messages.
  const [tab, setTab] = useState<NodeTab>("config");
  const node =
```

with:

```tsx
export function Inspector(props: InspectorProps) {
  const { doc, selection } = props;
  const node =
```

Replace `        <NodeInspector key={node.id} node={node} tab={tab} onTab={setTab} {...props} />` with `        <NodeInspector key={node.id} node={node} {...props} />`.

Replace:

```tsx
function NodeInspector(props: InspectorProps & { node: NodeConfig; tab: NodeTab; onTab: (tab: NodeTab) => void }) {
  const { node, doc, editable, onEdit, onSelect, presets, validation, tab, onTab } = props;
```

with:

```tsx
function NodeInspector(props: InspectorProps & { node: NodeConfig }) {
  const { node, doc, editable, onEdit, onSelect, presets, validation } = props;
```

- [ ] **Step 8: Replace the Configuration/Trace sub-tabs with the Trace section**

Replace:

```tsx
      <div className="tabs" role="tablist" aria-label="Node view">
        <button type="button" role="tab" aria-selected={tab === "config"} className={tab === "config" ? "tab active" : "tab"} onClick={() => onTab("config")}>
          Configuration
        </button>
        <button type="button" role="tab" aria-selected={tab === "trace"} className={tab === "trace" ? "tab active" : "tab"} onClick={() => onTab("trace")}>
          Trace
        </button>
      </div>

      {tab === "trace" ? (
        <NodeMessages nodeId={id} turns={props.turns} isOutput={isOutput} />
      ) : (
        <>
          <Section
            id="model"
```

with:

```tsx
      {/* First, so a node's latest input and reply can be read while the
          settings below it are changed; capped in height (.node-trace). */}
      <Section id="trace" title="Trace" defaultOpen={false} summary={nodeTraceSummary(id, props.turns)}>
        <div className="node-trace">
          <NodeTrace nodeId={id} turns={props.turns} isOutput={isOutput} />
        </div>
      </Section>
          <Section
            id="model"
```

Then close the removed fragment and ternary. Replace (this is the end of `NodeInspector`, right after the Presets section):

```tsx
          </Section>
        </>
      )}
    </div>
  );
}
```

with:

```tsx
          </Section>
    </div>
  );
}
```

Then dedent the lines between these two edits (from `<Section id="model"` through that last `</Section>`) by four spaces, so they sit at the same depth as the Trace section. Find the range with `grep -n 'id="model"\|id="presets"' src/editor/Inspector.tsx` and the `</Section>` after `id="presets"`; `sed -i '' 'START,ENDs/^    //' src/editor/Inspector.tsx` with those line numbers does it on macOS.

- [ ] **Step 9: Delete `NodeMessages` from `Inspector.tsx`**

Delete the whole function, including its doc comment — from `/** What this node received and replied in each run of the session, newest` through the closing `}` of `function NodeMessages(...)`.

Run: `grep -n "NodeMessages\|MessageEntry\|NodeTab\|onTab" src/editor/Inspector.tsx`
Expected: no output.

- [ ] **Step 10: Update `web/src/style.css`**

Delete the rule `.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 4px 0 6px; }` (the Inspector's sub-tabs were its only user; `.tab` stays — the panel tabs use it).

After `.inspector .message-text { max-height: 12.5rem; }`, add:

```css
/* A node's Trace section scrolls on its own, so the settings below it stay
   in view while its latest input and reply are read. */
.node-trace { max-height: 40vh; overflow-y: auto; }
```

- [ ] **Step 11: Update `web/README.md`**

In the file tree, after `    │   ├── Section.tsx         # foldable settings sections, remembered open or closed`, add:

```
    │   ├── NodeTrace.tsx       # a node's own trace, in its settings
    │   ├── traceSummary.ts     # the folded Trace section's one-line summary
```

Replace:

```
- In a node's Settings, its own **Trace** sub-tab shows just that node's
  received messages and replies, newest run first. The sub-tab stays
  selected as you click from node to node.
```

with:

```
- In a node's settings, its own **Trace** section (the first one) shows
  just that node's received messages and replies, newest run first —
  folded, it says when the node last ran ("run 3 · 1.8s", "live"). It
  stays open or folded as you click from node to node.
```

Replace `- Selecting a node after a run shows its last output in its Settings.` with `- Selecting a node after a run shows its last output in its Trace section.`

- [ ] **Step 12: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

- [ ] **Step 13: Commit**

```bash
git add web/src/editor/traceSummary.ts web/src/editor/NodeTrace.tsx web/src/editor/Inspector.tsx web/src/style.css web/README.md web/test/traceSummary.test.ts
git commit -m "$(printf 'feat(web): node trace as a section of its settings\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 3: Each chat turn carries its trace; the Trace tab goes

**Files:**
- Create: `web/src/run/stickToBottom.ts`
- Rename + rewrite: `web/src/run/MessagesView.tsx` → `web/src/run/RunTrace.tsx`
- Modify: `web/src/run/Chat.tsx`
- Modify: `web/src/ui/SidePanel.tsx` (drop the `trace` tab)
- Modify: `web/src/App.tsx`
- Modify: `web/src/style.css`
- Modify: `web/README.md`
- Test: `web/test/stickToBottom.test.ts`

**Interfaces:**
- Produces: `isNearBottom(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean` in `web/src/run/stickToBottom.ts`.
- Produces: `RunTrace(props: { turn: Turn; outputNodeIds: ReadonlySet<string>; onSelectNode: (nodeId: string) => void; rerunnable?: ReadonlySet<string> | undefined; onRerun: (nodeId: string) => void })` in `web/src/run/RunTrace.tsx`.
- Changes `Chat`'s props: removes `verbose`, `onVerbose`; adds `openTraces: boolean`, `onOpenTraces: (open: boolean) => void`, `outputNodeIds: ReadonlySet<string>`, `onSelectNode: (nodeId: string) => void`, `rerunnable: ReadonlySet<string>`, `onRerun: (nodeId: string) => void`.
- `PanelTab` becomes `"chat" | "settings" | "add" | "tests"`.

- [ ] **Step 1: Write the failing test**

Create `web/test/stickToBottom.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isNearBottom } from "../src/run/stickToBottom";

describe("isNearBottom", () => {
  it("counts the very end, and anything within 40px of it", () => {
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 561, clientHeight: 400 }), true);
  });

  it("doesn't count a box scrolled up to read something earlier", () => {
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }), false);
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 400 }), false);
  });

  it("counts content that fits without scrolling", () => {
    assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 }), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/stickToBottom.test.ts`
Expected: FAIL — cannot find module `../src/run/stickToBottom`.

- [ ] **Step 3: Write `web/src/run/stickToBottom.ts`**

```ts
/** How close to the end still counts as "at the end" — about a line. */
const THRESHOLD_PX = 40;

/** Whether a scrolling box is showing its end. New content should keep it
 * there; scrolled up, the reader's place is left alone. */
export function isNearBottom(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < THRESHOLD_PX;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/stickToBottom.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Turn `MessagesView.tsx` into `RunTrace.tsx`**

Run (from `web/`): `git mv src/run/MessagesView.tsx src/run/RunTrace.tsx`

Replace all of `web/src/run/RunTrace.tsx` with:

```tsx
import { MessageEntry } from "./MessageEntry";
import type { Turn } from "./Chat";

/**
 * One run's trace, inside its chat turn: each node in the order it started
 * — what it received and what it replied, streaming live. Clicking a node
 * name opens its settings; the latest run's nodes offer a re-run.
 */
export function RunTrace(props: {
  turn: Turn;
  outputNodeIds: ReadonlySet<string>;
  onSelectNode: (nodeId: string) => void;
  /** Set on the latest run only: the nodes it can be re-run from. */
  rerunnable?: ReadonlySet<string> | undefined;
  onRerun: (nodeId: string) => void;
}) {
  const { turn, rerunnable } = props;
  if (turn.log.length === 0) {
    return <p className="dim">{turn.status === "running" ? "starting…" : "no node ran"}</p>;
  }
  return (
    <div className="run-trace">
      {turn.log.map((entry) => (
        <MessageEntry
          key={entry.key}
          entry={entry}
          isOutput={props.outputNodeIds.has(entry.nodeId)}
          onSelectNode={props.onSelectNode}
          {...(rerunnable?.has(entry.nodeId) ? { onRerun: () => props.onRerun(entry.nodeId) } : {})}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Add the imports to `web/src/run/Chat.tsx`**

Replace:

```ts
import { RunErrorView } from "./RunErrorView";
```

with:

```ts
import { RunErrorView } from "./RunErrorView";
import { RunTrace } from "./RunTrace";
```

and replace:

```ts
import type { ConversationSummary } from "./runHistory";
```

with:

```ts
import type { ConversationSummary } from "./runHistory";
import { isNearBottom } from "./stickToBottom";
```

- [ ] **Step 7: Put the trace into `TurnView`, and drop the node-output cards**

Delete `function NodeCard` entirely (from `function NodeCard({ node, isOutput }` through its closing `}`).

Replace:

```tsx
function TurnView(props: {
  turn: Turn;
  verbose: boolean;
  formatted: boolean;
  pendingAnswer?: string | undefined;
  actions?: ReactNode;
}) {
  const { turn, verbose, pendingAnswer, actions } = props;
```

with:

```tsx
function TurnView(props: {
  turn: Turn;
  /** The run's trace (see Chat), between the message and the answer. */
  trace: ReactNode;
  formatted: boolean;
  pendingAnswer?: string | undefined;
  actions?: ReactNode;
}) {
  const { turn, pendingAnswer, actions } = props;
```

Replace:

```tsx
        {turn.rerunFrom && <span className="tag-mini">re-run from {turn.rerunFrom}</span>}
      </div>
      {turn.status === "stopped" ? (
```

with:

```tsx
        {turn.rerunFrom && <span className="tag-mini">re-run from {turn.rerunFrom}</span>}
      </div>
      {props.trace}
      {turn.status === "stopped" ? (
```

Delete:

```tsx
          {verbose && turn.nodeOutputs.length > 0 && (
            <div className="candidates">
              <div className="candidates-label">Node outputs ({turn.nodeOutputs.length})</div>
              {turn.nodeOutputs.map((n, i) => (
                <NodeCard key={`${n.node_id}-${i}`} node={n} isOutput={result?.output_node === n.node_id} />
              ))}
            </div>
          )}
```

- [ ] **Step 8: Change `Chat`'s props**

Replace:

```tsx
/**
 * The Chat tab: which conversation this is (saved in this browser — pick
 * an earlier one, start a new one or delete this one) and its transcript.
 * Node status on the canvas updates live from the same runs.
 */
export function Chat(props: {
  turns: Turn[];
  running: boolean;
  /** The output node's text so far, while the latest turn is running. */
  pendingAnswer?: string | undefined;
  verbose: boolean;
  onVerbose: (verbose: boolean) => void;
```

with:

```tsx
/**
 * The Chat tab: which conversation this is (saved in this browser — pick
 * an earlier one, start a new one or delete this one) and its transcript,
 * each run with its trace. Node status on the canvas updates live from the
 * same runs.
 */
export function Chat(props: {
  turns: Turn[];
  running: boolean;
  /** The output node's text so far, while the latest turn is running. */
  pendingAnswer?: string | undefined;
  /** Whether each run's trace starts open ("open traces"). */
  openTraces: boolean;
  onOpenTraces: (open: boolean) => void;
  /** The output nodes, marked in traces. */
  outputNodeIds: ReadonlySet<string>;
  /** Opens a node's settings (its name in a trace). */
  onSelectNode: (nodeId: string) => void;
  /** Nodes the latest run can be re-run from (empty while running). */
  rerunnable: ReadonlySet<string>;
  onRerun: (nodeId: string) => void;
```

- [ ] **Step 9: Scroll only while at the end, and render each turn's trace**

Replace:

```tsx
  const transcript = useRef<HTMLDivElement>(null);
  const current = props.conversations.find((c) => c.id === props.currentConversation);
```

with:

```tsx
  const transcript = useRef<HTMLDivElement>(null);
  // Follows new text only while scrolled to the end, so a streaming trace
  // doesn't pull the view away from an earlier turn being read.
  const stickToBottom = useRef(true);
  const current = props.conversations.find((c) => c.id === props.currentConversation);
```

Replace:

```tsx
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.turns, props.pendingAnswer]);
```

with:

```tsx
  // A new message, or another conversation, always shows its end. (Declared
  // before the effect below, which reads it, so it runs first.)
  useEffect(() => {
    stickToBottom.current = true;
  }, [props.turns.length]);

  useEffect(() => {
    const el = transcript.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [props.turns, props.pendingAnswer]);

  /** A run's trace, folded between its message and its answer. "open
   * traces" sets whether it starts open; each can still be folded alone. */
  const trace = (turn: Turn, latest: boolean) => {
    if (turn.log.length === 0 && turn.status !== "running") return null;
    const nodes = new Set(turn.log.map((entry) => entry.nodeId)).size;
    return (
      <details className="turn-trace" open={props.openTraces}>
        <summary>
          Trace · {nodes} node{nodes === 1 ? "" : "s"}
        </summary>
        <RunTrace
          turn={turn}
          outputNodeIds={props.outputNodeIds}
          onSelectNode={props.onSelectNode}
          rerunnable={latest ? props.rerunnable : undefined}
          onRerun={props.onRerun}
        />
      </details>
    );
  };
```

Replace `      <div className="transcript" ref={transcript}>` with:

```tsx
      <div
        className="transcript"
        ref={transcript}
        onScroll={(e) => {
          stickToBottom.current = isNearBottom(e.currentTarget);
        }}
      >
```

Replace:

```tsx
            <TurnView
              key={t.id}
              turn={t}
              verbose={props.verbose}
              formatted={props.formatted}
```

with:

```tsx
            <TurnView
              key={t.id}
              turn={t}
              trace={trace(t, i === props.turns.length - 1)}
              formatted={props.formatted}
```

Replace:

```tsx
        <label className="toggle">
          <input type="checkbox" checked={props.verbose} onChange={(e) => props.onVerbose(e.target.checked)} />
          show every node&apos;s output
        </label>
```

with:

```tsx
        <label className="toggle" title="Start each run's trace open — what every node received and replied">
          <input type="checkbox" checked={props.openTraces} onChange={(e) => props.onOpenTraces(e.target.checked)} />
          open traces
        </label>
```

Run: `grep -n "verbose\|NodeCard\|candidate" src/run/Chat.tsx`
Expected: no output.

- [ ] **Step 10: Drop the Trace tab from `web/src/ui/SidePanel.tsx`**

Replace `export type PanelTab = "chat" | "settings" | "add" | "trace" | "tests";` with `export type PanelTab = "chat" | "settings" | "add" | "tests";`

Delete the line:

```ts
  { id: "trace", label: "Trace", title: "What every node received and replied, run by run" },
```

Replace `  { id: "chat", label: "Chat", title: "The conversation with this pipeline" },` with `  { id: "chat", label: "Chat", title: "The conversation with this pipeline, and each run's trace" },`.

- [ ] **Step 11: Wire it up in `web/src/App.tsx`**

Delete the line `import { MessagesView } from "./run/MessagesView";`.

Replace `  const [verbose, setVerbose] = useState(false);` with:

```tsx
  // Whether each run's trace in Chat starts open (for this session).
  const [openTraces, setOpenTraces] = useState(false);
```

Replace:

```tsx
              onSubmit={(prompt) => {
                // Show the answer coming in — unless the trace is what's being watched.
                if (panelTab !== "trace") setPanelTab("chat");
                void run(prompt);
              }}
```

with:

```tsx
              onSubmit={(prompt) => {
                // Show the answer coming in (and its trace).
                setPanelTab("chat");
                void run(prompt);
              }}
```

Replace:

```tsx
              pendingAnswer={pendingAnswer}
              verbose={verbose}
              onVerbose={setVerbose}
```

with:

```tsx
              pendingAnswer={pendingAnswer}
              openTraces={openTraces}
              onOpenTraces={setOpenTraces}
              outputNodeIds={outputIds}
              onSelectNode={(nodeId) => setSelection({ kind: "node", id: nodeId })}
              rerunnable={rerunnable}
              onRerun={(id) => void run("", id)}
```

Replace:

```tsx
          ) : panelTab === "trace" ? (
            <MessagesView
              turns={turns}
              outputNodeIds={outputIds}
              onSelectNode={(nodeId) => setSelection({ kind: "node", id: nodeId })}
              rerunnable={rerunnable}
              onRerun={(id) => void run("", id)}
            />
          ) : panelTab === "add" ? (
```

with:

```tsx
          ) : panelTab === "add" ? (
```

Run: `grep -n "verbose\|MessagesView\|\"trace\"" src/App.tsx`
Expected: no output.

- [ ] **Step 12: Update `web/src/style.css`**

Delete these rules (the node-output cards and the Trace tab — nothing else uses them; `grep -rn 'className="candidate\|className={`candidate\|className="badge\|className="messages-' src --include='*.tsx'` must print nothing first — `node-messages-run` in `NodeTrace.tsx` is a different class and stays):

```css
.candidates + .final-answer { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
.candidates { display: flex; flex-direction: column; gap: 8px; }
.candidates-label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
.candidate { background: var(--panel-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; }
.candidate.winner { border-color: var(--accent-dim); }
.candidate-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: var(--fs-sm); flex-wrap: wrap; }
.candidate-header .model-name { color: var(--accent); font-weight: 600; }
```

the whole `.badge { … }` block and the two lines after it:

```css
.badge.winner-badge { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); margin-left: auto; }
.candidate-answer { color: var(--text-dim); white-space: pre-wrap; line-height: 1.5; max-height: 8.75rem; overflow-y: auto; }
```

and:

```css
.messages-view {
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.messages-run { max-width: 1000px; width: 100%; margin: 0 auto; display: grid; gap: 10px; }
.messages-run-head { display: flex; gap: 10px; align-items: baseline; font-size: var(--fs-md); }
.messages-run-head .marker { color: var(--accent); }
.messages-run-prompt { color: var(--text); flex: 1; }
```

After `.turn-prompt .marker { color: var(--accent); flex-shrink: 0; }`, add:

```css
/* A run's trace, folded between its message and its answer (run/RunTrace.tsx). */
.turn-trace { margin-bottom: 8px; }
.turn-trace > summary { cursor: pointer; color: var(--text-dim); font-size: var(--fs-sm); width: fit-content; }
.turn-trace[open] > summary { margin-bottom: 8px; }
.run-trace { display: grid; gap: 8px; }
```

- [ ] **Step 13: Update `web/README.md`**

In the file tree, replace:

```
    │   ├── Chat.tsx            # the Chat tab (conversation picker, transcript) and the message box
```

with:

```
    │   ├── Chat.tsx            # the Chat tab (conversation picker, transcript with traces) and the message box
```

and replace:

```
    │   ├── MessagesView.tsx    # the Trace tab: what every node received and replied, per run
```

with:

```
    │   ├── RunTrace.tsx        # a run's trace in Chat: what every node received and replied
    │   ├── stickToBottom.ts    # follow new text only while scrolled to the end
```

Replace:

```
- **Trace** tab: a log of every run in the conversation — each node in
  the order it started, with the **system prompt and prompt it actually
  received** (its dependencies' outputs filled in) and the **reply** it
  produced, streaming live. Loop passes appear as separate entries
  ("iteration 2", …). Click a node's name to open its Settings.
```

with:

```
- **Trace** (under each message in Chat — "Trace · 3 nodes"): each node
  in the order it started, with the **system prompt and prompt it actually
  received** (its dependencies' outputs filled in) and the **reply** it
  produced, streaming live. Loop passes appear as separate entries
  ("iteration 2", …). Click a node's name to open its settings. **open
  traces** (in Chat) starts every run's trace open.
```

Delete:

```
- **"show every node's output"** (in Chat) lists every node's output in the
  transcript.
```

Replace:

```
- **trace** — every node's prompt and output in a run, in order: the
  **Trace** tab, and a node's own Trace in its settings.
```

with:

```
- **trace** — every node's prompt and output in a run, in order: under
  each message in Chat, and a node's own Trace in its settings.
```

- [ ] **Step 14: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

- [ ] **Step 15: Commit**

```bash
git add -A web/src/run web/src/ui/SidePanel.tsx web/src/App.tsx web/src/style.css web/README.md web/test/stickToBottom.test.ts
git commit -m "$(printf 'feat(web): each chat turn carries its trace; drop the Trace tab\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 4: "+ Add node" on the canvas; the Add tab goes

**Files:**
- Rename + rewrite: `web/src/editor/Sidebar.tsx` → `web/src/editor/AddNodeMenu.tsx`
- Modify: `web/src/editor/PipelineCanvas.tsx` (a `topLeft` slot)
- Modify: `web/src/editor/canvasHint.ts`
- Modify: `web/src/ui/SidePanel.tsx` (drop the `add` tab)
- Modify: `web/src/App.tsx`
- Modify: `web/src/style.css`
- Modify: `web/README.md`
- Test: `web/test/canvasHint.test.ts`

**Interfaces:**
- Produces: `AddNodeMenu(props: { editable: boolean; presets: NodePreset[]; onAdd: (presetName: string | undefined) => void; onDeletePreset: (name: string) => void })` in `web/src/editor/AddNodeMenu.tsx`.
- Adds to `PipelineCanvasProps`: `topLeft?: ReactNode`.
- Consumes: `NODE_DRAG_TYPE` from `web/src/editor/PipelineCanvas.tsx`.
- `PanelTab` becomes `"chat" | "settings" | "tests"`.

- [ ] **Step 1: Change the hint's test**

In `web/test/canvasHint.test.ts`, replace `    assert.match(canvasHint({ nodes: 1, edges: 0, editable: true }) ?? "", /Add tab/);` with `    assert.match(canvasHint({ nodes: 1, edges: 0, editable: true }) ?? "", /\+ Add node/);`

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/canvasHint.test.ts`
Expected: FAIL — the hint still says "from the Add tab".

- [ ] **Step 3: Update `web/src/editor/canvasHint.ts`**

Replace `  if (canvas.nodes === 1) return "Add more nodes from the Add tab — drag one onto the canvas, or click it.";` with `  if (canvas.nodes === 1) return "Add more nodes with + Add node — drag one onto the canvas, or click it.";`

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/canvasHint.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Turn `Sidebar.tsx` into `AddNodeMenu.tsx`**

Run (from `web/`): `git mv src/editor/Sidebar.tsx src/editor/AddNodeMenu.tsx`

Replace all of `web/src/editor/AddNodeMenu.tsx` with the following. `excerpt` and `summary` are unchanged. `Palette` is the old `Sidebar` with three changes: the redundant "Add" heading is gone, the class is `palette`, and it reports finished drags.

```tsx
import { useEffect, useId, useRef, useState } from "react";
import type { NodePreset } from "@llm-pipeline/client";
import { NODE_DRAG_TYPE } from "./PipelineCanvas";

function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Everything a preset carries, for its tooltip. */
function summary(p: NodePreset): string {
  return [
    `${p.model.provider}:${p.model.name}${p.model.temperature !== undefined ? ` · temperature ${p.model.temperature}` : ""}`,
    p.model.options && Object.keys(p.model.options).length > 0
      ? `options: ${Object.entries(p.model.options)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
          .join(" ")}`
      : null,
    p.system_prompt ? `system: ${excerpt(p.system_prompt)}` : null,
    p.prompt_template !== undefined ? `prompt: ${excerpt(p.prompt_template)}` : "prompt: not saved (keeps the node's own)",
    p.include_history === false ? "doesn't see the conversation history" : null,
    p.strip_reasoning === true ? "strips <think> reasoning" : p.strip_reasoning === false ? "keeps <think> reasoning" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Things to put on the canvas: a blank LLM node, or a node from a
 * preset. Drag onto the canvas, or click to add (below the selected node,
 * connected to it). */
function Palette(props: {
  editable: boolean;
  presets: NodePreset[];
  onAdd: (presetName: string | undefined) => void;
  /** An item was dropped on the canvas — not a drag that was cancelled. */
  onDropped: () => void;
  onDeletePreset: (name: string) => void;
}) {
  const { editable, presets, onAdd, onDropped, onDeletePreset } = props;
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shown = query
    ? presets.filter((p) =>
        [p.name, p.description, p.model.name, p.system_prompt, p.prompt_template].some((t) =>
          t?.toLowerCase().includes(query)
        )
      )
    : presets;

  const item = (label: string, detail: string, preset: NodePreset | undefined, tags: string[] = []) => (
    <button
      type="button"
      key={preset?.name ?? "__blank"}
      className="palette-item"
      draggable={editable}
      disabled={!editable}
      title={
        editable
          ? `${preset ? `${summary(preset)}\n\n` : ""}drag onto the canvas, or click to add`
          : "editing is disabled on this server"
      }
      onDragStart={(e) => {
        e.dataTransfer.setData(NODE_DRAG_TYPE, preset?.name ?? "");
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={(e) => {
        // "none" when the drag was cancelled (Esc, or dropped off the canvas).
        if (e.dataTransfer.dropEffect !== "none") onDropped();
      }}
      onClick={() => onAdd(preset?.name)}
    >
      <span className="palette-label">{label}</span>
      <span className="palette-detail">{detail}</span>
      {tags.length > 0 && (
        <span className="palette-meta">
          {tags.map((t) => (
            <span className="palette-tag" key={t}>
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );

  return (
    <nav className="palette" aria-label="Node palette">
      {item("LLM node", "a model call with a prompt", undefined)}
      <h3>Presets</h3>
      {presets.length === 0 ? (
        <p className="dim">
          Select a node and use <strong>Save as preset</strong> to keep its model, prompts and settings — then add it
          to any pipeline from here.
        </p>
      ) : (
        <>
          {presets.length > 5 && (
            <input
              type="search"
              className="palette-filter"
              placeholder="filter presets…"
              aria-label="Filter presets"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {shown.length === 0 && <p className="dim">No preset matches “{filter.trim()}”.</p>}
          {shown.map((p) => (
            <div className="palette-row" key={p.name}>
              {item(
                p.name,
                p.description || `${p.model.provider}:${p.model.name}`,
                p,
                [
                  p.description ? p.model.name : null,
                  p.model.temperature !== undefined ? `T ${p.model.temperature}` : null,
                  p.include_history === false ? "no history" : null,
                  p.strip_reasoning ? "strips reasoning" : null,
                ].filter((t): t is string => t !== null)
              )}
              {editable && (
                <button
                  type="button"
                  className="ghost icon palette-remove"
                  aria-label={`Remove the preset ${p.name}`}
                  title="Remove this preset"
                  onClick={() => onDeletePreset(p.name)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </nav>
  );
}

/**
 * "+ Add node" in the canvas corner: a popover with a blank LLM node and
 * the saved presets. Click one to add it below the selected node (connected
 * to it), or drag it onto the canvas. It closes once a node is added, on
 * Escape, or on a click elsewhere — and stays open during a drag, since
 * removing what's being dragged can cancel the drop.
 */
export function AddNodeMenu(props: {
  editable: boolean;
  presets: NodePreset[];
  onAdd: (presetName: string | undefined) => void;
  onDeletePreset: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      // Confirming a preset's removal (a dialog) is still using the menu.
      if (!wrapper.current?.contains(target) && !target.closest?.("dialog")) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      className="add-node-menu"
      ref={wrapper}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation(); // not also "stop the run" (App's Esc)
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="ghost"
        aria-expanded={open}
        aria-controls={`${id}-palette`}
        disabled={!props.editable}
        title={props.editable ? "Add a node: blank, or from a preset" : "Add node — editing is disabled on this server"}
        onClick={() => setOpen((o) => !o)}
      >
        + Add node
      </button>
      {open && (
        // nowheel/nopan: scrolling or dragging in here doesn't move the canvas.
        <div className="add-node-popover nowheel nopan" id={`${id}-palette`}>
          <Palette
            editable={props.editable}
            presets={props.presets}
            onAdd={(presetName) => {
              props.onAdd(presetName);
              setOpen(false);
            }}
            onDropped={() => setOpen(false)}
            onDeletePreset={props.onDeletePreset}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Give the canvas a top-left slot in `web/src/editor/PipelineCanvas.tsx`**

Replace `import type { DragEvent, RefObject } from "react";` with `import type { DragEvent, ReactNode, RefObject } from "react";`

Replace:

```ts
/** Drag-and-drop payload type set by the sidebar palette. The value is a
 * preset name, or "" for a plain node. */
```

with:

```ts
/** Drag-and-drop payload type set by the + Add node palette
 * (AddNodeMenu.tsx). The value is a preset name, or "" for a plain node. */
```

In `PipelineCanvasProps`, after `  onAutoLayout: () => void;`, add:

```ts
  /** Shown in the canvas's top-left corner: the + Add node menu. */
  topLeft?: ReactNode;
```

Replace:

```tsx
        <Panel position="top-right">
          <CanvasLegend />
        </Panel>
```

with:

```tsx
        {props.topLeft && <Panel position="top-left">{props.topLeft}</Panel>}
        <Panel position="top-right">
          <CanvasLegend />
        </Panel>
```

- [ ] **Step 7: Drop the Add tab from `web/src/ui/SidePanel.tsx`**

Replace `export type PanelTab = "chat" | "settings" | "add" | "tests";` with `export type PanelTab = "chat" | "settings" | "tests";`

Delete the line `  { id: "add", label: "Add", title: "Add a node: blank, or from a preset" },`.

- [ ] **Step 8: Wire it up in `web/src/App.tsx`**

Replace `import { Sidebar } from "./editor/Sidebar";` with `import { AddNodeMenu } from "./editor/AddNodeMenu";`

In the `<PipelineCanvas` element, after `              fitSignal={fitSignal}`, add:

```tsx
              topLeft={
                <AddNodeMenu
                  editable={editable}
                  presets={presets}
                  onAdd={(preset) => addNodeAt(undefined, preset)}
                  onDeletePreset={(name) => void deletePreset(name)}
                />
              }
```

Replace:

```tsx
          ) : panelTab === "add" ? (
            <Sidebar
              editable={editable && Boolean(doc)}
              presets={presets}
              onAdd={(preset) => addNodeAt(undefined, preset)}
              onDeletePreset={(name) => void deletePreset(name)}
            />
          ) : !doc ? (
```

with:

```tsx
          ) : !doc ? (
```

Update the copy that points at the old place:
- `      /* optional feature — the sidebar just shows none */` → `      /* optional feature — + Add node just lists none */`
- In `saveNodeAsPreset`'s dialog body, `          from the sidebar.` → `          with + Add node on the canvas.`
- `          placeholder: "what it's for — shown in the sidebar",` → `          placeholder: "what it's for — shown under + Add node",`
- `                hint: "add more from the presets in the sidebar",` → `                hint: "add more with + Add node on the canvas",`

Run: `grep -rn 'sidebar\|Sidebar\|Add tab\|"add"' src --include='*.ts' --include='*.tsx'`
Expected: no output. (`style.css` still says `.sidebar` until the next step.)

- [ ] **Step 9: Update `web/src/style.css`**

Rename the palette rules from `.sidebar` to `.palette`. Replace:

```css
.sidebar {
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
```

with:

```css
.palette {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
```

Replace `.sidebar h3, .inspector h3 {` with `.palette h3, .inspector h3 {`, `.sidebar h3:first-child { margin-top: 0; }` with `.palette h3:first-child { margin-top: 0; }`, and `.sidebar .dim { font-size: var(--fs-sm); line-height: 1.5; margin: 0; }` with `.palette .dim { font-size: var(--fs-sm); line-height: 1.5; margin: 0; }`.

After the `.canvas-legend > button { background: var(--panel); }` line, add:

```css
/* "+ Add node" in the canvas's top-left corner (editor/AddNodeMenu.tsx):
   placed like the display popover, opening rightwards from the corner. */
.add-node-menu { position: relative; }
.add-node-menu > button { background: var(--panel); box-shadow: 0 2px 10px var(--shadow); }
.add-node-popover {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 50;
  width: 20rem;
  max-width: calc(100cqi - 30px);
  max-height: min(60vh, 32rem);
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px var(--shadow-strong);
  padding: 12px;
}
```

The canvas hint (top-center) must not run under the new top-left button. In `.canvas-hint`, replace `  max-width: calc(100% - 140px);` with `  max-width: calc(100% - 300px);` and add right after the `.canvas-hint { … }` block:

```css
/* On a narrow canvas there's no room beside the corner controls: drop the
   hint below them instead. */
@container (max-width: 760px) {
  .canvas-hint { max-width: calc(100% - 30px); margin-top: 60px; }
}
```

- [ ] **Step 10: Update `web/README.md`**

In the file tree, replace:

```
    │   ├── Sidebar.tsx         # the Add tab: blank node, presets
```

with:

```
    │   ├── AddNodeMenu.tsx     # "+ Add node" in the canvas corner: blank node, presets
```

Replace:

```
- **Add nodes** by dragging "LLM node" (or a preset)
  from the **Add** tab onto the canvas, or by clicking it — with a node
  selected, the new node is added *after* it (below it; further clicks place
  siblings side by side).
```

with:

```
- **Add nodes** with **+ Add node** in the canvas corner: drag "LLM node"
  (or a preset) onto the canvas, or click it — with a node selected, the
  new node is added *after* it (below it; further clicks place siblings
  side by side).
```

Replace `  **Add** tab (hover for the details, filter when there are many): drag or` with `  **+ Add node** menu (hover for the details, filter when there are many): drag or`.

- [ ] **Step 11: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0` (the readability test checks the new CSS too).

- [ ] **Step 12: Commit**

```bash
git add -A web/src/editor web/src/ui/SidePanel.tsx web/src/App.tsx web/src/style.css web/README.md web/test/canvasHint.test.ts
git commit -m "$(printf 'feat(web): + Add node on the canvas; drop the Add tab\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 5: The settings column; the side panel becomes the run panel

**Files:**
- Create: `web/src/editor/SettingsColumn.tsx`
- Rename + rewrite: `web/src/ui/SidePanel.tsx` → `web/src/ui/RunPanel.tsx`
- Modify: `web/src/editor/Inspector.tsx` (breadcrumbs move out)
- Modify: `web/src/App.tsx`
- Modify: `web/src/style.css`
- Modify: `web/README.md`
- Test: `web/test/settingsSubject.test.ts`

**Interfaces:**
- Produces (in `web/src/editor/SettingsColumn.tsx`):
  - `type SettingsSubject = "pipeline" | "node" | "dependency"`
  - `settingsSubject(definition: PipelineDefinition, selection: Selection | null): SettingsSubject`
  - `SettingsColumn(props: { pipeline: string; subject: SettingsSubject; placement: SettingsPlacement; onPipeline: () => void; onClose: () => void; children: ReactNode })`
- Produces (in `web/src/ui/RunPanel.tsx`): `type PanelTab = "chat" | "tests"`, `PANEL_TABS`, `RunPanel(props)` — the same props as `SidePanel` had.
- Consumes: `usePanelSizes()` → `sizes.settings`, `placement`, `setSize("settings", px)`, `resetSize("settings")` (Task 1); `Selection` from `web/src/editor/editorState.ts` (`{kind:"node",id} | {kind:"edge",from,to} | {kind:"pipeline"}`).

- [ ] **Step 1: Write the failing test**

Create `web/test/settingsSubject.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PipelineDefinition } from "@llm-pipeline/client";

import { settingsSubject } from "../src/editor/SettingsColumn";

const definition = {
  name: "p",
  nodes: [{ id: "a" }, { id: "b" }],
  output_nodes: ["b"],
} as unknown as PipelineDefinition;

describe("settingsSubject", () => {
  it("names what's selected", () => {
    assert.equal(settingsSubject(definition, { kind: "node", id: "a" }), "node");
    assert.equal(settingsSubject(definition, { kind: "edge", from: "a", to: "b" }), "dependency");
  });

  it("is the pipeline with nothing selected", () => {
    assert.equal(settingsSubject(definition, null), "pipeline");
    assert.equal(settingsSubject(definition, { kind: "pipeline" }), "pipeline");
  });

  it("falls back to the pipeline when the selected node is gone — deleted, renamed or undone", () => {
    assert.equal(settingsSubject(definition, { kind: "node", id: "gone" }), "pipeline");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/settingsSubject.test.ts`
Expected: FAIL — cannot find module `../src/editor/SettingsColumn`.

- [ ] **Step 3: Write `web/src/editor/SettingsColumn.tsx`**

```tsx
import type { ReactNode } from "react";
import type { PipelineDefinition } from "@llm-pipeline/client";
import type { Selection } from "./editorState";
import type { SettingsPlacement } from "../ui/panelSizes";

/** What the settings column is showing. */
export type SettingsSubject = "pipeline" | "node" | "dependency";

/** A selected node that no longer exists (deleted, renamed, undone) shows
 * the pipeline — as the Inspector does — so the header says so too. */
export function settingsSubject(definition: PipelineDefinition, selection: Selection | null): SettingsSubject {
  if (selection?.kind === "node") return definition.nodes.some((n) => n.id === selection.id) ? "node" : "pipeline";
  return selection?.kind === "edge" ? "dependency" : "pipeline";
}

/**
 * The column between the canvas and the run panel: the selected node's or
 * dependency's settings, or the pipeline's. Its header says which — with
 * the way back up to the pipeline's settings — and closes the column,
 * giving the canvas its width back.
 */
export function SettingsColumn(props: {
  pipeline: string;
  subject: SettingsSubject;
  placement: SettingsPlacement;
  onPipeline: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className={`settings-column ${props.placement}`} aria-label="Settings">
      <header className="settings-column-head">
        {props.subject === "pipeline" ? (
          <span className="kicker">pipeline</span>
        ) : (
          <nav className="kicker breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="link" title="The pipeline's own settings" onClick={props.onPipeline}>
              {props.pipeline}
            </button>
            <span aria-hidden="true">›</span>
            <span>{props.subject}</span>
          </nav>
        )}
        <button
          type="button"
          className="ghost icon small"
          aria-label="Close settings"
          title="Close — selecting a node, or ⚙, opens it again"
          onClick={props.onClose}
        >
          ✕
        </button>
      </header>
      {props.children}
    </aside>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/settingsSubject.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Move the breadcrumbs out of `web/src/editor/Inspector.tsx`**

Delete the whole `Breadcrumb` function and its doc comment (from `/** "pipeline-name › node": where these settings sit, and the way back up` through the closing `}` of `function Breadcrumb`).

Replace (in `NodeInspector`):

```tsx
      <header className="inspector-title">
        <Breadcrumb pipeline={def.name} kind="node" onPipeline={() => onSelect(null)} />
        <h2>{id}</h2>
```

with:

```tsx
      <header className="inspector-title">
        <h2>{id}</h2>
```

Replace (in `EdgeInspector`):

```tsx
      <header className="inspector-title">
        <Breadcrumb pipeline={props.doc.definition.name} kind="dependency" onPipeline={() => onSelect(null)} />
        <h2>
```

with:

```tsx
      <header className="inspector-title">
        <h2>
```

Replace (in `PipelineInspector`):

```tsx
      <header className="inspector-title">
        <span className="kicker">pipeline</span>
        <h2>{def.name}</h2>
```

with:

```tsx
      <header className="inspector-title">
        <h2>{def.name}</h2>
```

Run: `grep -n "Breadcrumb\|kicker" src/editor/Inspector.tsx`
Expected: no output. (If `onSelect` is now unused in `NodeInspector`'s destructuring, typecheck will not complain — it's still used by rename and delete.)

- [ ] **Step 6: Turn `SidePanel.tsx` into `RunPanel.tsx`**

Run (from `web/`): `git mv src/ui/SidePanel.tsx src/ui/RunPanel.tsx`

Replace all of `web/src/ui/RunPanel.tsx` with:

```tsx
import type { ReactNode } from "react";

export type PanelTab = "chat" | "tests";

export const PANEL_TABS: { id: PanelTab; label: string; title: string }[] = [
  { id: "chat", label: "Chat", title: "The conversation with this pipeline, and each run's trace" },
  { id: "tests", label: "Tests", title: "Test cases and model comparisons" },
];

/**
 * The run panel, at the right: Chat and Tests, and the message box under
 * Chat (Tests has its own Run buttons, for test cases). Settings have their
 * own column (editor/SettingsColumn.tsx), so nothing here switches tabs
 * on its own.
 */
export function RunPanel(props: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** Shown after a tab's label — e.g. a pulsing dot while it's busy. */
  badges?: Partial<Record<PanelTab, ReactNode>>;
  children: ReactNode;
  footer: ReactNode;
  /** Hides the footer without unmounting it, so what's typed there is kept. */
  footerHidden?: boolean;
}) {
  return (
    <aside className="run-panel" aria-label="Run">
      <div className="panel-tabs" role="tablist" aria-label="Run">
        {PANEL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`panel-tab-${t.id}`}
            aria-selected={props.tab === t.id}
            aria-controls="panel-body"
            title={t.title}
            className={props.tab === t.id ? "tab active" : "tab"}
            onClick={() => props.onTab(t.id)}
          >
            {t.label}
            {props.badges?.[t.id]}
          </button>
        ))}
      </div>
      <div className="panel-body" id="panel-body" role="tabpanel" aria-labelledby={`panel-tab-${props.tab}`}>
        {props.children}
      </div>
      <div className="panel-footer" hidden={props.footerHidden}>
        {props.footer}
      </div>
    </aside>
  );
}
```

- [ ] **Step 7: Imports and state in `web/src/App.tsx`**

Replace:

```tsx
import { SidePanel } from "./ui/SidePanel";
import type { PanelTab } from "./ui/SidePanel";
```

with:

```tsx
import { RunPanel } from "./ui/RunPanel";
import type { PanelTab } from "./ui/RunPanel";
import { SettingsColumn, settingsSubject } from "./editor/SettingsColumn";
```

Replace:

```tsx
  // Which tab of the side panel is showing (see ui/SidePanel.tsx).
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");
```

with:

```tsx
  // Which tab of the run panel is showing (see ui/RunPanel.tsx), and
  // whether the settings column is open (see editor/SettingsColumn.tsx).
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
```

- [ ] **Step 8: Selection opens the column; the gear toggles the pipeline's settings**

Replace:

```tsx
  // Selecting a node or edge — on the canvas, from Messages, by adding one —
  // shows its settings.
  const selectionKey =
    selection?.kind === "node" ? `node:${selection.id}` : selection?.kind === "edge" ? `edge:${selection.from}->${selection.to}` : "";
  useEffect(() => {
    if (selectionKey) setPanelTab("settings");
  }, [selectionKey]);

  // The pipeline's own settings are Settings with nothing selected — opened
  // from the button beside the pipeline picker, or a node's breadcrumb.
  const pipelineSettingsOpen = panelTab === "settings" && selection === null;
  const openPipelineSettings = () => {
    setSelection(null);
    setPanelTab("settings");
  };
```

with:

```tsx
  // Selecting a node or edge — on the canvas, in a trace, by adding one —
  // opens the settings column on it. Nothing else changes what's showing.
  const selectionKey =
    selection?.kind === "node" ? `node:${selection.id}` : selection?.kind === "edge" ? `edge:${selection.from}->${selection.to}` : "";
  useEffect(() => {
    if (selectionKey) setSettingsOpen(true);
  }, [selectionKey]);

  // The column, while there's a pipeline to show settings for.
  const settingsShown = settingsOpen && doc !== null;
  // The pipeline's own settings are the column with nothing selected —
  // opened, and closed again, by the gear beside the pipeline picker.
  const pipelineSettingsOpen = settingsShown && selection === null;
  const togglePipelineSettings = () => {
    if (pipelineSettingsOpen) {
      setSettingsOpen(false);
      return;
    }
    setSelection(null);
    setSettingsOpen(true);
  };
```

In the gear button, replace `            onClick={openPipelineSettings}` with `            onClick={togglePipelineSettings}`.

- [ ] **Step 9: The three-column workspace**

Replace the whole workspace — from `      <div className="workspace">` down to its closing `      </div>` (the line just before the final `    </div>` and `  );`) — with:

```tsx
      <div className={settingsShown && panels.placement === "docked" ? "workspace settings-docked" : "workspace"}>
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
              topLeft={
                <AddNodeMenu
                  editable={editable}
                  presets={presets}
                  onAdd={(preset) => addNodeAt(undefined, preset)}
                  onDeletePreset={(name) => void deletePreset(name)}
                />
              }
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
              onSelect={setSelection}
              onDropNode={(position, preset) => addNodeAt(position, preset)}
              onAutoLayout={autoLayoutPipeline}
            />
          ) : (
            <div className="canvas-empty">{loadError ?? "loading…"}</div>
          )}
        </main>
        {settingsShown && (
          <Splitter
            axis="x"
            grow={-1}
            value={panels.sizes.settings}
            onResize={(px) => panels.setSize("settings", px)}
            onReset={() => panels.resetSize("settings")}
            label="Resize the settings column"
            className="splitter-settings"
          />
        )}
        {settingsShown && doc && (
          <SettingsColumn
            pipeline={doc.definition.name}
            subject={settingsSubject(doc.definition, selection)}
            placement={panels.placement}
            onPipeline={() => setSelection(null)}
            onClose={() => setSettingsOpen(false)}
          >
            <Inspector
              doc={doc}
              selection={selection}
              editable={editable}
              models={models}
              presets={presets}
              turns={turns}
              validation={doc.dirty ? validation : { status: "idle" }}
              onEdit={edit}
              onSelect={setSelection}
              onRefreshModels={() => void refreshModels(true)}
              onSaveAsPreset={(id) => void saveNodeAsPreset(id)}
              onDuplicate={duplicate}
              rerunnable={rerunnable}
              onRerun={(id) => void run("", id)}
              previewContext={previewContext}
            />
          </SettingsColumn>
        )}
        {doc && (
          <Splitter
            axis="x"
            grow={-1}
            value={panels.sizes.run}
            onResize={(px) => panels.setSize("run", px)}
            onReset={() => panels.resetSize("run")}
            label="Resize the run panel"
            className="splitter-run"
          />
        )}
        <RunPanel
          tab={panelTab}
          onTab={setPanelTab}
          badges={{
            chat: running ? <span className="pulse-dot" aria-hidden="true" /> : null,
            tests: testRun?.status === "running" ? <span className="pulse-dot" aria-hidden="true" /> : null,
          }}
          // Tests has its own Run buttons, for test cases — a message box
          // there would put two different "runs" side by side. Esc still
          // stops a chat run from there.
          footerHidden={panelTab === "tests"}
          footer={
            <Composer
              ref={composer}
              running={running}
              saveFirst={doc?.dirty ?? false}
              disabledReason={runDisabled}
              onSubmit={(prompt) => void run(prompt)}
              onStop={() => stopRun.current?.abort()}
            />
          }
        >
          {panelTab === "tests" ? (
            doc ? (
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
            ) : (
              <div className="empty-state">{loadError ?? "loading…"}</div>
            )
          ) : (
            <Chat
              turns={turns}
              running={running}
              pendingAnswer={pendingAnswer}
              openTraces={openTraces}
              onOpenTraces={setOpenTraces}
              outputNodeIds={outputIds}
              onSelectNode={(nodeId) => setSelection({ kind: "node", id: nodeId })}
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
          )}
        </RunPanel>
      </div>
```

Run: `grep -n "SidePanel\|\"settings\"\|openPipelineSettings" src/App.tsx`
Expected: only `panels.setSize("settings", px)` and `panels.resetSize("settings")`.

- [ ] **Step 10: Update `web/src/style.css`**

Replace the workspace rule:

```css
.workspace {
  position: relative; /* anchors the panel splitter */
  grid-row: 3;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--run-w);
  min-height: 0;
}
```

with:

```css
.workspace {
  position: relative; /* anchors the splitters and the floating settings column */
  grid-row: 3;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--run-w);
  min-height: 0;
}
.workspace.settings-docked { grid-template-columns: minmax(0, 1fr) var(--settings-w) var(--run-w); }

/* ---------- The settings column (editor/SettingsColumn.tsx) ---------- */
.settings-column {
  border-left: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.settings-column > .inspector { flex: 1; }
/* Floating: over the canvas's right edge, beside the run panel; the canvas
   keeps its width underneath (see ui/panelSizes.ts). */
.settings-column.floating {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--run-w);
  width: var(--settings-w);
  z-index: 15;
  box-shadow: -8px 0 24px var(--shadow-strong);
}
.settings-column-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 6px 16px;
  border-bottom: 1px solid var(--border);
}
```

Replace the comment line `/* ---------- The side panel: tabs, their content, the message box ---------- */` with `/* ---------- The run panel: Chat and Tests, the message box ---------- */`, and in the rule under it replace `.side-panel {` with `.run-panel {`.

Replace `.inspector-title .kicker { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }` with `.settings-column-head .kicker { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }`.

After `.splitter-run { right: calc(var(--run-w) - 4px); }`, add:

```css
.splitter-settings { right: calc(var(--run-w) + var(--settings-w) - 4px); }
```

In the `@media (max-width: 960px)` block, replace:

```css
  .side-panel { border-left: none; border-top: 1px solid var(--border); height: 80vh; }
```

with:

```css
  .run-panel { border-left: none; border-top: 1px solid var(--border); height: 80vh; }
  .settings-column { border-left: none; border-top: 1px solid var(--border); max-height: 80vh; }
```

Run: `grep -n "side-panel" src/style.css`
Expected: no output.

- [ ] **Step 11: Update `web/README.md`**

In the file tree, after `    │   ├── Section.tsx         # foldable settings sections, remembered open or closed`, add:

```
    │   ├── SettingsColumn.tsx  # the settings column: header (path, ✕) around the Inspector
```

and replace:

```
        ├── SidePanel.tsx       # the one panel beside the canvas: tabs + message box
```

with:

```
        ├── RunPanel.tsx        # Chat and Tests tabs + the message box
```

Replace the whole **Layout** paragraph (from `**Layout**: the canvas fills the window, and **one panel** beside it holds` through `canvas and the message box stays at the bottom of the screen as you scroll.`) with:

```
**Layout**: the canvas, then the **settings column**, then the **run
panel**. Selecting a node or dependency opens its settings in the column;
**⚙** beside the pipeline picker opens (and closes) the pipeline's, and ✕
closes the column to give the canvas its width back. The run panel has
**Chat** (the conversation, with each run's trace) and **Tests**; the
message box sits under Chat, so you can edit a node and send a message
without anything switching views. Drag a column's edge to resize it
(double-click resets; the widths you choose are remembered — a narrower
window only shows them narrower for as long as it's narrow). When docking
the settings column would leave the canvas under 480px, it floats over the
canvas's right edge instead; on a narrow screen (960px or less) everything
stacks — canvas, settings, run panel — and the message box stays at the
bottom of the screen as you scroll.
```

Replace `- **Configure a node** in **Settings**, in sections that fold — each` with `- **Configure a node** in the **settings column**, in sections that fold — each`.

Replace `  invalid node is outlined on the canvas and its Settings show the` with `  invalid node is outlined on the canvas and its settings show the`.

Replace:

```
- **Pipeline settings** (**⚙** beside the pipeline picker, the pipeline's
  name at the top of a node's settings, or click empty canvas while on
  Settings): description, output node(s),
```

with:

```
- **Pipeline settings** (**⚙** beside the pipeline picker, the pipeline's
  name at the top of the settings column, or click empty canvas while the
  column is open): description, output node(s),
```

Replace `**Tests** (a tab in the panel): the pipeline's test cases — a message` with `**Tests** (a tab in the run panel): the pipeline's test cases — a message`.

- [ ] **Step 12: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

- [ ] **Step 13: Commit**

```bash
git add -A web/src web/README.md web/test/settingsSubject.test.ts
git commit -m "$(printf 'feat(web): settings column beside the run panel\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 6: Keep the selected node in sight

**Files:**
- Create: `web/src/editor/revealNode.ts`
- Modify: `web/src/editor/PipelineCanvas.tsx`
- Modify: `web/src/App.tsx` (one prop)
- Modify: `web/README.md`
- Test: `web/test/revealNode.test.ts`

**Interfaces:**
- Produces (in `web/src/editor/revealNode.ts`):
  - `interface FlowRect { x: number; y: number; width: number; height: number }`
  - `interface Viewport { x: number; y: number; zoom: number }`
  - `needsReveal(node: FlowRect, viewport: Viewport, visible: { width: number; height: number }): boolean`
  - `revealCenter(node: FlowRect, zoom: number, coveredRight: number): { x: number; y: number }`
- Adds to `PipelineCanvasProps`: `coveredRight: number`.
- Consumes: `panels.placement`, `panels.sizes.settings` (Task 1); `settingsShown` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `web/test/revealNode.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { needsReveal, revealCenter } from "../src/editor/revealNode";

// Its center is at (200, 140) in flow coordinates.
const node = { x: 100, y: 100, width: 200, height: 80 };
const screen = { width: 800, height: 600 };

describe("needsReveal", () => {
  it("leaves a node alone whose center can be seen", () => {
    assert.equal(needsReveal(node, { x: 0, y: 0, zoom: 1 }, screen), false);
  });

  it("reveals a node the narrower canvas pushed off its right edge", () => {
    assert.equal(needsReveal(node, { x: 0, y: 0, zoom: 1 }, { width: 150, height: 600 }), true);
  });

  it("counts a node under the floating settings column as hidden", () => {
    // 800px canvas, 380px of it covered: its center, at 500px, is under the column.
    assert.equal(needsReveal(node, { x: 300, y: 0, zoom: 1 }, { width: 800 - 380, height: 600 }), true);
  });

  it("applies the pan and zoom", () => {
    assert.equal(needsReveal(node, { x: -500, y: 0, zoom: 2 }, screen), true, "center at -100px");
    assert.equal(needsReveal(node, { x: -300, y: 0, zoom: 2 }, screen), false, "center at 100px");
    assert.equal(needsReveal(node, { x: 0, y: -200, zoom: 1 }, screen), true, "center above the top");
  });
});

describe("revealCenter", () => {
  it("centers the node in the canvas when nothing covers it", () => {
    assert.deepEqual(revealCenter(node, 1, 0), { x: 200, y: 140 });
  });

  it("shifts it into the middle of the uncovered part", () => {
    assert.deepEqual(revealCenter(node, 1, 380), { x: 390, y: 140 });
    assert.deepEqual(revealCenter(node, 2, 380), { x: 295, y: 140 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/revealNode.test.ts`
Expected: FAIL — cannot find module `../src/editor/revealNode`.

- [ ] **Step 3: Write `web/src/editor/revealNode.ts`**

```ts
/** A node's box, in flow coordinates. */
export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** React Flow's viewport: where the flow's origin is on screen, and the zoom. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Whether a node's center is outside the part of the canvas that can be
 * seen — the canvas less what covers its right edge (the floating settings
 * column). Only then is it panned into view: a node that's merely cut off
 * at an edge is left where the user put it. */
export function needsReveal(node: FlowRect, viewport: Viewport, visible: { width: number; height: number }): boolean {
  const x = (node.x + node.width / 2) * viewport.zoom + viewport.x;
  const y = (node.y + node.height / 2) * viewport.zoom + viewport.y;
  return x < 0 || y < 0 || x > visible.width || y > visible.height;
}

/** The flow point to hand React Flow's setCenter so the node lands in the
 * middle of the uncovered part of the canvas. setCenter centers a point
 * in the whole canvas; `coveredRight` screen pixels are hidden on the
 * right, so the point is moved right by half of that, in flow units. */
export function revealCenter(node: FlowRect, zoom: number, coveredRight: number): { x: number; y: number } {
  return { x: node.x + node.width / 2 + coveredRight / 2 / zoom, y: node.y + node.height / 2 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/revealNode.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Use it in `web/src/editor/PipelineCanvas.tsx`**

After `import { canvasHint } from "./canvasHint";`, add `import { needsReveal, revealCenter } from "./revealNode";`.

In `PipelineCanvasProps`, after the `topLeft?: ReactNode;` line, add:

```ts
  /** How much of the canvas's right edge is covered — by the floating
   * settings column — so the selected node is kept out from under it. */
  coveredRight: number;
```

In `CanvasInner`, replace `  const { editable, selectedNodeId, selectedEdgeId, textScale } = props;` with `  const { editable, selectedNodeId, selectedEdgeId, textScale, coveredRight } = props;`.

After the effect that re-fits on a new text size (the one ending `}, [textScale, fit, flow]);`), add:

```tsx
  // The canvas's size, to notice it narrowing — the settings column docking.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keeps the selected node in sight when the canvas narrows or the floating
  // settings column covers it — e.g. right after selecting it opens the
  // column. Pans only; the zoom stays. A pan the user makes afterwards is
  // left alone: this runs when the selection, the size or the cover changes.
  useEffect(() => {
    if (!selectedNodeId || !size) return;
    const node = flow.getInternalNode(selectedNodeId);
    if (!node) return;
    const rect = {
      x: node.internals.positionAbsolute.x,
      y: node.internals.positionAbsolute.y,
      width: node.measured.width ?? 0,
      height: node.measured.height ?? 0,
    };
    const viewport = flow.getViewport();
    if (!needsReveal(rect, viewport, { width: size.width - coveredRight, height: size.height })) return;
    const center = revealCenter(rect, viewport.zoom, coveredRight);
    void flow.setCenter(center.x, center.y, { zoom: viewport.zoom, duration: 200 });
  }, [flow, selectedNodeId, size, coveredRight]);
```

- [ ] **Step 6: Pass the cover from `web/src/App.tsx`**

In the `<PipelineCanvas` element, after `              fitSignal={fitSignal}`, add:

```tsx
              coveredRight={settingsShown && panels.placement === "floating" ? panels.sizes.settings : 0}
```

- [ ] **Step 7: Update `web/README.md`**

In the file tree, after `    │   ├── canvasHint.ts       # the hint across the top while nothing is connected yet`, add:

```
    │   ├── revealNode.ts       # keeping the selected node in sight beside the settings column
```

In the **Layout** paragraph, replace `canvas's right edge instead; on a narrow screen (960px or less) everything` with `canvas's right edge instead (either way, a selected node it would hide is panned into view); on a narrow screen (960px or less) everything`.

- [ ] **Step 8: Run the gate**

Run: `npm run typecheck && npm test`
Expected: no type errors; `fail 0`.

- [ ] **Step 9: Commit**

```bash
git add web/src/editor/revealNode.ts web/src/editor/PipelineCanvas.tsx web/src/App.tsx web/README.md web/test/revealNode.test.ts
git commit -m "$(printf 'feat(web): keep the selected node in sight beside the settings column\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 7: Check it in the browser

**Files:**
- Modify: whatever the checks show is wrong (then re-run the gate and commit the fix).

**Interfaces:**
- Consumes: everything above. The dev servers are defined in `.claude/launch.json`: `pipeline-api` (port 8000, editing enabled) and `web-dev` (port 5173).

- [ ] **Step 1: Full gate, including the production build**

Run (from `web/`): `npm run typecheck && npm test && npm run build`
Expected: no type errors; `fail 0`; Vite prints `✓ built in …`.

- [ ] **Step 2: Start the servers**

Start `pipeline-api`, then `web-dev` (with the browser pane's `preview_start`, by name). Open `http://localhost:5173`. Check the console and the API log for errors.

- [ ] **Step 3: 1366×768 (laptop, docked)**

Resize the window to 1366×768. Check:
- Nothing selected: the canvas and the run panel (**Chat** | **Tests**) only; no Trace, Add or Settings tabs; **+ Add node** is in the canvas's top-left corner.
- Click a node: the settings column opens between the canvas and the run panel (docked, the canvas keeps ≈566px); its header reads `<pipeline> › node`; Chat is still showing.
- Its **Trace** section is first; folded it says `hasn't run yet` (or `run N · …`).
- Click empty canvas: the column shows the pipeline (header `pipeline`), and stays open. The gear is pressed; click it: the column closes. Click it again: it opens on the pipeline's settings.
- In a node's settings, click the pipeline name in the header: the pipeline's settings.
- Delete the selected node with Backspace, then undo (⌘Z): nothing shows "› node" over the pipeline's settings in between.
- Drag each splitter; double-click each to reset; reload: the widths are remembered.

- [ ] **Step 4: The four pairings**

With a node's settings open:
- **Settings + Chat**: change its prompt and send a message. Settings stay; the answer appears in Chat (the button says **Save & send** while unsaved).
- **Chat + Trace**: the turn shows **Trace · N nodes**; open it: each node's received/replied. Tick **open traces**: new runs start with the trace open; fold one — it stays folded. Click a node name in a trace: that node's settings show; Chat stays.
- **Node settings + its trace**: open the Trace section: height-capped, scrolls on its own, the Model section stays reachable below it. It streams live during a run (only if Ollama is running — otherwise note it as not verified).
- **Tests + settings**: switch to Tests, click a node: the column opens beside Tests; Tests stays showing, and the message box stays hidden.

- [ ] **Step 5: Scrolling (Review Focus 4)**

With several turns in Chat, scroll up to read an earlier trace, then send a message from the box (or re-run from a node): while you stay scrolled up, the transcript doesn't jump; after sending a new message it shows the end. (With Ollama down, the failed run still adds a turn — enough to check the jump on send.)

- [ ] **Step 6: + Add node (Review Focus 5)**

- Click **+ Add node**: the popover opens. Click "LLM node": a node is added (below the selected one) and the popover closes.
- Open it again and drag "LLM node" onto the canvas: a node is added where dropped and the popover closes.
- Open it and start dragging an item, then press Esc mid-drag (or drop it back on the popover): nothing is added and the popover stays open.
- Open it and press Esc: only the popover closes. Start a run (Send), open the popover, press Esc: the popover closes and the run keeps going; press Esc again: the run stops.
- Scroll the mouse wheel over the popover: the canvas doesn't zoom.
- With a pipeline of one node, the hint reads "Add more nodes with + Add node — …" and doesn't overlap the button.

- [ ] **Step 7: 1100×800 (floating)**

Resize to 1100×800 and select a node: the column floats over the canvas's right edge with a shadow; the canvas keeps its full width underneath; the run panel keeps its column. Select a node near the canvas's right side: after the column opens, the canvas pans it clear (Review Focus 2).

- [ ] **Step 8: 1920×1080 (docked, roomy) and 768×1024 (stacked)**

- 1920: docked; everything fits with room for the canvas.
- 768: canvas, then the settings column (when open), then the run panel, stacked; the splitters are hidden; the message box sticks to the bottom of the screen while the run panel is in view.

- [ ] **Step 9: Light and dark**

Switch the theme (**Aa**) at 1366×768: the column header, the floating shadow, the Trace summary and the popover read clearly in both.

- [ ] **Step 10: Fix, re-check, commit**

For anything that failed: fix it in the file that owns it, run `npm run typecheck && npm test`, repeat the failed check, then commit:

```bash
git add -A web
git commit -m "$(printf 'fix(web): <what the browser check found>\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

If nothing failed, there is nothing to commit. Report which checks passed, and which couldn't be run (e.g. live streaming without Ollama).
