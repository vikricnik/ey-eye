# Contract: Pipeline structure & streaming-error API

Consumers: `cli` and `web` (via `packages/client`), both in this repo —
no external/third-party consumers exist for this API today, so these are
direct, in-place shape changes rather than additive-only/versioned ones.

## `GET /pipelines/{name}` — `PipelineDetailResponse`

Unchanged fields: `name`, `description`, `output_node_candidates`,
`nodes` (`PipelineNodeInfo[]`).

### `branches: PipelineBranchInfo[]` — CHANGED

Before:

```json
{
  "id": "route-by-topic",
  "from": "classify",
  "routes": ["handle_billing", "handle_technical"]
}
```

After:

```json
{
  "id": "route-by-topic",
  "from": "classify",
  "routes": [
    { "to": "handle_billing", "when": "output == 'billing'", "default": false },
    { "to": "handle_technical", "when": null, "default": true }
  ]
}
```

- `PipelineBranchRouteInfo.to: str` — unchanged meaning, now nested.
- `PipelineBranchRouteInfo.when: str | None` — the route's raw `when`
  expression from the YAML (`BranchRoute.when`); `None` for the default
  route.
- `PipelineBranchRouteInfo.default: bool` — mirrors `BranchRoute.default`.
  Exactly one route per branch has `default: true` (already enforced by
  `BranchConfig.exactly_one_default`).

### `loops: PipelineLoopInfo[]` — CHANGED (one field added)

```json
{
  "id": "refine",
  "from": "draft",
  "back_to": "draft",
  "exit_to": "END",
  "max_iterations": 3,
  "on_max_iterations": "proceed"
}
```

- `on_max_iterations: "proceed" | "fail"` — new field, mirrors
  `LoopConfig.on_max_iterations`.

## `POST /ask/stream` — `error` SSE event `details`

The `error` event's payload is unchanged in shape
(`ErrorResponse` — `timestamp`, `status`, `error`, `message`, `request`,
`exceptionUID`, `details`, `validations`); what's new is that `details`
is now populated for execution failures raised from a specific node or
loop:

```
event: error
data: {"timestamp": "...", "status": 502, "error": "Bad Gateway",
       "message": "Node 'draft' failed: provider timeout",
       "request": "POST /ask/stream", "exceptionUID": "...",
       "details": {"node_id": "draft"}, "validations": []}
```

or, for a loop that exhausted `max_iterations` with `on_max_iterations:
fail`:

```
"details": {"loop_id": "refine"}
```

- `details.node_id: string` — present when the failure is attributable to
  one `llm_call` node (`PipelineExecutionError.node_id`).
- `details.loop_id: string` — present when the failure is a loop
  exhausting its `max_iterations` (`PipelineExecutionError.loop_id`).
- Neither key is present for failures not attributable to a specific
  node/loop (e.g. "none of the output_node candidates produced a
  result") — consumers MUST treat a `details` object with neither key as
  a run-level failure, not a bug.

## Backend changes required

- `llm_pipeline/llm_pipeline/api_schemas.py`: add `PipelineBranchRouteInfo`;
  change `PipelineBranchInfo.routes` to `list[PipelineBranchRouteInfo]`;
  add `PipelineLoopInfo.on_max_iterations: Literal["proceed", "fail"]`.
- `llm_pipeline/llm_pipeline/errors.py`: `PipelineExecutionError.__init__`
  gains `node_id: str | None = None, loop_id: str | None = None`
  attributes (stored, not behavior-changing).
- `llm_pipeline/llm_pipeline/dag_builder/node_types.py`: pass
  `node_id=node_cfg.id` when raising on a node failure.
- `llm_pipeline/llm_pipeline/dag_builder/loops.py`: pass
  `loop_id=loop_id` when raising on loop exhaustion.
- `llm_pipeline/llm_pipeline/routers/health.py`: build the richer
  `routes`/`on_max_iterations` shapes from the already-available
  `BranchRoute`/`LoopConfig` fields.
- `llm_pipeline/llm_pipeline/routers/ask.py`: in `_stream_pipeline_run`'s
  exception handling, pass
  `details={"node_id": e.node_id} if e.node_id else ({"loop_id": e.loop_id} if e.loop_id else {})`
  into `build_error_response`.
- The non-streaming `POST /ask` endpoint's `HTTPException` path is
  **not** changed — FR-009/FR-012's live per-node status only applies to
  streaming runs (User Story 3's independent test explicitly requires
  "streaming enabled").
