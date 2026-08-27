# Quickstart: Visual DAG Graph Representation

Manual validation guide for this feature — run these scenarios against a
real server after implementation to confirm each user story and success
criterion. No automated JS test suite exists in this repo (see
research.md §9); this is the primary verification path for `cli`/`web`
changes, alongside `tsc --noEmit`. Backend changes additionally get pytest
coverage (see contracts/pipeline-detail-api.md).

## Prerequisites

- Ollama running locally (or another configured provider) — see
  `llm_pipeline/README.md` for setup.
- From repo root: `npm install` (installs `packages/client`, `cli`, `web`
  workspaces together).
- From `llm_pipeline/`: `uv sync --locked`.

## Setup

Terminal 1 — backend:

```bash
cd llm_pipeline && uv run uvicorn llm_pipeline.main:app --reload --port 8000
```

Terminal 2 — web client:

```bash
cd web && npm run dev
```

Terminal 3 — CLI:

```bash
cd cli && npm run dev
```

## Scenario 1 — Static structure, web (User Story 1 / FR-001–008, SC-001, SC-002)

1. Open the web client (default Vite dev URL). Select **consensus-qa**
   (or any pipeline with parallel roots) from the pipeline dropdown.
2. **Expect**: within 2 seconds, a diagram appears showing every node in
   that pipeline and every `depends_on` edge between them (SC-001).
3. Select **support-router** (or whichever shipped pipeline has a
   `branches:` block).
4. **Expect**: branch route edges render visually distinct from plain
   edges, each labeled with its `when` condition or "default" (FR-004).
5. Select **iterative-refinement** (or whichever shipped pipeline has a
   `loops:` block).
6. **Expect**: the loop's continue/exit edges render visually distinct
   from plain and branch edges, labeled with the loop id and
   `max_iterations` (FR-005).
7. Repeat steps 1–6 for every `*.yaml` file in `llm_pipeline/pipelines/`.
   **Expect**: all render with no console errors and no missing
   nodes/edges (SC-002).

## Scenario 2 — Static structure, CLI (User Story 2 / FR-002–003)

1. In the CLI, run `/pipeline` against a pipeline with plain edges only.
   **Expect**: a box-drawing diagram, not the old flat `depends_on:` list.
2. Run `/use <branch-pipeline>` then `/pipeline`. **Expect**: branch edges
   marked distinctly (e.g. distinct symbol/color) with condition labels.
3. Run `/use <loop-pipeline>` then `/pipeline`. **Expect**: loop edges
   marked distinctly with `back_to`/`exit_to`/`max_iterations` labels.
4. Compare the CLI diagram's node/edge set against the same pipeline's web
   diagram from Scenario 1. **Expect**: identical nodes and edges,
   consistent classification (SC-005).

## Scenario 3 — Live execution overlay (User Story 3 / FR-009–012)

1. Web: enable "stream progress", select a multi-node pipeline (e.g.
   consensus-qa), submit a prompt.
   **Expect**: nodes visually change not-started → running → complete as
   the run progresses (SC-003); at completion, the produced/output node is
   identifiable from the diagram alone (SC-004).
2. Repeat with a branch pipeline. **Expect**: after completion, exactly
   one route is highlighted as taken; the other route(s) are not (FR-010).
3. Repeat with a loop pipeline. **Expect**: while running, the iteration
   count updates against `max_iterations` (FR-011); after completion the
   final count is shown.
4. CLI: toggle `/stream`, submit a prompt to the same pipelines used in
   steps 1–3. **Expect**: the same diagram from Scenario 2 redraws in
   place showing the same status/route/iteration progression, not a
   scrolling per-event log.
5. Force a node failure (e.g. temporarily point a pipeline's model at an
   unreachable provider/URL, or stop Ollama mid-run) on both web and CLI.
   **Expect**: the specific node that failed is marked failed, distinct
   from not-started and complete nodes (FR-012).

## Scenario 4 — Error / connection-loss handling (FR-015, Clarification 1)

1. Web: select a pipeline, then stop the backend server before the
   structure finishes loading (or block the request in devtools).
   **Expect**: an inline error marker on the graph, not a blank screen.
2. Web: start a streaming run, then stop the backend mid-run.
   **Expect**: an inline error/connection-lost marker; nodes already
   rendered stay visible at their last known status (not cleared).
3. Repeat both against the CLI. **Expect**: equivalent inline error
   indication, not a silent hang or an unhandled exception.

## Scenario 5 — Large-pipeline scroll/pan (FR-016)

1. Temporarily add a pipeline YAML with enough nodes to overflow the
   viewport (or shrink the browser window on an existing pipeline).
   **Expect**: the web diagram is reachable via scroll/pan, not clipped
   with no way to see the rest; no zoom controls are required to pass
   this check.
2. Shrink the terminal window narrower than a diagram's natural width.
   **Expect**: the CLI diagram wraps rather than becoming illegible
   garbled output.

## Scenario 6 — Reset on pipeline switch (FR-013)

1. Start a streaming run on pipeline A; before it finishes, switch to
   pipeline B (web: pipeline dropdown; CLI: `/use <name>`).
   **Expect**: pipeline B's diagram shows fresh `not-started` status for
   all its nodes — none of pipeline A's in-flight status leaks onto it.

## Backend contract check

`cd llm_pipeline && uv run pytest -v` — new/updated tests should assert:

- `GET /pipelines/{name}` for a pipeline with branches returns
  `routes` as `{to, when, default}` objects (not bare strings), and for a
  pipeline with loops returns `on_max_iterations`.
- A node failure surfaces `details: {"node_id": "<id>"}` on the stream's
  `error` event; a loop-exhaustion failure surfaces
  `details: {"loop_id": "<id>"}`.
