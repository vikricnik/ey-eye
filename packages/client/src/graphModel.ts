import type {
  AskStreamEvent,
  BranchRouteOutcome,
  GraphEdge,
  GraphModel,
  GraphNode,
  GraphViewState,
  NodeExecutionStatus,
  PipelineDetail,
} from "./types.js";
import type { PipelineApiError } from "./apiClient.js";

/** The literal sentinel a loop's `exit_to` uses to mean "terminate the
 * graph directly" rather than naming another node — mirrors the server's
 * dag_builder/loops.py END_SENTINEL. Not a real node id: renderers must
 * treat an edge targeting this as a terminal marker, not a node lookup. */
export const LOOP_EXIT_END = "END";

/**
 * Builds the classified, layered GraphModel a pipeline's structure
 * renders as, from the same PipelineDetail the CLI and web clients already
 * fetch via GET /pipelines/{name}. Pure function: same input always
 * produces the same output. Shared by cli/src/graphRenderer.ts and
 * web/src/graphView.ts so both surfaces render identical structure
 * (SC-005) — see specs/001-visual-dag-graph/data-model.md and
 * contracts/graph-model.md for the full field-by-field rationale.
 */
export function buildGraphModel(detail: PipelineDetail): GraphModel {
  // Nodes whose ENTIRE outgoing routing is governed by a branch or loop —
  // mirrors pipeline_config/schema.py's `conditional_sources` property.
  // No plain depends_on-based edge may originate from one of these; their
  // outgoing edges are exclusively the branch/loop edges built below.
  const conditionalSources = new Set<string>([
    ...detail.branches.map((b) => b.from),
    ...detail.loops.map((l) => l.from),
  ]);

  // Node ids that are a branch route target — excluded from being
  // automatic layout roots even when depends_on is empty, mirroring
  // pipeline_config/schema.py's `effective_root_ids` (a branch target must
  // never look like it always runs).
  const branchTargets = new Set<string>(
    detail.branches.flatMap((b) => b.routes.map((r) => r.to))
  );

  const nodesById = new Map(detail.nodes.map((n) => [n.id, n]));

  // Predecessors used for LAYOUT LEVEL only — plain depends_on edges (minus
  // any pointing at a conditional source, which carry no real level
  // information since that source's own position is decided by the
  // branch/loop, not a plain chain) plus each branch route's `from` node
  // (a branch target has depends_on: [] but still has a real predecessor:
  // the branch's source node). Deliberately excludes loop `back_to`/
  // `exit_to` — those are backward/overlay edges on an already-leveled
  // DAG; including them would create a cycle in the level computation
  // itself (see research.md §... loop back_to is not a forward dependency).
  function layoutPredecessors(nodeId: string): string[] {
    const node = nodesById.get(nodeId);
    const preds = (node?.depends_on ?? []).filter((dep) => !conditionalSources.has(dep));
    for (const branch of detail.branches) {
      if (branch.routes.some((r) => r.to === nodeId)) {
        preds.push(branch.from);
      }
    }
    return preds;
  }

  const levels = new Map<string, number>();
  const computing = new Set<string>(); // cycle guard — the leveling graph should be acyclic

  function levelOf(nodeId: string): number {
    const cached = levels.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodesById.get(nodeId);
    const isEffectiveRoot =
      node !== undefined && node.depends_on.length === 0 && !branchTargets.has(nodeId);

    if (isEffectiveRoot) {
      levels.set(nodeId, 0);
      return 0;
    }

    if (computing.has(nodeId)) {
      // Defensive only — layoutPredecessors() never includes a back edge,
      // so this should be unreachable for any pipeline that passed server
      // validation. Treat as a root rather than recursing forever.
      levels.set(nodeId, 0);
      return 0;
    }
    computing.add(nodeId);

    const preds = layoutPredecessors(nodeId);
    const level = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(levelOf));

    computing.delete(nodeId);
    levels.set(nodeId, level);
    return level;
  }

  const outputCandidates = new Set(detail.output_node_candidates);

  const nodes: GraphNode[] = detail.nodes.map((n) => ({
    id: n.id,
    model: n.model,
    level: levelOf(n.id),
    isOutputCandidate: outputCandidates.has(n.id),
  }));

  const edges: GraphEdge[] = [];

  for (const node of detail.nodes) {
    for (const dep of node.depends_on) {
      if (conditionalSources.has(dep)) continue; // that edge belongs to the branch/loop below instead
      edges.push({
        from: dep,
        to: node.id,
        kind: "plain",
        label: null,
        branchId: null,
        isDefaultRoute: false,
        loopId: null,
        loopMaxIterations: null,
      });
    }
  }

  for (const branch of detail.branches) {
    for (const route of branch.routes) {
      edges.push({
        from: branch.from,
        to: route.to,
        kind: "branch",
        label: route.default ? "default" : route.when,
        branchId: branch.id,
        isDefaultRoute: route.default,
        loopId: null,
        loopMaxIterations: null,
      });
    }
  }

  for (const loop of detail.loops) {
    edges.push({
      from: loop.from,
      to: loop.back_to,
      kind: "loop-continue",
      label: `${loop.id} (max ${loop.max_iterations})`,
      branchId: null,
      isDefaultRoute: false,
      loopId: loop.id,
      loopMaxIterations: loop.max_iterations,
    });
    // exit_to may be the literal "END" sentinel (terminate the graph, no
    // real destination node) rather than another node id — the edge is
    // still emitted so renderers can draw a terminal marker; LOOP_EXIT_END
    // is not present in `nodes`, so a renderer must special-case it rather
    // than look up a node box for it.
    edges.push({
      from: loop.from,
      to: loop.exit_to,
      kind: "loop-exit",
      label: `${loop.id} exit (max ${loop.max_iterations})`,
      branchId: null,
      isDefaultRoute: false,
      loopId: loop.id,
      loopMaxIterations: loop.max_iterations,
    });
  }

  return { pipelineName: detail.name, nodes, edges };
}

// ---------------------------------------------------------------------------
// Live view state — folds AskStreamEvents/errors on top of a GraphModel.
// See data-model.md's "Node Execution Status" and research.md §5 for why
// "running" is inferred client-side from the known DAG shape rather than
// pushed by a dedicated server event.
// ---------------------------------------------------------------------------

/** A node's structural predecessors for RUNNING-inference purposes —
 * deliberately different from buildGraphModel's layout predecessors: a
 * branch target's only real predecessor is the branch's single source
 * (we can't know which route fires until one of them completes, so every
 * target becomes eligible once the source is done); loop back_to/exit_to
 * targets are excluded for the same reason they're excluded from layout
 * (they're not forward dependencies). */
function structuralPredecessors(graph: GraphModel, nodeId: string): string[] {
  const branchPreds = graph.edges
    .filter((e) => e.kind === "branch" && e.to === nodeId)
    .map((e) => e.from);
  if (branchPreds.length > 0) return [...new Set(branchPreds)];

  return graph.edges.filter((e) => e.kind === "plain" && e.to === nodeId).map((e) => e.from);
}

/** True once a node is KNOWN to never run this turn — it's the target of
 * a branch route that already resolved to a different sibling. Without
 * this check, activateEligibleNodes would immediately re-promote a
 * just-reset "not taken" sibling right back to `running`, since its only
 * structural predecessor (the branch's source) is still `complete` — the
 * branch outcome, not just predecessor completion, has to gate it. */
function isDeadBranchTarget(
  graph: GraphModel,
  branchOutcomes: Record<string, BranchRouteOutcome>,
  nodeId: string
): boolean {
  return graph.edges.some((e) => {
    if (e.kind !== "branch" || e.to !== nodeId || e.branchId === null) return false;
    const outcome = branchOutcomes[e.branchId];
    return outcome !== undefined && outcome.takenTo !== nodeId;
  });
}

/** Promotes every `not-started` node whose structural predecessors are
 * all `complete` to `running` — a root node (no predecessors) becomes
 * eligible immediately. Skips a branch target already known dead (see
 * `isDeadBranchTarget`), leaving it `not-started` permanently rather than
 * flipping it back to `running`. Returns the same object reference when
 * nothing changed, so callers can cheaply skip a re-render. */
function activateEligibleNodes(
  graph: GraphModel,
  nodeStatus: Record<string, NodeExecutionStatus>,
  branchOutcomes: Record<string, BranchRouteOutcome>
): Record<string, NodeExecutionStatus> {
  let next = nodeStatus;
  for (const node of graph.nodes) {
    if (nodeStatus[node.id] !== "not-started") continue;
    if (isDeadBranchTarget(graph, branchOutcomes, node.id)) continue;
    const preds = structuralPredecessors(graph, node.id);
    if (preds.every((p) => nodeStatus[p] === "complete")) {
      if (next === nodeStatus) next = { ...nodeStatus };
      next[node.id] = "running";
    }
  }
  return next;
}

/**
 * Creates a fresh GraphViewState for `graph` — every node `not-started`,
 * no branch outcomes, no loop progress, no connection error. Used both
 * for the static view (pipeline just selected, no run yet) and, via
 * `opts.running`, the moment a new run actually starts: passing
 * `{ running: true }` immediately promotes every root node (no
 * predecessors) to `running`, since a root starts executing the instant
 * the request is sent — there's no `node_complete` event to mark that
 * moment otherwise. Call this on every pipeline switch and on every new
 * prompt (FR-013) so stale status never lingers.
 */
export function createGraphViewState(
  graph: GraphModel,
  opts: { running?: boolean } = {}
): GraphViewState {
  let nodeStatus: Record<string, NodeExecutionStatus> = {};
  for (const node of graph.nodes) nodeStatus[node.id] = "not-started";
  if (opts.running) {
    nodeStatus = activateEligibleNodes(graph, nodeStatus, {});
  }
  return {
    graph,
    nodeStatus,
    branchOutcomes: {},
    loopProgress: {},
    connectionError: null,
  };
}

/**
 * Folds one AskStreamEvent into `state`, returning a new state (does not
 * mutate). `node_complete` marks that node complete, records the taken
 * route if it's a branch target (resetting sibling routes back to
 * `not-started` rather than leaving them stuck at `running` forever), and
 * promotes newly-eligible nodes to `running`. `loop_iteration` updates
 * that loop's progress. `done` is a no-op here — every node it could tell
 * us about already reached `complete` via its own `node_complete` event;
 * it exists so callers can route every event through this one function
 * uniformly (see contracts/graph-model.md).
 */
export function applyStreamEvent(state: GraphViewState, event: AskStreamEvent): GraphViewState {
  if (event.type === "node_complete") {
    const nodeId = event.data.node.node_id;
    let nodeStatus: Record<string, NodeExecutionStatus> = {
      ...state.nodeStatus,
      [nodeId]: "complete",
    };
    let branchOutcomes = state.branchOutcomes;

    const takenBranchEdges = state.graph.edges.filter(
      (e) => e.kind === "branch" && e.to === nodeId && e.branchId !== null
    );
    for (const edge of takenBranchEdges) {
      const branchId = edge.branchId!;
      branchOutcomes = { ...branchOutcomes, [branchId]: { branchId, takenTo: nodeId } };

      const siblings = state.graph.edges.filter(
        (e) => e.kind === "branch" && e.branchId === branchId && e.to !== nodeId
      );
      for (const sibling of siblings) {
        if (nodeStatus[sibling.to] !== "complete") {
          nodeStatus = { ...nodeStatus, [sibling.to]: "not-started" };
        }
      }
    }

    nodeStatus = activateEligibleNodes(state.graph, nodeStatus, branchOutcomes);
    return { ...state, nodeStatus, branchOutcomes };
  }

  if (event.type === "loop_iteration") {
    const { loop_id, iteration } = event.data;
    const edge = state.graph.edges.find((e) => e.loopId === loop_id && e.loopMaxIterations !== null);
    const maxIterations = edge?.loopMaxIterations ?? iteration;
    return {
      ...state,
      loopProgress: {
        ...state.loopProgress,
        [loop_id]: { loopId: loop_id, iteration, maxIterations, exhausted: false },
      },
    };
  }

  return state; // "done" — nothing left to fold; see doc comment above
}

/**
 * Folds a run-ending error into `state`: sets `connectionError` to a
 * user-facing message, and — when the error's `details` identify a
 * specific node or loop (see contracts/pipeline-detail-api.md) — marks
 * that node `failed` or that loop `exhausted`, without touching any other
 * node's last-known status (FR-015: nodes stay visible at their last
 * known state, none are cleared).
 */
export function applyStreamError(state: GraphViewState, error: PipelineApiError): GraphViewState {
  const nodeId = typeof error.details?.node_id === "string" ? error.details.node_id : undefined;
  const loopId = typeof error.details?.loop_id === "string" ? error.details.loop_id : undefined;

  let nodeStatus = state.nodeStatus;
  let loopProgress = state.loopProgress;

  if (nodeId !== undefined && nodeId in state.nodeStatus) {
    nodeStatus = { ...nodeStatus, [nodeId]: "failed" };
  }

  if (loopId !== undefined) {
    const existing = state.loopProgress[loopId];
    const edge = state.graph.edges.find((e) => e.loopId === loopId && e.loopMaxIterations !== null);
    const maxIterations = existing?.maxIterations ?? edge?.loopMaxIterations ?? 0;
    loopProgress = {
      ...loopProgress,
      [loopId]: {
        loopId,
        iteration: existing?.iteration ?? maxIterations,
        maxIterations,
        exhausted: true,
      },
    };
  }

  return { ...state, nodeStatus, loopProgress, connectionError: error.message };
}
