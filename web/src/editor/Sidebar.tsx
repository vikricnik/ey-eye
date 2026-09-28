import { useState } from "react";
import type { NodePreset } from "@llm-pipeline/client";
import { NODE_DRAG_TYPE } from "./PipelineCanvas";

function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Everything a preset carries, for its tooltip. */
function summary(p: NodePreset): string {
  return [
    `${p.model.provider}:${p.model.model}${p.model.temperature !== undefined ? ` · temperature ${p.model.temperature}` : ""}`,
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
export function Sidebar(props: {
  editable: boolean;
  presets: NodePreset[];
  onAdd: (presetName: string | undefined) => void;
  onDeletePreset: (name: string) => void;
}) {
  const { editable, presets, onAdd, onDeletePreset } = props;
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shown = query
    ? presets.filter((p) =>
        [p.name, p.description, p.model.model, p.system_prompt, p.prompt_template].some((t) =>
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
    <nav className="sidebar" aria-label="Node palette">
      <h3>Add</h3>
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
                p.description || `${p.model.provider}:${p.model.model}`,
                p,
                [
                  p.description ? p.model.model : null,
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
      <h3>Legend</h3>
      <ul className="legend">
        <li><span className="swatch status-running" /> running</li>
        <li><span className="swatch status-complete" /> done</li>
        <li><span className="swatch status-failed" /> failed</li>
        <li><span className="line plain" /> depends on</li>
        <li><span className="line branch" /> branch route</li>
        <li><span className="line loop" /> loop</li>
      </ul>
    </nav>
  );
}
