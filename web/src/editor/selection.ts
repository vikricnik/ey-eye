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
