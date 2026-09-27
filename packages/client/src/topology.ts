import type { PipelineDetail } from "./types.js";
import { routeTargets } from "./types.js";

// Who runs after whom — the editor's copy of the server's rules
// (llm_pipeline/pipeline_config/topology.py). Both are pinned by
// contracts/topology-cases.json: change one, the other's test fails.

/** The `exit_to` that ends the run instead of naming a node — the server's
 * END_SENTINEL (pipeline_config/schema.py). Not a node id: renderers treat
 * an edge targeting it as a terminal marker, not a node lookup. */
export const LOOP_EXIT_END = "END";

/** Nodes whose outgoing edges belong entirely to a branch or loop. */
export function conditionalSources(detail: PipelineDetail): ReadonlySet<string> {
  return new Set([...detail.branches.map((b) => b.from), ...detail.loops.map((l) => l.from)]);
}

/** Nodes some branch route starts. */
export function branchTargets(detail: PipelineDetail): ReadonlySet<string> {
  return new Set(detail.branches.flatMap((b) => b.routes.flatMap(routeTargets)));
}

/** Nodes that start as soon as the run does: no dependencies, and not
 * waiting for a branch to route to them. In definition order, like the
 * server's effective_roots. */
export function effectiveRoots(detail: PipelineDetail): readonly string[] {
  const targets = branchTargets(detail);
  return detail.nodes.filter((n) => n.depends_on.length === 0 && !targets.has(n.id)).map((n) => n.id);
}
