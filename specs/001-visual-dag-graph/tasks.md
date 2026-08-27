# Tasks: Visual DAG Graph Representation

**Input**: Design documents from `/specs/001-visual-dag-graph/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Backend contract changes get pytest coverage, matching this
repo's existing enforced convention (`ruff`/`mypy --strict`/`pyright`/
`pytest` all run in CI for `llm_pipeline`). No new JS test framework is
introduced for `cli`/`web` — neither has one today (CI only typechecks
them) — per research.md §9; those changes are verified via `tsc --noEmit`
plus the manual [quickstart.md](./quickstart.md) scenarios.

**Organization**: Tasks are grouped by user story (US1 = P1 web static
graph, US2 = P2 CLI static graph, US3 = P3 live execution overlay), each
independently testable per spec.md's "Independent Test" for that story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an
  incomplete task)
- **[Story]**: US1 / US2 / US3 — omitted for Setup, Foundational, and
  Polish tasks
- Every description includes its exact file path(s)

---

## Phase 1: Setup

**Purpose**: Establish the extended data shapes every later task builds on
— no behavior changes yet, just types.

- [X] T001 [P] Add `GraphNode`, `GraphEdge`, `GraphModel`,
  `NodeExecutionStatus`, `BranchRouteOutcome`, `LoopProgress`,
  `GraphViewState` types to `packages/client/src/types.ts`, and update
  `PipelineBranchInfo`/add `PipelineBranchRouteInfo`/extend
  `PipelineLoopInfo` with `on_max_iterations` there too, per
  [data-model.md](./data-model.md) and
  [contracts/pipeline-detail-api.md](./contracts/pipeline-detail-api.md)
- [X] T002 [P] Add `PipelineBranchRouteInfo` model and update
  `PipelineBranchInfo.routes: list[PipelineBranchRouteInfo]` /
  `PipelineLoopInfo.on_max_iterations: Literal["proceed", "fail"]` in
  `llm_pipeline/llm_pipeline/api_schemas.py`, per
  [contracts/pipeline-detail-api.md](./contracts/pipeline-detail-api.md)

**Checkpoint**: Both ends of the structural API contract are typed and
ready for the endpoint/logic that populates them.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one shared backend endpoint change and the one shared
graph-building function every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Update `GET /pipelines/{name}` construction in
  `llm_pipeline/llm_pipeline/routers/health.py` to build the structured
  `routes` (`to`/`when`/`default`, from `BranchRoute`) and
  `on_max_iterations` (from `LoopConfig`) fields instead of the current
  `[r.to for r in b.routes]` string list, per
  [contracts/pipeline-detail-api.md](./contracts/pipeline-detail-api.md)
  (depends on T002)
- [X] T004 Add pytest coverage in `llm_pipeline/tests/test_pipeline_config.py`
  (or a new `llm_pipeline/tests/test_health.py`) asserting
  `GET /pipelines/{name}` returns structured branch routes with
  `when`/`default` and loop `on_max_iterations`, using
  `llm_pipeline/tests/fixtures/valid/simple_branch.yaml` and
  `simple_loop.yaml` (depends on T003)
- [X] T005 Implement `buildGraphModel(detail: PipelineDetail): GraphModel`
  in `packages/client/src/graphModel.ts` — compute each node's layout
  `level` (root = 0, otherwise `1 + max(level of structural
  predecessors)`, using the same "conditional sources have no plain
  outgoing edge" rule as `pipeline_config/schema.py`'s
  `conditional_sources`), classify every edge as `plain`/`branch`/
  `loop-continue`/`loop-exit` with its label, and mark
  `output_node_candidates`; export it from `packages/client/src/index.ts`.
  Must handle every pipeline shape already valid per
  `pipeline_config/validation.py` (multiple roots, branch targets with no
  plain incoming edge, multiple output candidates, loops) per FR-014 —
  see [data-model.md](./data-model.md) and
  [contracts/graph-model.md](./contracts/graph-model.md) (depends on T001,
  T003)

**Checkpoint**: Foundation ready — every user story phase below can now
build its own rendering on top of `buildGraphModel`'s output.

---

## Phase 3: User Story 1 - View a pipeline's structure as a visual graph in the browser (Priority: P1) 🎯 MVP

**Goal**: The web client renders a selected pipeline's full node/edge
structure as an SVG diagram, with branch and loop edges visually distinct
and labeled, and output-candidate nodes marked.

**Independent Test**: Open the web client, select any pipeline from the
list, and confirm the diagram renders all of that pipeline's nodes and
edges correctly with no prompt sent and no run in progress.

### Implementation for User Story 1

- [X] T006 [P] [US1] Implement
  `renderGraphSvg(graph: GraphModel): SVGSVGElement` in
  `web/src/graphView.ts` — draw each node (id + model label,
  output-candidate marker) and each edge (plain: solid line; branch:
  visually distinct + condition/"default" label; loop: visually distinct
  + loop id/max-iterations label) positioned by `node.level`, per
  [contracts/graph-model.md](./contracts/graph-model.md) (depends on T005)
- [X] T007 [P] [US1] Add a graph view container element to `web/index.html`
  (alongside the existing `#relay` track, which stays until US3 replaces
  it)
- [X] T008 [US1] Wire `web/src/main.ts`'s `switchToPipeline()` to call
  `buildGraphModel(detail)` then `renderGraphSvg(...)` into the new
  container from T007 (depends on T005, T006, T007)
- [X] T009 [P] [US1] Add CSS for graph nodes, plain/branch/loop edge
  styles, edge labels, and the output-candidate marker in
  `web/src/style.css`
- [X] T010 [US1] Add scroll/pan support (no zoom controls required) for
  diagrams larger than the viewport in `web/src/graphView.ts` /
  `web/src/style.css`, per FR-016 (depends on T006)
- [X] T011 [US1] Show an inline error marker in the graph container (via
  `web/src/main.ts` / `web/src/graphView.ts`) when
  `client.getPipelineDetail()` fails, per FR-015's structural-load-failure
  case (depends on T008)

**Checkpoint**: User Story 1 is fully functional and independently
testable — every shipped pipeline's structure renders correctly in the
browser (SC-001, SC-002).

---

## Phase 4: User Story 2 - View a pipeline's structure as a text graph in the terminal (Priority: P2)

**Goal**: The CLI's `/pipeline` command renders the same node/edge
structure as a box-drawing text diagram, with the same branch/loop
distinctions as the web view.

**Independent Test**: Run the CLI, select any pipeline, run the graph
command, and confirm the rendered text diagram reflects all nodes and
edges of that pipeline with no prompt sent.

### Implementation for User Story 2

- [X] T012 [P] [US2] Implement
  `renderGraphText(graph: GraphModel): string[]` in
  `cli/src/graphRenderer.ts` — box-drawing layout by `node.level`,
  `chalk`-colored plain/branch/loop edges with labels, output-candidate
  marker, per [contracts/graph-model.md](./contracts/graph-model.md)
  (depends on T005)
- [X] T013 [US2] Update `formatPipelineDetail()` in `cli/src/formatter.ts`
  (and its call sites in `cli/src/index.ts`'s `/pipeline` handler) to
  build via `buildGraphModel` + `renderGraphText` instead of the current
  flat `depends_on:` listing (depends on T005, T012)
- [X] T014 [US2] Add a terminal-width wrapping fallback in
  `cli/src/graphRenderer.ts` for diagrams wider than
  `process.stdout.columns`, per FR-016's terminal case (depends on T012)
- [X] T015 [US2] Print an inline error marker in `cli/src/index.ts`'s
  `/pipeline` and `/use` handlers when `client.getPipelineDetail()` fails,
  per FR-015's structural-load-failure case (depends on T013)

**Checkpoint**: User Stories 1 AND 2 both work independently, and show
identical structure for the same pipeline (SC-005 is now verifiable).

---

## Phase 5: User Story 3 - Watch live execution progress on the graph (Priority: P3)

**Goal**: While a prompt runs with streaming enabled, both the web diagram
and the CLI diagram update in place to show per-node status
(not-started/running/complete/failed), which branch route was taken,
current loop iteration vs. max, and an inline marker if the connection is
lost mid-run.

**Independent Test**: Submit a prompt to a multi-node pipeline and confirm
the graph reflects node status changes over time while the request is in
flight, and reflects the final state (nodes run, route taken, loop
iterations) once it finishes, without re-fetching the static structure.

### Implementation for User Story 3

- [X] T016 [P] [US3] Add optional `node_id: str | None = None` and
  `loop_id: str | None = None` attributes to `PipelineExecutionError` in
  `llm_pipeline/llm_pipeline/errors.py`
- [X] T017 [P] [US3] Pass `node_id=node_cfg.id` when raising
  `PipelineExecutionError` on a node failure in
  `llm_pipeline/llm_pipeline/dag_builder/node_types.py` (depends on T016)
- [X] T018 [P] [US3] Pass `loop_id=loop_id` when raising
  `PipelineExecutionError` on loop exhaustion in
  `llm_pipeline/llm_pipeline/dag_builder/loops.py` (depends on T016)
- [X] T019 [US3] In `_stream_pipeline_run`'s exception handling in
  `llm_pipeline/llm_pipeline/routers/ask.py`, thread
  `details={"node_id": e.node_id}` or `{"loop_id": e.loop_id}` (whichever
  is set) into the `error` SSE event's `build_error_response(...)` call,
  per [contracts/pipeline-detail-api.md](./contracts/pipeline-detail-api.md)
  (depends on T016, T017, T018)
- [X] T020 [P] [US3] Add pytest coverage in
  `llm_pipeline/tests/test_streaming.py` asserting a node failure's
  `error` event carries `details.node_id` and a loop-exhaustion failure
  carries `details.loop_id` (depends on T019)
- [X] T021 [US3] Capture the `error` event's `details` onto
  `PipelineApiError` in `packages/client/src/apiClient.ts`'s
  `askStream()` error branch, per
  [contracts/graph-model.md](./contracts/graph-model.md)'s open question
  (depends on T019's documented shape)
- [X] T022 [US3] Implement `createGraphViewState(graph): GraphViewState`,
  `applyStreamEvent(state, event): GraphViewState`, and
  `applyStreamError(state, error): GraphViewState` in
  `packages/client/src/graphModel.ts` — client-side running-status
  inference from dependency completion, branch-taken-route tracking,
  loop-progress tracking, and failed-node/loop marking from
  `error.details`, per [data-model.md](./data-model.md) and research.md §5
  (depends on T005, T021)
- [X] T023 [US3] Extend `renderGraphSvg` (or add a sibling status-apply
  function) in `web/src/graphView.ts` to accept an optional
  `GraphViewState` and render not-started/running/complete/failed node
  styling, taken-vs-not-taken route highlighting, loop
  iteration/max-iterations display, and the inline connection-error
  marker (depends on T022, T006)
- [X] T024 [US3] Wire `web/src/main.ts`'s `askStream()` loop to call
  `applyStreamEvent`/`applyStreamError` and re-render via T023 instead of
  driving `RelayAnimator`; reset via `createGraphViewState` whenever the
  pipeline changes or a new prompt starts, per FR-013 (depends on T022,
  T023)
- [X] T025 [US3] Remove `web/src/relayAnimator.ts` and the `#relay`
  container/usage from `web/index.html` and `web/src/main.ts`, now
  superseded by T024's live graph view (depends on T024)
- [X] T026 [P] [US3] Add CSS for not-started/running/complete/failed node
  states, taken-route highlighting, loop-progress label, and the
  connection-error marker in `web/src/style.css`
- [X] T027 [US3] Extend `renderGraphText` in `cli/src/graphRenderer.ts` to
  accept an optional `GraphViewState` and render the same
  status/route/loop/error information as T023, consistent with the web
  styling choices (depends on T022, T012)
- [X] T028 [US3] Rework `handlePromptStreaming()` in `cli/src/index.ts` to
  redraw the diagram in place — track the previously-printed line count
  from `renderGraphText`, move the cursor up and clear, then reprint with
  the updated `GraphViewState` after each `AskStreamEvent` (via
  `applyStreamEvent`) or error (via `applyStreamError`) — instead of
  appending one line per event; reset via `createGraphViewState` per
  FR-013. On terminal resize (`process.stdout` `resize` event) mid-run,
  re-measure width and do a full repaint instead of a partial
  cursor-relative clear based on the stale line count (depends on T022,
  T027)

**Checkpoint**: All three user stories are independently functional; the
full feature set from spec.md is implemented.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T029 [P] Update the `/help` text in `cli/src/index.ts`'s
  `helpText()` and any relevant description in `README.md` to describe
  the new graph view (structure + live status) instead of the old flat
  `depends_on:` listing
- [X] T030 Execute [quickstart.md](./quickstart.md)'s Scenarios 1-6
  end-to-end against a running server and both clients; fix any
  discrepancies found
- [X] T031 [P] Run the full CI-equivalent check set locally: `npm run
  typecheck` at the repo root, and in `llm_pipeline/`: `uv run ruff check
  .`, `uv run mypy llm_pipeline/`, `uv run pyright`, `uv run pytest -v`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001, T002) — BLOCKS all
  user stories
- **User Story 1 (Phase 3)**: Depends on Foundational only
- **User Story 2 (Phase 4)**: Depends on Foundational only — independent
  of User Story 1 (both consume `buildGraphModel`, neither's files
  overlap the other's)
- **User Story 3 (Phase 5)**: Depends on Foundational, and functionally
  needs US1's `web/src/graphView.ts` (T006) and US2's
  `cli/src/graphRenderer.ts` (T012) to already exist, since it extends
  both rather than replacing them
- **Polish (Phase 6)**: Depends on whichever of US1/US2/US3 were
  completed

### User Story Dependencies

- **US1 (P1)**: No dependency on US2 or US3 — independently shippable MVP
- **US2 (P2)**: No dependency on US1 — independently shippable once
  Foundational is done, though in practice its `renderGraphText` (T012)
  mirrors `renderGraphSvg` (T006) design decisions
- **US3 (P3)**: Extends both US1's and US2's rendering functions with an
  optional `GraphViewState` parameter — needs T006 and T012 to exist
  first, but adds no new files that US1/US2 depend on, so US1 and US2
  remain independently testable without US3

### Parallel Opportunities

- T001 and T002 (Setup) — different files, run together
- T016, T017, T018 (US3 backend error attributes) — different files, run
  together once T016 lands
- T006 (web renderer) and T012 (CLI renderer) — different files/packages,
  can be built in parallel by different people once T005 (Foundational)
  is done
- T009 and T026 (CSS) can be developed alongside their corresponding
  `.ts` logic tasks in the same phase
- T020 (pytest) can run in parallel with T021 (client error capture) once
  T019 lands, since they only share a documented contract, not a file

---

## Parallel Example: Foundational → User Story 1 / User Story 2 fan-out

```bash
# After Foundational (T001-T005) completes:
Task: "Implement renderGraphSvg(graph): SVGSVGElement in web/src/graphView.ts"
Task: "Implement renderGraphText(graph): string[] in cli/src/graphRenderer.ts"
# Both consume the same buildGraphModel() output and touch entirely
# separate files — safe to build simultaneously.
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T005) — this includes the backend
   branch/loop label data US1's acceptance scenarios require
3. Complete Phase 3: User Story 1 (T006-T011)
4. **STOP and VALIDATE**: run quickstart.md Scenario 1 against the web
   client
5. Demo if ready — this alone replaces the flat pipeline listing with a
   real diagram in the browser

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 (web static graph) → validate independently → demo (MVP)
3. Add US2 (CLI static graph) → validate independently, confirm SC-005
   parity with US1 → demo
4. Add US3 (live execution overlay on both surfaces) → validate
   independently → demo the full feature set from spec.md

### Parallel Team Strategy

With multiple developers, after Foundational (T001-T005) completes:

- Developer A: User Story 1 (web) — T006-T011
- Developer B: User Story 2 (CLI) — T012-T015
- Once both land, either developer picks up User Story 3 (T016-T028),
  since it extends files both already own

---

## Notes

- [P] tasks touch different files and have no incomplete-task dependency
  within their batch
- [US1]/[US2]/[US3] labels map every story-phase task back to spec.md's
  user stories for traceability
- Each user story phase ends at a checkpoint where that story alone is
  demoable
- Commit after each task or logical group
- Avoid: vague tasks, same-file conflicts marked [P], cross-story
  dependencies that would break US1/US2's independence from US3
