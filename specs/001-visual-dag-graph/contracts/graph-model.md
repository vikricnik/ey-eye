# Contract: `packages/client/src/graphModel.ts`

Internal contract between the shared client package and its two
consumers (`cli`, `web`). This is what guarantees SC-005 (both surfaces
show identical structure) — `cli` and `web` MUST both build their diagrams
from this module's output, never by independently walking
`PipelineDetail` themselves.

## Exported functions

### `buildGraphModel(detail: PipelineDetail): GraphModel`

Pure function. Given one pipeline's structural detail (the response from
`GET /pipelines/{name}`, using the extended shapes in
[pipeline-detail-api.md](./pipeline-detail-api.md)), returns the
`GraphModel` described in [data-model.md](../data-model.md) — nodes with
computed `level`, and every edge classified as `plain` / `branch` /
`loop-continue` / `loop-exit` with its label.

**Must hold for every pipeline shape already valid per
`pipeline_config/validation.py`** (multiple roots, branch targets with no
plain incoming edge, multiple `output_node` candidates, loops) — FR-014.

### `createGraphViewState(graph: GraphModel): GraphViewState`

Pure function. Returns a fresh `GraphViewState` (data-model.md) for
`graph`: every node `"not-started"`, no branch outcomes, no loop
progress, no connection error. Called on initial pipeline selection and
on every FR-013 reset (pipeline switch, new prompt).

### `applyStreamEvent(state: GraphViewState, event: AskStreamEvent): GraphViewState`

Pure function (returns a new state, doesn't mutate). Folds one
`AskStreamEvent` into `state`:

- `node_complete` → that node's status becomes `"complete"`; every node
  whose structural predecessors are now all `"complete"` and who isn't
  itself `"complete"` becomes `"running"` (the client-side inference from
  research.md §5); if the completed node is a branch's `from_` node's
  target reachable via one specific route, record that route as the
  branch's `takenTo`.
- `loop_iteration` → update that loop's `LoopProgress.iteration`.
- `done` → no-op on per-node status (every relevant node already reached
  `"complete"` via its own `node_complete` event); present only so
  callers have one function to route every event through uniformly.

### `applyStreamError(state: GraphViewState, error: PipelineApiError): GraphViewState`

Pure function. Sets `state.connectionError` to a user-facing message. If
`error` carries a recognizable `node_id`/`loop_id` (surfaced via
`PipelineApiError`'s existing `exceptionUID`/message — see Open Question
below), the corresponding node's status becomes `"failed"` /that loop's
`exhausted` becomes `true`; otherwise only `connectionError` is set,
leaving all node statuses at their last known value (FR-015 — nodes stay
visible, none are cleared).

## Consumers

- `cli/src/graphRenderer.ts`: `renderGraphText(graph: GraphModel, state?: GraphViewState): string[]`
  (an array of terminal lines, so the CLI can track how many lines it
  printed for the in-place-redraw approach in research.md §7).
- `web/src/graphView.ts`: `renderGraphSvg(graph: GraphModel, state?: GraphViewState): SVGSVGElement`
  (or a container element with an embedded `<svg>` — DOM update details
  are an implementation choice, not part of this contract).

Both consumer functions accept `state` as optional specifically so the
same rendering path serves both User Story 1/2 (structure only, no run in
progress) and User Story 3 (structure + live status) without a separate
code path per story.

## Open question carried into implementation (not spec-blocking)

`PipelineApiError` (in `packages/client/src/apiClient.ts`) currently
exposes `message`, `statusCode`, `exceptionUID`, `validations` — not the
new `details.node_id`/`details.loop_id` from
[pipeline-detail-api.md](./pipeline-detail-api.md). `apiClient.ts`'s
`error` SSE branch will need to also capture `details` onto
`PipelineApiError` (a small, additive constructor change, same shape as
the existing `validations` parameter) for `applyStreamError` to use it.
This is an implementation detail of wiring the already-specified backend
field through the existing error type, not a new design decision — noted
here so it isn't missed during task breakdown.
