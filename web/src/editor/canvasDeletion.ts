import { disconnect, removeNode } from "@llm-pipeline/client";
import type { PipelineDefinition } from "@llm-pipeline/client";

/** What a Backspace/Delete on the canvas removes: the selected nodes, and
 * the dependency edges — selected ones, and those of the deleted nodes,
 * which React Flow deletes along with them. */
export interface CanvasDeletion {
  nodeIds: string[];
  dependencies: { from: string; to: string }[];
}

const hasNode = (def: PipelineDefinition, id: string) => def.nodes.some((n) => n.id === id);

/** The whole deletion as one change — so it is one undo step, and undoing
 * it brings a node back with its connections. */
export function applyCanvasDeletion(def: PipelineDefinition, deletion: CanvasDeletion): PipelineDefinition {
  const withoutEdges = deletion.dependencies.reduce(
    (acc, { from, to }) => (hasNode(acc, from) && hasNode(acc, to) ? disconnect(acc, from, to) : acc),
    def
  );
  return deletion.nodeIds.reduce((acc, id) => (hasNode(acc, id) ? removeNode(acc, id) : acc), withoutEdges);
}

/** "Deleted node "b"" — the notice that offers to undo it. */
export function deletionSummary({ nodeIds, dependencies }: CanvasDeletion): string {
  if (nodeIds.length === 1) return `Deleted node "${nodeIds[0]}"`;
  if (nodeIds.length > 1) return `Deleted ${nodeIds.length} nodes`;
  if (dependencies.length === 1) return `Removed the dependency ${dependencies[0]!.from} → ${dependencies[0]!.to}`;
  return `Removed ${dependencies.length} dependencies`;
}
