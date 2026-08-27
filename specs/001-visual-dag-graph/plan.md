# Implementation Plan: Visual DAG Graph Representation

**Branch**: `001-visual-dag-graph` | **Date**: 2026-08-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-visual-dag-graph/spec.md`

## Summary

Replace today's text-only pipeline structure listing with an actual
node-and-edge DAG diagram on both client surfaces — a graphical SVG diagram
in the web client, a box-drawing text diagram in the CLI — with branch and
loop edges visually distinct from plain `depends_on` edges, and live
per-node execution status overlaid during a streaming run. The graph
layout and edge-classification logic is shared (in `packages/client`)
between both renderers so they stay structurally consistent (SC-005). Two
small, backward-compatible-in-spirit backend contract extensions are
required: branch routes need to carry their `when`/`default` condition
(today the API only exposes route target ids), and node/loop execution
failures need a structured identifier so the graph can mark the *specific*
node that failed rather than only showing a prose error message.

## Technical Context

**Language/Version**: Python 3.11+ (backend — `pyproject.toml` requires
`>=3.11`, CI runs 3.12) · TypeScript 5.7 on Node.js 22 (CLI) and ES2022 in
the browser (web), per existing `tsconfig.json` files

**Primary Dependencies**: Backend: FastAPI, LangGraph, Pydantic — no new
backend dependencies. Frontend: no new npm dependencies either — the
diagram layout/rendering is hand-rolled (inline SVG for web, Unicode
box-drawing + `chalk` for CLI), matching this repo's existing pattern of
avoiding extra dependencies for things a small amount of first-party code
can do directly (e.g. the SSE parser in `packages/client/src/apiClient.ts`
is hand-rolled rather than pulling in an SSE library).

**Storage**: N/A — no new persistence. Structure comes from the existing
`GET /pipelines/{name}` endpoint; live status comes from the existing
`POST /ask/stream` SSE events. Nothing is stored beyond the lifetime of one
client session/run (per spec Assumptions: no historical run playback).

**Testing**: pytest for the backend contract/unit changes (extended
`PipelineBranchInfo`/`PipelineLoopInfo` shapes, the new structured
`node_id`/`loop_id` on execution-failure errors), matching
`llm_pipeline/tests`' existing conventions. The CLI and web packages have
no unit test framework today — CI only runs `tsc --noEmit` for them; this
feature follows that existing convention (typecheck + the quickstart's
manual walkthrough) rather than introducing a new JS test framework as a
side effect.

**Target Platform**: The existing three surfaces — the FastAPI server
(containerized via its existing `Dockerfile`), the Node.js 22 terminal CLI,
and the Vite-built browser web client.

**Project Type**: Web + CLI clients over a shared HTTP/SSE API (existing
npm-workspace monorepo: `llm_pipeline/`, `cli/`, `web/`,
`packages/client/`).

**Performance Goals**: Structure renders within 2s of selecting a pipeline
(SC-001); live status reflects each SSE event with no perceptible added
latency beyond the event's own delivery.

**Constraints**: No new runtime dependencies unless unavoidable, in both
languages, matching this repo's demonstrated minimal-dependency style;
the `PipelineBranchInfo`/`PipelineLoopInfo`/error-detail API shape changes
are internal-only (CLI and web are this API's only consumers, both in this
same repo) so they can change directly without a versioning/migration
shim.

**Scale/Scope**: Pipelines shipped today top out at 2-6 nodes; per spec
Assumptions no specific size ceiling is mandated — basic scroll/pan (web)
and wrapping (CLI) cover anything larger.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` contains only unfilled template
placeholders (`[PRINCIPLE_1_NAME]`, `[PRINCIPLE_1_DESCRIPTION]`, etc.) — no
concrete principles or gates have been ratified for this project. There is
nothing to check this plan against, so no gates apply and none are
violated. **Result: PASS (no constitution in effect).**

*Post-design re-check (after Phase 1):* research.md and data-model.md
introduce no new external dependencies, no new projects/services, and no
deviations from this repo's existing structure — only additive changes to
existing modules plus two new same-package files (`graphModel.ts`,
`graphRenderer.ts`/`graphView.ts`). Still nothing to gate against.
**Result: PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/001-visual-dag-graph/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/            # Phase 1 output (/speckit-plan command)
│   ├── pipeline-detail-api.md
│   └── graph-model.md
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
llm_pipeline/llm_pipeline/
├── api_schemas.py         # extend PipelineBranchInfo (structured routes),
│                            PipelineLoopInfo (on_max_iterations), and add
│                            node_id/loop_id to error details context
├── errors.py               # PipelineExecutionError gains optional
│                            node_id / loop_id attributes
├── dag_builder/
│   ├── node_types.py      # attach node_id when raising on a node failure
│   └── loops.py            # attach loop_id when raising on loop exhaustion
├── routers/
│   ├── health.py           # populate the richer branch/loop shapes
│   └── ask.py               # thread node_id/loop_id into the SSE error event
└── ...                      # (unchanged otherwise)

llm_pipeline/tests/
└── test_pipeline_config.py / a new test module  # cover the extended
                                                    response shapes and
                                                    structured error detail

packages/client/src/
├── types.ts                # extend PipelineBranchInfo/PipelineLoopInfo;
│                            add GraphModel/GraphNode/GraphEdge/
│                            NodeExecutionStatus/BranchRouteOutcome/
│                            LoopProgress types (see data-model.md)
└── graphModel.ts            # NEW — pure functions: build a classified,
                              layered graph model from PipelineDetail;
                              fold AskStreamEvents into live status/route/
                              loop-progress state. Shared by cli and web.

cli/src/
├── graphRenderer.ts         # NEW — renders a GraphModel (+ optional live
│                            status) as a box-drawing/ANSI diagram
├── formatter.ts             # formatPipelineDetail() now renders via
│                            graphRenderer instead of a flat node list
└── index.ts                  # /pipeline renders the diagram; streaming
                              mode redraws the diagram in place instead of
                              appending a scrolling event log

web/src/
├── graphView.ts              # NEW — renders a GraphModel (+ live status)
│                            as inline SVG; owns error-state display
├── main.ts                   # wires graphView for structure + live
│                            updates during askStream(); replaces
│                            relayAnimator's role
├── relayAnimator.ts           # REMOVED — superseded by graphView, which
│                            can show real edges/branches/loops where this
│                            component's own docs say it deliberately
│                            could not (linear stage track only)
└── style.css                  # new styles for graph nodes/edges/status/
                              error marker
web/index.html                # US1 (T007): add a graph view container
                              alongside the existing `#relay` track; US3
                              (T025) removes `#relay`/`relayAnimator.ts`
                              once the graph view covers live status too
```

**Structure Decision**: This stays within the existing npm-workspace
monorepo shape — no new top-level project. The graph's structural
layout/classification logic is added once, as pure data-in/data-out
functions in `packages/client` (already the shared source of truth for API
types between `cli` and `web`), and each surface adds only its own
rendering: box-drawing text in `cli`, inline SVG in `web`. The backend
changes are additive extensions to the existing `llm_pipeline` package
(no new modules at the top level), scoped to exactly the two response
shapes and one error path this feature needs richer data from.

## Complexity Tracking

*No constitution is in effect (see Constitution Check above), so there are
no gates to justify violations against. No entries.*
