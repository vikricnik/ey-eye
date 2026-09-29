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
