# Feature Specification: Visual Pipeline Builder with Per-Node Configuration and Live Run Status

**Feature Branch**: `feature/yaml_based_pipelines` (no dedicated branch was created)

**Created**: 2026-09-23

**Status**: Implemented

**Scope**: A user-requested track outside the six platform stages — see
[ROADMAP.md](../ROADMAP.md). Builds on the current LangGraph engine and
workflow schema, not on the Stage 1 schema planned in spec 003.

**Input**: "I want to be able to configure each node from web and CLI. I
want to be able to create LangGraph visually, configure each node —
temperature, model name, prompts and anything useful for Ollama models.
When a pipeline is triggered I want to visually see which node is running.
I want to be able to save pipeline and node configuration."

## Clarifications

### Session 2026-09-23

- Q: Spec 003 (planned, not started) replaces LangGraph and changes the
  schema. How does this relate to it? → A: No preference was stated, so the
  recommended option applies: keep LangGraph and build on the current engine
  and schema now; spec 003 is marked as needing a re-plan.
- Q: Web technology for the editor? → A: React + React Flow.
- Q: How much of branches/loops does the visual editor handle? → A: Nodes
  and dependency edges are edited on the canvas; branches and loops are
  drawn on the canvas and edited in the side panel; all are preserved on
  save.
- Q: What does "save" cover? → A: Saving pipelines to server-side YAML,
  reusable node presets, and YAML import/export.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Build a pipeline visually (Priority: P1)

An author opens the web client, starts a new pipeline, adds LLM nodes,
connects them by drawing edges, configures each node, and saves it. The
saved pipeline is immediately runnable from the web client and the CLI.

**Independent Test**: Build A → (B, C) → D in the browser, save, and confirm
the YAML file on the server matches what was configured.

**Acceptance Scenarios**:

1. **Given** editing is enabled, **When** the author adds nodes and draws
   edges, **Then** each edge becomes a dependency of its target node.
2. **Given** a draft with an error (e.g. a prompt referencing a node that
   isn't a dependency), **When** the author edits it, **Then** the editor
   shows the server's message and marks the offending node, and saving and
   running are disabled.
3. **Given** a valid draft, **When** it is saved, **Then** the file is
   written exactly as validated and the next run uses it without a restart.
4. **Given** someone else saved the same pipeline after it was loaded,
   **When** the author saves, **Then** the save is refused rather than
   overwriting their change.

### User Story 2 — Configure every node, from web and CLI (Priority: P1)

For each node the author sets the model, temperature, system prompt,
prompt template, and Ollama generation options, from either the web
inspector or CLI commands.

**Acceptance Scenarios**:

1. **Given** a node, **When** the author sets `num_ctx`, `top_p`, `seed`,
   `stop`, `keep_alive`, `format` or any other supported Ollama option,
   **Then** the saved pipeline carries it and the model is called with it.
2. **Given** a node on a non-Ollama provider, **When** Ollama options are
   set, **Then** validation rejects them rather than ignoring them.
3. **Given** a misspelled setting, **When** validated, **Then** it is
   rejected naming the field.
4. **Given** a change made in the CLI and saved, **When** the pipeline is
   opened in the web editor, **Then** the change is visible, and vice versa.

### User Story 3 — See which node is running (Priority: P1)

When a pipeline runs, each node shows whether it is idle, running, done or
failed, from events the server sends as nodes actually start and finish.

**Acceptance Scenarios**:

1. **Given** two nodes with no dependency between them, **When** both
   start, **Then** both show as running at the same time.
2. **Given** a node that depends on others, **When** they complete, **Then**
   it shows as running only once the server reports it started.
3. **Given** a node that fails, **When** the error arrives, **Then** that
   specific node shows as failed.

### User Story 4 — Reuse node settings and move pipelines as files (Priority: P2)

The author saves a node's settings as a named preset and applies it to
other nodes; exports a pipeline as YAML and imports YAML files.

**Acceptance Scenarios**:

1. **Given** a saved preset, **When** it is applied to a node, **Then** the
   node gets a copy of its settings; later changes to the preset do not
   change the node.
2. **Given** an exported file, **When** it is imported, **Then** it yields
   the same pipeline.

### Edge Cases

- Ollama unreachable while saving: the save is refused (the model can't be
  verified), except for models the stored pipeline already uses.
- Saving over a hand-written file with comments: the comments and layout
  are kept (FR-012).
- Editing enabled with CORS `*` and no API key: editing is refused, and
  clients show why (FR-014).
- Editing disabled on the server: pipelines are shown read-only; running
  still works.
- A run started with unsaved changes: the draft is saved first; unsaved
  drafts are never run.

## Requirements *(mandatory)*

- **FR-001**: Nodes MUST support per-node model, temperature, system prompt,
  prompt template, editor layout, and (Ollama only) generation options:
  `top_p`, `top_k`, `tfs_z`, `repeat_penalty`, `repeat_last_n`, `seed`,
  `stop`, `mirostat`, `mirostat_eta`, `mirostat_tau`, `num_ctx`,
  `num_predict`, `num_gpu`, `num_thread`, `keep_alive`, `format`.
- **FR-002**: Unknown fields, out-of-range values, and Ollama options on
  other providers MUST be rejected, never ignored.
- **FR-003**: Client-submitted pipelines and presets MUST pass the same
  validator as files loaded from disk before anything is written.
- **FR-004**: A client-selected model MUST be installed on the configured
  Ollama server or listed in the server's cloud-model allowlist; if this
  cannot be verified, the save MUST be refused.
- **FR-005**: Saving MUST be disabled unless the server enables it, and MUST
  require the same authentication as every other endpoint.
- **FR-006**: Saves MUST be atomic and MUST be refused if the file changed
  since the client loaded it.
- **FR-007**: The server MUST emit a start event for every node as it begins
  its model call, including once per loop iteration.
- **FR-008**: The web client MUST provide a canvas to add, connect, move and
  delete nodes, and a panel to configure nodes, branches, loops and
  pipeline settings.
- **FR-009**: The CLI MUST provide commands to load, inspect, change,
  validate, save, import and export pipelines and presets.
- **FR-010**: Both clients MUST show live per-node status during a run.

#### Added 2026-09-24 (follow-up improvements)

- **FR-011**: The server MUST stream each node's generated text as it is
  produced, and announce a retry as a new start so clients discard partial
  text from a failed attempt. Both clients MUST show it live.
- **FR-012**: Saving over an existing file MUST keep its comments and
  layout; an unchanged save MUST leave the file byte-identical. If a
  comment-preserving write would not mean exactly the validated
  definition, the file MUST be written canonically and the client told.
- **FR-013**: Pipelines and presets MUST be deletable from web and CLI,
  recoverably (moved aside, not erased). The server's default pipeline
  MUST NOT be deletable.
- **FR-014**: Editing MUST stay off while CORS allows every origin and no
  API key is required, with the reason reported to clients.
- **FR-015**: Clients SHOULD show an Ollama model's limits (max context,
  size), and validation SHOULD warn — without blocking — when `num_ctx`
  exceeds the model's maximum context.
- **FR-016**: The web editor MUST support undo/redo and use in-app dialogs.

#### Added 2026-09-25 (layout, messages view, pipeline settings)

- **FR-017**: The web canvas lays pipelines out top to bottom; panels are
  resizable and the sizes are remembered per browser. Clients can switch
  between the configuration view and a log of the messages each node sent
  and received during a run (whole run, and per node).
- **FR-018**: A pipeline MAY declare defaults every node inherits (model,
  temperature, Ollama options, system prompt, reasoning stripping); a
  node's own settings win. Every `llm_call` node MUST end up with a model.
- **FR-019**: Conversation history MUST be configurable per pipeline:
  turns kept, character budget, intro line, turn format, node outputs to
  remember with each turn, and an optional model that summarizes turns
  that no longer fit. A failed summary MUST NOT fail the run. The default
  settings MUST produce exactly the original history text.
- **FR-020**: Nodes MAY opt out of seeing the history; templates can use
  `{{ question }}` and `{{ history }}` besides `{{ input }}`.
- **FR-021**: A pipeline MAY cap how many nodes call models at once.
- **FR-022**: Templates MUST be parsed and rendered in a sandbox, because
  editor clients can save them. (Found during this work: templates were
  rendered by plain Jinja, which let a saved template reach arbitrary
  Python classes.)
- **FR-023**: Models used by defaults and by the summarizer MUST pass the
  same allowlist as node models.

#### Added 2026-09-25 (node library, duplicate)

- **FR-024**: A node MUST be savable to a library with everything it runs
  with — model and options, system prompt, prompt template, history and
  reasoning settings; settings it inherits from pipeline defaults are
  written out — and addable to any pipeline from web and CLI, including
  as the first node of a new pipeline. Replacing a saved node asks first.
  Saved prompts MUST parse; their node references are fitted to where the
  node lands, and anything left unresolved is reported by the pipeline's
  validation.
- **FR-025**: A node MUST be duplicable (web button and ⌘D/Ctrl+D, CLI
  `/dup`): same settings and inputs under a new id; branches, loops and
  output settings stay with the original.

#### Added 2026-09-26 (iteration tools)

- **FR-026**: Node results MUST carry the token usage their backend reports
  and the context window in effect (the node's `num_ctx`, else the loaded
  Ollama model's). Both clients MUST show it and warn when a prompt filled
  the window — Ollama truncates such prompts silently.
- **FR-027**: A run MAY be repeated from one node: it and every node after
  it run again, the others reuse their previous outputs (on their first
  execution only). Clients offer it for the latest run; the new answer
  replaces the old one in the conversation.
- **FR-028**: Clients MUST be able to preview what a node would receive,
  rendered by the server exactly as a run renders it, from an unsaved
  definition. Gated like editing (it renders client-supplied templates).
- **FR-029**: A pipeline MAY carry test cases (message + expectations:
  contains, not_contains, a `check` condition, or a `judge` requirement
  graded by a judge model). Clients MUST run them on the draft and compare
  up to three model variants for a node, with per-case results and
  per-variant totals. Test runs are gated like editing and every variant
  passes validation and the model allowlist.
- **FR-030**: Pipelines MUST be reachable through an OpenAI-compatible API
  (`GET /v1/models`, `POST /v1/chat/completions`, streaming), with the same
  authentication and rate limits as `/ask` and OpenAI-shaped errors.
- **FR-031**: The web client SHOULD keep conversations in the browser
  (per pipeline, the latest 30), resuming the latest after a reload.

## Success Criteria *(mandatory)*

- **SC-001**: A four-node pipeline with a fan-out and a fan-in can be built,
  configured and saved entirely in the browser, and then run.
- **SC-002**: During that run, the two parallel nodes are both shown as
  running at the same time.
- **SC-003**: A setting changed and saved from the CLI appears in the web
  editor after reloading, and the reverse.
- **SC-004**: Zero invalid definitions or disallowed models are written to
  disk (covered by automated tests).

## Assumptions

- Node positions are stored in the pipeline YAML (`layout`) — the engine
  ignores them.
- Presets are copied into nodes, not referenced, so what a pipeline file
  says is exactly what runs.
- Deleting, token-level streaming and comment preservation were added in a
  follow-up on 2026-09-24 (FR-011–FR-016).
- Pipeline-wide settings and the template sandbox followed on 2026-09-25
  (FR-017–FR-023). The server stays stateless: clients send the earlier
  turns, including remembered node outputs, with every request.
- The node library reuses presets (API and `presets/` directory
  unchanged); clients call them saved nodes. Saved nodes stay copies, like
  presets always were.
- Structured (JSON) outputs and non-LLM node types (transform, retrieval,
  sub-pipeline) were considered on 2026-09-26 and left to Stages 3–4, where
  the roadmap places them. Run history is kept in the browser rather than
  on the server so it doesn't pre-empt Stage 2's run store.
