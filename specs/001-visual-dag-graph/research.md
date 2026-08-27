# Research: Visual DAG Graph Representation

No `[NEEDS CLARIFICATION]` markers remain in the Technical Context (all
resolved directly from reading the existing codebase — this is an
established project, not a greenfield one). What follows are the
non-obvious technical decisions this plan makes, and why.

## 1. Shared graph model lives in `packages/client`, not duplicated per surface

**Decision**: Add one new module, `packages/client/src/graphModel.ts`,
containing pure functions that (a) turn a `PipelineDetail` into a
classified, layered `GraphModel` (nodes + edges tagged `plain`/`branch`/
`loop`), and (b) fold a stream of `AskStreamEvent`s into live status state.
Both `cli` and `web` consume this same module and only add their own
rendering on top.

**Rationale**: `packages/client` already exists specifically to be "the
single source of truth for the request/response contract" shared between
`cli` and `web` (per its own `package.json` description). Spec requirement
SC-005 demands the two surfaces show *identical* graph structure — the
only reliable way to guarantee that is for them to compute it from the
same code, not two independent reimplementations that could quietly drift.

**Alternatives considered**: Implementing layout/classification separately
in each of `cli` and `web` — rejected because it duplicates non-trivial
logic (topological layering, edge classification, live-status folding) and
makes SC-005 an ongoing manual-sync burden instead of a structural
guarantee.

## 2. Hand-rolled layout and rendering — no new diagramming dependency

**Decision**: Compute a simple layered (topological-level) layout by hand
in `graphModel.ts`, render it as inline SVG in `web` and as Unicode
box-drawing characters (plus `chalk` for color) in `cli`. No diagramming
library (`dagre`, `elkjs`, `cytoscape.js`, `mermaid`, etc.) is added.

**Rationale**: Every pipeline shipped today has 2-6 nodes (see
`llm_pipeline/pipelines/*.yaml` and `tests/fixtures/valid/*.yaml`) — small
enough that a straightforward "level = 1 + max(level of dependencies)"
layering, with siblings at the same level stacked vertically, produces a
readable diagram without a general-purpose auto-layout engine. This also
matches the project's demonstrated preference for small, first-party
implementations over dependencies for well-scoped problems — e.g. the
existing hand-rolled SSE parser in `apiClient.ts` rather than a library,
and the recent move from Poetry to `uv` specifically to reduce tooling
weight (see git history). Neither `cli` nor `web` has any visualization
dependency today.

**Alternatives considered**: `dagre`/`elkjs` for auto-layout — rejected as
disproportionate for graphs this small and adds a dependency with no
existing precedent in this codebase; `mermaid.js` — rejected because it
renders as a single static diagram type and doesn't have a natural path to
per-node live-status overlays or a terminal-text counterpart, both of
which this feature needs.

## 3. Branch route conditions: extend the API, don't infer them client-side

**Decision**: Change `PipelineBranchInfo.routes` from `list[str]` (just
target node ids, per `llm_pipeline/llm_pipeline/routers/health.py`'s
current `[r.to for r in b.routes]`) to a list of `{to, when, default}`
objects, mirroring `BranchRoute`'s actual fields in
`pipeline_config/schema.py`. Mirror the same shape in
`packages/client/src/types.ts`.

**Rationale**: FR-004 requires each branch route edge to be labeled with
its `when` condition or marked as the default route. That data exists
server-side (`BranchRoute.when` / `BranchRoute.default`) but is
**currently discarded** before it reaches the API response — there's no
way to reconstruct it client-side. This is a straightforward, targeted
field addition, not a new capability.

**Alternatives considered**: Leaving the API as-is and showing routes
unlabeled — rejected, directly fails FR-004; re-deriving `when` text from
some other endpoint — none exists; this data only lives in the parsed
pipeline definition.

## 4. Loop `on_max_iterations` also gets exposed, while touching this response anyway

**Decision**: Add `on_max_iterations: "proceed" | "fail"` to
`PipelineLoopInfo`, alongside the branch-route change above.

**Rationale**: One of the spec's edge cases asks whether the graph
distinguishes a loop that exited normally from one that exhausted its
iterations under `on_max_iterations: fail`. That distinction is
undecidable client-side without this field. Since `health.py`'s loop
construction is already being touched for consistency with the branch
change, adding this one field is minimal incremental cost and closes a
named edge case rather than leaving it silently unresolved.

## 5. "Running" status is inferred client-side, not pushed by a new server event

**Decision**: The client (via `graphModel.ts`) marks a node `running` once
all of its structural predecessors (plain `depends_on`, or the branch/loop
edge that targets it) have completed and it has not itself completed —
computed from the already-known static structure plus whichever
`node_complete` events have arrived so far. No new "node started" SSE
event is added server-side.

**Rationale**: `_stream_pipeline_run` in `routers/ask.py` streams via
LangGraph's `graph.astream(..., stream_mode="updates")`, which only yields
a chunk **after** a node (or a parallel batch of nodes in the same
superstep) finishes — there is no hook for "a node just started."
Introducing one would mean either restructuring the LangGraph execution
loop or wrapping every node function with start-of-call instrumentation,
which is a materially bigger, riskier backend change for a purely
cosmetic client-side state. Client-side inference from the known DAG shape
achieves the same user-visible outcome (SC-003: "identify which node is
currently executing... without reading a separate log") without touching
pipeline execution at all.

**Alternatives considered**: Adding a `node_start` SSE event — rejected
per above; polling node status instead of using the DAG shape — rejected,
strictly worse than an inference that's already exact for every pipeline
shape this project supports (plain DAG, branch, loop).

## 6. Failed-node identification: structured error detail, not message parsing

**Decision**: Give `PipelineExecutionError` (in `errors.py`) optional
`node_id: str | None` and `loop_id: str | None` attributes, set at each of
its two raise sites (`dag_builder/node_types.py`'s node failure,
`dag_builder/loops.py`'s loop-exhaustion failure). In
`_stream_pipeline_run`'s exception handling, thread whichever is set into
`build_error_response(..., details={...})` — the `details` field is
already documented as "extra structured context, varies by error type."

**Rationale**: FR-012 requires marking the *specific* failed node. Today
the only signal available is a prose message
(`f"Node '{node_cfg.id}' failed: {e}"`) — recovering the id client-side
would mean regex-parsing an error string never intended as a machine
contract, which breaks silently the moment the message wording changes.
Attaching the id as structured data is a small change at the two existing
raise sites and uses a field the API already reserves for exactly this
purpose.

**Alternatives considered**: Regex-parsing the message client-side —
rejected as fragile and undocumented coupling to prose; not identifying
the specific failed node at all (only a generic "run failed" state) —
rejected, directly fails FR-012's acceptance scenario.

## 7. CLI live view redraws in place instead of appending a scrolling log

**Decision**: `handlePromptStreaming` in `cli/src/index.ts` is changed to
redraw the same diagram block in place (track the previously-printed line
count, move the cursor up, clear, reprint) as each `AskStreamEvent`
arrives, instead of `console.log`-ing one new line per event as it does
today.

**Rationale**: User Story 3 requires the CLI to show the graph updating
"in place" during a run, matching the web client's live-updating diagram.
The current implementation is an append-only progress log (each
`node_complete`/`loop_iteration` prints a new line and never revisits
earlier output), which cannot show a persistent diagram whose node
statuses change over time.

**Alternatives considered**: Leaving the scrolling log as a secondary,
`verbose`-only detail view alongside the new redrawn diagram — plausible
future enhancement, but out of scope here since the spec's User Story 3
only requires the graph itself to reflect live status, not the log format;
kept as a possible follow-up rather than added speculatively now.

## 8. `RelayAnimator` is retired, not extended

**Decision**: Remove `web/src/relayAnimator.ts` and its `#relay` markup;
`graphView.ts` takes over showing live progress, using the structural
graph diagram instead of a linear stage track.

**Rationale**: `RelayAnimator`'s own docstring already states it is "not a
true DAG renderer" — it lays nodes out in a single fixed left-to-right
row and cannot represent edges, parallel branches, or loops (its
`markComplete` docstring explicitly notes stage completion order may not
match "true execution topology" for parallel nodes). Keeping it running
alongside the new graph view would mean two different, sometimes
contradictory-looking progress indicators on screen for the same run.
Since the new graph view is a strict superset of what `RelayAnimator`
showed (node identity + completion), retiring it avoids that duplication.

**Alternatives considered**: Keeping both — rejected as confusing UI
duplication with no added value once the graph view exists.

## 9. Testing approach matches existing project conventions

**Decision**: Backend changes get pytest coverage in `llm_pipeline/tests`,
matching that package's existing, enforced (`mypy --strict`, `pyright`,
`pytest` all run in CI) conventions. Frontend changes rely on the existing
`tsc --noEmit` CI check plus the quickstart's manual walkthrough — no new
JS test framework (`vitest`, `jest`, etc.) is introduced.

**Rationale**: Neither `cli` nor `web` has a test framework today (CI only
typechecks them — see `.github/workflows/ci.yml`). Introducing one now
would be a tooling decision well beyond this feature's scope; the project
has clearly made a deliberate choice so far to rely on TypeScript's type
system plus manual verification for these two packages.
