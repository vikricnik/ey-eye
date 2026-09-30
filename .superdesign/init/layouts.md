# Layouts — ey-eye web client

Single-page app: one screen. The shell is rendered by `App.tsx`:

```
.app (grid rows: top bar · notices · workspace)
├── header.topbar — title block ("LLM Pipeline", server URL, API/Ollama lights) · toolbar (pipeline <select>, ⚙ pipeline settings, ● unsaved dot, status chip, ↶ ↷, Save, File ▾ menu, Aa display)
├── .notices — info/error notices (with Undo), Ollama outage, read-only notice
└── .workspace (grid columns: canvas | settings column | run panel; settings column docked, floating over the canvas, or stacked ≤960px)
    ├── main.canvas-wrap — PipelineCanvas (React Flow): + Add node (top-left), ? legend (top-right), controls (bottom-left), minimap (bottom-right)
    ├── Splitter (settings width)
    ├── aside.settings-column — header (breadcrumb `pipeline › node` + ✕) + Inspector (node / dependency / pipeline settings in foldable Sections)
    ├── Splitter (run panel width)
    └── aside.run-panel — tabs Chat | Tests · body · footer (message box, hidden on Tests)
```

Default widths: settings column 380px, run panel 420px (resizable, remembered). The canvas takes the rest.

## App shell render (`App.tsx`)
The state and handlers above line 1086 are omitted; this is the whole JSX tree.

### `web/src/App.tsx` (lines 1086–1375)

```tsx
  return (
    <div className="app" style={panels.style}>
      <header className="topbar">
        <div className="title-block">
          <h1>LLM Pipeline</h1>
          <span className="subtitle">{BASE_URL}</span>
          <ServerStatus
            baseUrl={BASE_URL}
            online={online}
            ollama={ollama}
            readOnly={serverInfo !== null && !serverInfo.editing_enabled}
          />
        </div>
        <div className="toolbar">
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
            aria-label="Pipeline settings"
            aria-pressed={pipelineSettingsOpen}
            title="Pipeline settings: output, execution, conversation history, defaults for all nodes"
            disabled={!doc}
            onClick={togglePipelineSettings}
          >
            <GearIcon />
          </button>
          {doc?.dirty && <span className="dirty-dot" title="unsaved changes">●</span>}
          {validationChip}
          <span className="sep" />
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
          {/* Disabled, it says why — and the status chip beside it shows it too. */}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saveBlocked !== null}
            title={saveBlocked ? `Save — ${saveBlocked}` : "Save (⌘S / Ctrl+S)"}
          >
            Save
          </button>
          {/* Save stays the one filled button; the rest of the file
              actions are in this menu, with Delete last and set apart. */}
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
          <DisplayMenu settings={display.settings} onChange={display.update} />
        </div>
      </header>

      <div className="notices">
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
      </div>

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
              coveredRight={settingsShown && panels.placement === "floating" ? panels.sizes.settings : 0}
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
              onSelect={select}
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
              onSelect={select}
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
          )}
        </RunPanel>
      </div>
    </div>
  );
}
```

## Settings column

### `web/src/editor/SettingsColumn.tsx`

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

/** Selecting a node or dependency opens the column on it — each time it's
 * selected, so one that stayed selected when the column was closed opens
 * it again. Clearing the selection leaves the column as it is. */
export function opensSettings(selection: Selection | null): boolean {
  return selection?.kind === "node" || selection?.kind === "edge";
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

## Run panel

### `web/src/ui/RunPanel.tsx`

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

## Column sizing and splitters

### `web/src/ui/panelSizes.ts`

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

### `web/src/ui/Splitter.tsx`

```tsx
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

/**
 * A draggable border between two panels. `axis="x"` is a vertical bar that
 * resizes a width, `axis="y"` a horizontal bar that resizes a height.
 * `grow` says which drag direction makes the panel bigger: +1 when the
 * panel is before the bar (left/top), -1 when it is after it (right/bottom).
 * Arrow keys nudge by 16px (Shift: 64px); double-click resets.
 */
export function Splitter(props: {
  axis: "x" | "y";
  grow: 1 | -1;
  value: number;
  onResize: (px: number) => void;
  onReset: () => void;
  label: string;
  className: string;
}) {
  const { axis, grow, value, onResize } = props;
  const drag = useRef<{ start: number; startValue: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: axis === "x" ? e.clientX : e.clientY, startValue: value };
    setActive(true);
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const position = axis === "x" ? e.clientX : e.clientY;
    onResize(drag.current.startValue + (position - drag.current.start) * grow);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    document.body.classList.remove("resizing-x", "resizing-y");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const [less, more] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (e.key === less) onResize(value - step * grow);
    else if (e.key === more) onResize(value + step * grow);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={props.label}
      aria-valuenow={value}
      tabIndex={0}
      title={`${props.label} — drag to resize, double-click to reset`}
      className={`splitter splitter-${axis} ${props.className}${active ? " active" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
    />
  );
}
```

## Canvas shell (render section)

### `web/src/editor/PipelineCanvas.tsx` (lines 185–283)

```tsx
    setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), current));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), current));
  }, []);

  const onDrop = (event: DragEvent) => {
    if (!editable || !event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
    event.preventDefault();
    const preset = event.dataTransfer.getData(NODE_DRAG_TYPE);
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    props.onDropNode({ x: position.x - 100, y: position.y - 30 }, preset || undefined);
  };

  return (
    <div
      ref={canvas}
      className={`canvas${compact ? " detail-compact" : ""}${coveredRight > 0 ? " covered" : ""}`}
      // The canvas's own right-hand controls (legend, minimap) move clear of
      // the floating settings column (style.css, --covered-right).
      style={{ "--covered-right": `${coveredRight}px` } as CSSProperties}
      onDragOver={(e) => {
        if (editable && e.dataTransfer.types.includes(NODE_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={onDrop}
    >
      <CompactTextScale target={canvas} textScale={textScale} />
      <ReactFlow<LlmFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={props.colorMode}
        fitView
        fitViewOptions={fit}
        minZoom={0.2}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        isValidConnection={isValidConnection}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(c) => props.onConnect(c.source, c.target)}
        // One callback for everything a delete removes — React Flow's
        // onEdgesDelete and onNodesDelete would make it two edits, and two
        // undo steps.
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) =>
          props.onDelete({
            nodeIds: deletedNodes.map((n) => n.id),
            dependencies: deletedEdges.flatMap((e) => parseDependencyEdgeId(e.id) ?? []),
          })
        }
        onNodeDragStop={(_event, _node, dragged) =>
          props.onMoveNodes(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })))
        }
        onNodeClick={(_event, node) => props.onSelect({ kind: "node", id: node.id })}
        onEdgeClick={(_event, edge) => {
          const dep = parseDependencyEdgeId(edge.id);
          if (dep) props.onSelect({ kind: "edge", ...dep });
        }}
        onPaneClick={() => props.onSelect(null)}
      >
        <Background gap={24} size={1} />
        {/* Its fit button takes its own options — the same limits as fitting on load. */}
        <Controls showInteractive={false} fitViewOptions={fit}>
          <ControlButton
            onClick={props.onAutoLayout}
            disabled={!editable}
            title={editable ? "Auto-layout: arrange the nodes by dependency level" : "Auto-layout (editing is disabled)"}
            aria-label="Auto-layout"
          >
            <AutoLayoutIcon />
          </ControlButton>
        </Controls>
        <MiniMap pannable zoomable nodeStrokeWidth={3} style={{ width: 140, height: 90 }} />
        {props.topLeft && <Panel position="top-left">{props.topLeft}</Panel>}
        <Panel position="top-right">
          <CanvasLegend />
        </Panel>
        {hint && (
          <Panel position="top-center" className="canvas-hint">
            {hint}
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

export function PipelineCanvas(props: PipelineCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
```
