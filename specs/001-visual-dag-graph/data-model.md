# Data Model: Visual DAG Graph Representation

This feature has no database and no persisted entities (per spec
Assumptions — no historical run playback). "Data model" here means the
in-memory shapes that flow from the server's structural/streaming API
through `packages/client/src/graphModel.ts` into each renderer. Types
below are named as they'd appear in `packages/client/src/types.ts` and
`graphModel.ts`; the corresponding wire-level API changes are in
[contracts/pipeline-detail-api.md](./contracts/pipeline-detail-api.md).

## Pipeline Graph (structural, run-independent)

Derived once per selected pipeline from `GET /pipelines/{name}`.

### GraphNode

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Node id, unique within the pipeline (FR-006) |
| `model` | `string` | `"provider:model"` identity string, or the existing non-`llm_call` placeholder (FR-006) |
| `level` | `number` | Computed layout depth: `0` for a root (`effective_root_ids`), otherwise `1 + max(level of structural predecessors)` |
| `isOutputCandidate` | `boolean` | `true` iff `id` is in `output_node_candidates` (FR-007) |

**Validation rule**: every `PipelineNodeInfo.id` from the API response
produces exactly one `GraphNode` — no duplicates, none dropped (FR-014).

### GraphEdge

| Field | Type | Notes |
|---|---|---|
| `from` | `string` | Source node id |
| `to` | `string` | Target node id |
| `kind` | `"plain" \| "branch" \| "loop-continue" \| "loop-exit"` | Drives visual distinction (FR-003) |
| `label` | `string \| null` | Branch: the route's `when` expression, or `"default"`; loop: `back_to`/`exit_to` target plus `max_iterations` (FR-004, FR-005) |
| `branchId` | `string \| null` | Set when `kind === "branch"` |
| `isDefaultRoute` | `boolean` | Set when `kind === "branch"` and the route is the branch's default |
| `loopId` | `string \| null` | Set when `kind` is `"loop-continue"` or `"loop-exit"` |

**Derivation rules**:
- One `plain` edge per `(dependency, node.id)` pair in every node's
  `depends_on`, **except** for nodes that are a branch's `from_` or a
  loop's `from_` (`conditional_sources` in `pipeline_config/schema.py` —
  those nodes' outgoing edges are entirely branch/loop edges, never a
  mixed plain edge, matching the existing "no plain + conditional edge
  from the same source" constraint the backend already enforces).
- One `branch` edge per `BranchRoute` (`from → route.to`).
- One `loop-continue` edge per loop (`from → back_to`) and one
  `loop-exit` edge per loop (`from → exit_to`, or omitted/rendered as a
  terminal marker if `exit_to === "END"`).

### GraphModel

| Field | Type | Notes |
|---|---|---|
| `pipelineName` | `string` | For display and as a cache/reset key (FR-013) |
| `nodes` | `GraphNode[]` | |
| `edges` | `GraphEdge[]` | |

## Node Execution Status (live, per-run, transient)

Exists only while a run is in flight or just completed; discarded on
pipeline switch or new prompt (FR-013).

### NodeExecutionStatus

| Value | Meaning |
|---|---|
| `"not-started"` | Default state before any relevant event has arrived |
| `"running"` | All structural predecessors of this node have `"complete"` status and this node itself hasn't completed (client-side inference — see research.md §5) |
| `"complete"` | A `node_complete` SSE event named this node has arrived |
| `"failed"` | The stream's `error` event carried this node's id in `details.node_id` (see contracts/pipeline-detail-api.md) |

**State transitions**: `not-started → running → complete`, or
`not-started → running → failed`, or `not-started → failed` (a loop's
synthetic failure node has no independent "running" moment — see Loop
Progress below). No transition ever moves backward except the full reset
on FR-013 (new run / new pipeline).

## Branch Route Outcome (live, per-run, transient)

| Field | Type | Notes |
|---|---|---|
| `branchId` | `string` | |
| `takenTo` | `string \| null` | The route target whose node id first appears in `node_outputs` after the branch's `from_` node completes; `null` until then |

**Rule**: at most one route per branch can be "taken" per run — the graph
highlights that one `branch` edge and leaves the branch's other edges in
their normal (not-taken) styling (FR-010).

## Loop Progress (live, per-run, transient)

| Field | Type | Notes |
|---|---|---|
| `loopId` | `string` | |
| `iteration` | `number` | Latest `iteration` value from that loop's `loop_iteration` events; `0` before the first one |
| `maxIterations` | `number` | From the loop's static `PipelineLoopInfo.max_iterations` |
| `exhausted` | `boolean` | `true` once `iteration >= maxIterations` **and** the loop's `on_max_iterations` is `"fail"` **and** the synthetic loop-failed path fired (i.e. the loop's `error` event, if any, carried this `loopId` in `details.loop_id`) |

## Graph View State (live, aggregate — what a renderer actually holds)

| Field | Type | Notes |
|---|---|---|
| `graph` | `GraphModel` | Static structure for the currently selected pipeline |
| `nodeStatus` | `Record<string, NodeExecutionStatus>` | Keyed by node id; defaults to `"not-started"` for every node in `graph.nodes` |
| `branchOutcomes` | `Record<string, BranchRouteOutcome>` | Keyed by branch id |
| `loopProgress` | `Record<string, LoopProgress>` | Keyed by loop id |
| `connectionError` | `string \| null` | Non-null message when structure failed to load or the stream was lost mid-run (FR-015); nodes/edges already known stay rendered at their last known status per the resolved clarification |

**Reset rule** (FR-013): a fresh `GraphViewState` (all statuses
`"not-started"`, no outcomes, no progress, no error) is created whenever
the user selects a different pipeline or starts a new prompt against the
current one. The static `graph` itself is only rebuilt when the *pipeline*
changes, not on every new prompt.
