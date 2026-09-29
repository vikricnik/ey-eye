import type {
  AskStreamEvent,
  BranchEdge,
  BranchRouteOutcome,
  GraphEdge,
  GraphModel,
  GraphNode,
  GraphViewState,
  LoopEdge,
  NodeExecutionStatus,
  PipelineDefinition,
  PipelineDetail,
} from "./types.js";
import type { PipelineApiError } from "./apiClient.js";
import { effectiveModel } from "./draftOps.js";
import { conditionalSources, effectiveRoots } from "./topology.js";
import { routeTargets } from "./types.js";

/** "provider:name" a node runs with; "(default)" when it inherits the
 * pipeline's default model. */
export function displayModel(definition: PipelineDefinition, node: PipelineDefinition["nodes"][number]): string {
  const model = effectiveModel(definition, node);
  if (!model) return "(no model)";
  return `${model.provider}:${model.name}${node.model ? "" : " (default)"}`;
}

/**
 * The PipelineDetail view of a full definition — a stored pipeline's (from
 * getPipeline()) or an editor's unsaved draft, so both go through the same
 * buildGraphModel() and layout levels and live run status work identically.
 */
export function detailFromDefinition(definition: PipelineDefinition): PipelineDetail {
  return {
    name: definition.name,
    description: definition.description ?? "",
    output_nodes: definition.output_nodes,
    nodes: definition.nodes.map((n) => ({
      id: n.id,
      type: n.type ?? "llm_call",
      depends_on: n.depends_on ?? [],
      model: displayModel(definition, n),
    })),
    branches: (definition.branches ?? []).map((b) => ({
      id: b.id,
      from: b.from,
      routes: b.routes.map((r) => ({ to: r.to, when: r.when ?? null, default: r.default ?? false })),
    })),
    loops: (definition.loops ?? []).map((l) => ({
      id: l.id,
      from: l.from,
      back_to: l.back_to,
      exit_to: l.exit_to,
      max_iterations: l.max_iterations ?? 3,
      on_max_iterations: l.on_max_iterations ?? "proceed",
    })),
  };
}

/**
 * Builds the classified, layered GraphModel a pipeline's structure
 * renders as, from its PipelineDetail (see detailFromDefinition). Pure
 * function: same input always produces the same output. Shared by
 * cli/src/graphRenderer.ts and the web editor so both surfaces render
 * identical structure; the topology rules it applies live in topology.ts.
 */
export function buildGraphModel(detail: PipelineDetail): GraphModel {
  // The shared topology rules (topology.ts): no plain depends_on-based
  // edge may originate from a conditional source — its outgoing edges are
  // exclusively the branch/loop edges built below — and a branch target
  // never looks like it always runs, even with empty depends_on.
  const conditional = conditionalSources(detail);
  const roots = new Set(effectiveRoots(detail));

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
    const preds = (node?.depends_on ?? []).filter((dep) => !conditional.has(dep));
    for (const branch of detail.branches) {
      if (branch.routes.some((r) => routeTargets(r).includes(nodeId))) {
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

    if (roots.has(nodeId)) {
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

  const outputCandidates = new Set(detail.output_nodes);

  const nodes: GraphNode[] = detail.nodes.map((n) => ({
    id: n.id,
    model: n.model,
    level: levelOf(n.id),
    isOutputCandidate: outputCandidates.has(n.id),
  }));

  const edges: GraphEdge[] = [];

  for (const node of detail.nodes) {
    for (const dep of node.depends_on) {
      if (conditional.has(dep)) continue; // that edge belongs to the branch/loop below instead
      edges.push({ kind: "plain", from: dep, to: node.id });
    }
  }

  for (const branch of detail.branches) {
    for (const [routeIndex, route] of branch.routes.entries()) {
      for (const target of routeTargets(route)) {
        edges.push({
          kind: "branch",
          from: branch.from,
          to: target,
          branchId: branch.id,
          routeIndex,
          isDefaultRoute: route.default,
          label: route.default ? "default" : (route.when ?? ""),
        });
      }
    }
  }

  for (const loop of detail.loops) {
    edges.push({
      kind: "loop-continue",
      from: loop.from,
      to: loop.back_to,
      loopId: loop.id,
      maxIterations: loop.max_iterations,
      label: `${loop.id} (max ${loop.max_iterations})`,
    });
    // exit_to may be the literal "END" sentinel (terminate the graph, no
    // real destination node) rather than another node id — the edge is
    // still emitted so renderers can draw a terminal marker; LOOP_EXIT_END
    // is not present in `nodes`, so a renderer must special-case it rather
    // than look up a node box for it.
    edges.push({
      kind: "loop-exit",
      from: loop.from,
      to: loop.exit_to,
      loopId: loop.id,
      maxIterations: loop.max_iterations,
      label: `${loop.id} exit (max ${loop.max_iterations})`,
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
function branchEdges(graph: GraphModel): BranchEdge[] {
  return graph.edges.filter((e): e is BranchEdge => e.kind === "branch");
}

/** One of `loopId`'s edges — each carries the loop's max_iterations. */
function loopEdge(graph: GraphModel, loopId: string): LoopEdge | undefined {
  return graph.edges.find((e): e is LoopEdge => e.kind !== "plain" && e.kind !== "branch" && e.loopId === loopId);
}

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
  return branchEdges(graph).some((e) => {
    if (e.to !== nodeId) return false;
    const outcome = branchOutcomes[e.branchId];
    return outcome !== undefined && !outcome.takenTargets.includes(nodeId);
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
    serverReportsStarts: false,
  };
}

/**
 * Folds one AskStreamEvent into `state`, returning a new state (does not
 * mutate). `node_start` marks that node running — and switches the state
 * to trusting server-reported starts from then on (`serverReportsStarts`).
 * `node_complete` marks that node complete, records the taken
 * route if it's a branch target (resetting sibling routes back to
 * `not-started` rather than leaving them stuck at `running` forever), and
 * — only while the server hasn't reported starts itself — promotes
 * newly-eligible nodes to `running` by inference. `loop_iteration` updates
 * that loop's progress. `node_token` and `done` are no-ops here — text is
 * folded separately by appendNodeText(), and every node `done` could tell
 * us about already reached `complete` via its own `node_complete` event;
 * they pass through so callers can route every event through this one
 * function uniformly.
 */
export function applyStreamEvent(state: GraphViewState, event: AskStreamEvent): GraphViewState {
  if (event.type === "node_start") {
    const nodeId = event.data.node_id;
    if (!(nodeId in state.nodeStatus)) return { ...state, serverReportsStarts: true };
    // Anything still marked running only by inference, and not actually
    // started, goes back to not-started: from now on only real starts count.
    let nodeStatus = state.nodeStatus;
    if (!state.serverReportsStarts) {
      nodeStatus = { ...nodeStatus };
      for (const [id, status] of Object.entries(nodeStatus)) {
        if (status === "running") nodeStatus[id] = "not-started";
      }
    }
    return {
      ...state,
      serverReportsStarts: true,
      nodeStatus: { ...nodeStatus, [nodeId]: "running" },
    };
  }

  if (event.type === "node_complete") {
    const nodeId = event.data.node.node_id;
    let nodeStatus: Record<string, NodeExecutionStatus> = {
      ...state.nodeStatus,
      [nodeId]: "complete",
    };
    let branchOutcomes = state.branchOutcomes;

    const branches = branchEdges(state.graph);
    for (const edge of branches.filter((e) => e.to === nodeId)) {
      const { branchId } = edge;
      // The route this node belongs to was taken — all of its targets run.
      const takenTargets = branches
        .filter((e) => e.branchId === branchId && e.routeIndex === edge.routeIndex)
        .map((e) => e.to);
      branchOutcomes = { ...branchOutcomes, [branchId]: { branchId, takenTargets } };

      const siblings = branches.filter((e) => e.branchId === branchId && !takenTargets.includes(e.to));
      for (const sibling of siblings) {
        if (nodeStatus[sibling.to] !== "complete") {
          nodeStatus = { ...nodeStatus, [sibling.to]: "not-started" };
        }
      }
    }

    if (!state.serverReportsStarts) {
      nodeStatus = activateEligibleNodes(state.graph, nodeStatus, branchOutcomes);
    }
    return { ...state, nodeStatus, branchOutcomes };
  }

  if (event.type === "loop_iteration") {
    const { loop_id, iteration } = event.data;
    const maxIterations = loopEdge(state.graph, loop_id)?.maxIterations ?? iteration;
    return {
      ...state,
      loopProgress: {
        ...state.loopProgress,
        [loop_id]: { loopId: loop_id, iteration, maxIterations, exhausted: false },
      },
    };
  }

  return state; // "node_token" / "done" — no status change; see doc comment above
}

/**
 * Folds one event into per-node live text: `node_token` appends to that
 * node's text, `node_start` (a first start, a loop re-run, or a retry)
 * clears it, and `node_complete` replaces it with the authoritative final
 * output. Returns the same object when nothing changed. Kept separate from
 * GraphViewState because text changes far more often than status does —
 * UIs can batch it without re-deriving the graph view.
 */
export function appendNodeText(
  texts: Record<string, string>,
  event: AskStreamEvent
): Record<string, string> {
  if (event.type === "node_token") {
    const { node_id, text } = event.data;
    return { ...texts, [node_id]: (texts[node_id] ?? "") + text };
  }
  if (event.type === "node_start") {
    return { ...texts, [event.data.node_id]: "" };
  }
  if (event.type === "node_complete") {
    const { node_id, output } = event.data.node;
    return { ...texts, [node_id]: output };
  }
  return texts;
}

/**
 * The run was stopped (the user cancelled it): nodes still running go back
 * to idle — nothing failed — and everything that finished stays as it is.
 */
export function applyStreamStopped(state: GraphViewState): GraphViewState {
  const nodeStatus: Record<string, NodeExecutionStatus> = {};
  for (const [id, status] of Object.entries(state.nodeStatus)) {
    nodeStatus[id] = status === "running" ? "not-started" : status;
  }
  return { ...state, nodeStatus };
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
    const maxIterations = existing?.maxIterations ?? loopEdge(state.graph, loopId)?.maxIterations ?? 0;
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
