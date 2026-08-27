# Feature Specification: Visual DAG Graph Representation

**Feature Branch**: `[001-visual-dag-graph]`

**Created**: 2026-08-07

**Status**: Draft

**Input**: User description: "I want to build visual DAG Graph representation feature."

## Clarifications

### Session 2026-08-07

- Q: When the graph can't load a pipeline's structure, or loses connection to live status mid-run, what should the user see? → A: Inline error marker on the graph itself (e.g. "couldn't load" / "connection lost"), with nodes frozen at their last known status.
- Q: Should this feature include pan/zoom or scroll interaction for viewing large pipeline graphs, or is a fixed-size diagram sufficient for v1? → A: Basic scroll/pan only, no zoom controls.
- Q: Does the web diagram need to support accessibility features like keyboard navigation or screen-reader labels for this feature, or is visual/mouse interaction sufficient for v1? → A: Out of scope for v1 — visual/mouse interaction only; the CLI's text-based graph is the accessible alternative.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View a pipeline's structure as a visual graph in the browser (Priority: P1)

A user opens the web client, picks a pipeline, and sees its structure drawn
as a node-and-edge diagram instead of having to read raw YAML or a text
summary: every node, every plain dependency edge, and every branch/loop
edge, with branch and loop edges visually distinct from plain edges and
labeled with their routing/looping details.

**Why this priority**: This is the core of the feature and the highest-reach
surface — a browser can render an actual graphical diagram, which is what
"visual" primarily means here. Without this, there is no visual
representation at all, only the existing text list.

**Independent Test**: Open the web client, select any pipeline from the
list, and confirm the diagram renders all of that pipeline's nodes and
edges correctly with no prompt sent and no run in progress.

**Acceptance Scenarios**:

1. **Given** a pipeline with only plain `depends_on` edges (e.g.
   `diamond.yaml`-style A → (B, C) → D), **When** the user selects it in the
   web client, **Then** the diagram shows all four nodes and the four
   dependency edges laid out so dependency direction is visually clear.
2. **Given** a pipeline that includes a branch, **When** the user selects
   it, **Then** the diagram shows the branch's routes as edges visually
   distinct from plain dependency edges (e.g. different line style/color),
   each labeled with its condition (or "default").
3. **Given** a pipeline that includes a loop, **When** the user selects it,
   **Then** the diagram shows the loop's `back_to` edge and `exit_to` edge
   as visually distinct from plain edges, labeled with the loop's max
   iteration count.
4. **Given** a pipeline with multiple `output_node` candidates, **When**
   the user views the diagram, **Then** every candidate node is marked as a
   possible output, distinct from non-candidate nodes.

---

### User Story 2 - View a pipeline's structure as a text graph in the terminal (Priority: P2)

A CLI user runs the existing `/pipeline` command (or equivalent) and sees a
text/box-drawing rendering of the same node-and-edge structure — not just
the current flat list of nodes with a `depends_on:` field — with branch and
loop edges visually distinguishable from plain edges in the terminal
output.

**Why this priority**: Delivers the same structural value as User Story 1
on the second surface the project already supports (the terminal CLI),
independently of whether the web client is used. It builds on the same
underlying pipeline-structure data as Story 1 but is a separate,
independently shippable rendering.

**Independent Test**: Run the CLI, select any pipeline, run the graph
command, and confirm the rendered text diagram reflects all nodes and
edges of that pipeline with no prompt sent.

**Acceptance Scenarios**:

1. **Given** a pipeline with plain dependency edges only, **When** the user
   requests the pipeline's graph in the CLI, **Then** the terminal output
   visually lays out nodes and the direction of their dependencies (not
   just a `depends_on:` field per node).
2. **Given** a pipeline with a branch or loop, **When** the user requests
   the graph, **Then** branch/loop edges are marked distinctly from plain
   edges in the text output (e.g. distinct symbols/labels), each labeled
   with its condition, `back_to`/`exit_to` target, or max iterations as
   appropriate.

---

### User Story 3 - Watch live execution progress on the graph (Priority: P3)

While a prompt is being answered, the user watches the same graph (web
diagram or CLI text graph) update in place to show which nodes are
pending, currently running, completed, or failed, which branch route was
actually taken, and how many times a loop has iterated so far — instead of
only seeing a final flat answer or a scrolling log of node completions.

**Why this priority**: This is the most valuable addition on top of the
static graph (Stories 1–2) because it turns the diagram into a live
progress view, but it depends on the static graph already existing and is
not needed to get value from the feature — a user can already get value
from seeing pipeline structure alone.

**Independent Test**: Submit a prompt to a pipeline that has more than one
node and confirm that, while the request is in flight, the graph reflects
node status changes over time, and once the request finishes, the graph
reflects the final state (which nodes ran, which branch route was taken,
final loop iteration count) without needing to re-fetch the static
structure.

**Acceptance Scenarios**:

1. **Given** a multi-node pipeline and streaming enabled, **When** the user
   submits a prompt, **Then** each node visually changes from
   not-started to running to complete as it executes, in the order nodes
   actually finish.
2. **Given** a pipeline with a branch, **When** a run completes, **Then**
   the graph highlights exactly the route that was taken and leaves
   not-taken routes visually unhighlighted.
3. **Given** a pipeline with a loop, **When** a run is in progress,
   **Then** the graph shows the current iteration count against the loop's
   configured max iterations, updating as each iteration completes.
4. **Given** a node fails during a run, **When** the failure occurs,
   **Then** that node is visually marked as failed, distinct from nodes
   that have not started and from nodes that completed successfully.

---

### Edge Cases

- What happens when a pipeline has multiple root nodes (no shared common
  ancestor)? The graph must still lay out and connect all of them clearly
  without implying a false dependency between the roots.
- What happens when a branch target node has no other plain incoming
  edges (it only ever runs via the branch)? It must still appear in the
  graph, connected only via the branch edge, not floating disconnected or
  misread as an always-run node.
- How does the graph represent a loop's `back_to` edge without it being
  mistaken for a plain forward dependency or an unintended cycle, given
  plain DAG cycles are otherwise invalid?
- What happens if the user switches to a different pipeline (web) or
  types `/use <name>` (CLI) while a run is still in progress on the
  previous pipeline's graph? The in-flight run's live state must not leak
  onto the newly selected pipeline's graph.
- What happens when a pipeline has a very large number of nodes/edges? The
  web diagram must remain reachable via basic scroll/pan (no zoom controls
  required) rather than clipping content with no way to see it, and the
  CLI text diagram must wrap rather than becoming illegible.
- What happens when a loop hits `max_iterations` with
  `on_max_iterations: fail` vs `proceed` — does the graph distinguish a
  loop that exited normally from one that exhausted its iterations?
- What happens in the terminal CLI when the terminal window is narrower
  than the rendered diagram?
- What happens if the terminal is resized while a live redraw (User
  Story 3) is in progress? The CLI must re-measure the terminal width and
  do a full repaint of the diagram rather than a partial cursor-relative
  clear based on a stale line count.
- What happens when the pipeline's structure fails to load, or the live
  status connection is lost partway through a run? The graph must show an
  inline error marker rather than a blank or silently frozen-looking
  diagram, and any nodes must stay visible at their last known status
  rather than disappearing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The web client MUST render a selected pipeline's structure as
  a visual node-and-edge diagram, showing every node and every
  `depends_on` edge defined in that pipeline.
- **FR-002**: The CLI MUST render a selected pipeline's structure as a
  text/box-drawing node-and-edge diagram, showing every node and every
  `depends_on` edge, replacing or augmenting the current flat
  `depends_on:` field listing.
- **FR-003**: Both the web diagram and the CLI text diagram MUST visually
  distinguish three edge kinds from one another: plain dependency edges,
  branch route edges, and loop edges (`back_to` and `exit_to` treated as
  distinct from plain edges).
- **FR-004**: Each branch route edge MUST be labeled with its routing
  condition (the route's `when` expression) or marked as the branch's
  default route.
- **FR-005**: Each loop's edges MUST be labeled with the loop's id and its
  configured `max_iterations`.
- **FR-006**: Each node in the diagram MUST display its node id and its
  model/provider identity.
- **FR-007**: Every node listed among a pipeline's `output_node`
  candidates MUST be visually marked as a possible output, distinguishable
  from non-candidate nodes.
- **FR-008**: The user MUST be able to view the graph for any pipeline
  available on the server, not only the currently active/default one, on
  both the web client and the CLI.
- **FR-009**: While a prompt is being processed with streaming enabled,
  the web client and the CLI MUST update the previously rendered graph to
  reflect each node's live execution status (not-started, running,
  complete, or failed) as that status changes, using the existing
  node-completion and loop-iteration streaming events.
- **FR-010**: When a run involving a branch completes, the graph MUST
  indicate which single route was actually taken, distinct from routes
  that were not taken.
- **FR-011**: While a run involving a loop is in progress or after it
  completes, the graph MUST show the loop's current/final iteration count
  against its configured `max_iterations`.
- **FR-012**: If a node fails during a run, the graph MUST mark that node
  as failed, visually distinct from not-started and from
  successfully-completed nodes.
- **FR-013**: Switching to a different pipeline, or starting a new prompt
  against the same pipeline, MUST reset any previously shown live
  execution status so stale status from an earlier or different run is
  never displayed alongside the newly selected pipeline's static
  structure.
- **FR-014**: The graph MUST render without error for every pipeline shape
  already supported by the system: multiple root nodes, branch target
  nodes with no plain incoming edges, and multiple `output_node`
  candidates.
- **FR-015**: If the pipeline's structure fails to load, or the live
  status connection is lost while a run is in progress, the graph MUST
  display an inline error marker (distinct from any node status) rather
  than a blank or silently unresponsive view, and any nodes already drawn
  MUST remain visible at their last known status rather than being
  cleared.
- **FR-016**: When a pipeline's diagram is larger than the visible viewport,
  the web client MUST let the user scroll or pan to reach the full
  diagram; zoom controls are not required for v1.

### Key Entities

- **Pipeline Graph** (called `GraphModel` in design/implementation docs): The
  structural, run-independent representation of one
  pipeline — its nodes, its plain dependency edges, its branch routes, and
  its loops (including each loop's `back_to`/`exit_to` targets and
  `max_iterations`), plus which nodes are output candidates. Sourced from
  the pipeline's existing structural definition; the same data already
  used to produce the current text-only pipeline listing.
- **Node Execution Status**: The transient, per-run state of one node
  during a single in-flight or just-completed prompt — not-started,
  running, complete, or failed. Exists only for the duration of a run and
  is discarded (reset) when a new run starts or a different pipeline is
  selected.
- **Branch Route Outcome**: For a given completed run, which one route of
  a branch was actually taken, out of all the routes defined for that
  branch.
- **Loop Progress**: For a given in-flight or completed run, a loop's
  current iteration count relative to its configured `max_iterations`, and
  whether it exited normally or was still exhausted at the limit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can select any available pipeline and see its full
  node/edge structure — including correctly distinguished branch and loop
  edges — rendered within 2 seconds, on both the web client and the CLI.
- **SC-002**: 100% of the pipeline definitions already shipped in the
  project render their graph with every node and edge present and no
  rendering errors, on both surfaces.
- **SC-003**: While a prompt is running, a user can identify which node is
  currently executing at any given moment by looking at the graph alone,
  without reading a separate log or raw event stream.
- **SC-004**: After a run completes, a user can correctly identify, from
  the graph alone, which node produced the final answer, which branch
  route (if any) was taken, and how many times each loop (if any)
  iterated, in under 10 seconds.
- **SC-005**: For the same pipeline, the set of nodes and edges shown by
  the CLI's text graph and the web client's visual graph are identical in
  structure (same nodes, same edges, same edge classification), so a user
  moving between the two surfaces sees consistent information.

## Assumptions

- The pipeline structural data already exposed for the existing text-based
  pipeline view (nodes, branches with routes, loops, and output-node
  candidates) is sufficient to derive the graph; no new pipeline authoring
  fields are introduced by this feature.
- The existing per-run streaming events (node completion, loop iteration,
  and run completion/failure signals) are sufficient to drive live
  execution status; no new event types are required, though existing
  events may need to be consumed by a new part of the client.
- "Visual" in the browser means an actual graphical node/edge diagram;
  "visual" in the terminal means a text/box-drawing layout that conveys
  the same graph shape, since terminals cannot render arbitrary graphics.
- Layout/readability for very large pipelines relies on basic scroll/pan
  in the browser (no zoom controls) and scrolling/wrapping in the
  terminal; no specific pipeline size limit is mandated.
- Only one run's live status is shown at a time per pipeline view; concurrent
  runs against the same pipeline from the same client session are out of
  scope.
- Historical runs are not persisted for later graph playback; live status
  is only shown for the run currently in flight or the most recently
  completed one, until a new run starts or the user navigates away.
- Accessibility (keyboard navigation, screen-reader labels) for the web
  diagram is out of scope for v1; the CLI's text-based graph (User Story
  2) serves as the accessible alternative view of the same pipeline
  structure.
