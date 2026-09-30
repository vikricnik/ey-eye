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
    // Escape closes the menu wherever focus is — not every browser focuses a
    // button it clicks — and only the menu: caught on window in the capture
    // phase, before App's Esc ("stop the run") hears it. An open dialog
    // (removing a preset) gets its own Escape.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div
      className="add-node-menu"
      ref={wrapper}
      // The menu sits on the canvas, which takes drops: a drag let go over
      // the menu is refused here (no preventDefault) rather than adding a
      // node underneath it.
      onDragOver={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
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
