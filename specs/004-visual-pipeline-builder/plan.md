# Implementation Plan: Visual Pipeline Builder (spec 004)

**Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

## Summary

Extend the existing LangGraph-based service and both clients rather than
wait for spec 003's engine rewrite:

- **Schema**: `NodeModelConfig.options` (Ollama options, one shared
  `OllamaOptions` model in `providers/base.py`), `NodeConfig.system_prompt`
  and `NodeConfig.layout`; `extra="forbid"` on every pipeline model.
- **Providers**: `LLMProvider.generate(prompt, system=None)`; the Ollama
  adapter moves from `OllamaLLM` to `ChatOllama` so the system prompt is a
  real system message and the options pass straight through.
- **Live status**: each LLM node writes a `node_start` payload through
  LangGraph's injected `StreamWriter`; `/ask/stream` requests
  `stream_mode=["updates", "custom"]` and forwards it as an SSE event.
- **Persistence**: `ModelCatalog` (model allowlist) and `PipelineStore`
  (validate → allowlist → revision check → atomic write → cache
  invalidation), both built in `lifespan` and injected via `app.state`;
  endpoints in `routers/editing.py`. `PipelineCache` reloads a pipeline
  when its file's mtime/size changes.
- **Clients**: `@llm-pipeline/client` gains the definition types, editing
  API methods, `node_start` handling in the live graph state, and
  `draftOps` (pure edit operations shared by web and CLI). The web client
  is rewritten in React + React Flow; the CLI gains edit commands.
- **Pipeline settings (2026-09-25)**: `PipelineDefinition.defaults`
  (`NodeDefaults`) and `.history` (`HistoryConfig`), `NodeConfig.include_history`
  and `.strip_reasoning`, `ExecutionConfig.max_concurrency` (passed as
  LangGraph's `RunnableConfig.max_concurrency`). Inheritance is resolved in
  one place, `pipeline_config/effective.py`. `history.prepare_input` builds
  `{{ input }}`, `{{ question }}` and `{{ history }}` from the client's turns;
  the summarizer is injected by `/ask` so `history.py` stays model-free.
  All Jinja parsing and rendering goes through `pipeline_config/templates.py`
  (an `ImmutableSandboxedEnvironment`).
- **Iteration tools (2026-09-26)**: providers may return a `Generation`
  (text + `Usage`); the run endpoints add the context window from
  `ModelCatalog.running_context` (Ollama's `/api/ps`). `rerun.py` decides
  which outputs a re-run reuses; nodes replay them from state on their first
  execution. `preview.py` renders a node's prompt through the same
  `render_node_prompt` a run uses. `evaluation.py` runs test cases
  (`tests:` block, `Eval*` models) for `POST /pipelines/test`.
  `routers/openai_compat.py` maps OpenAI chat requests onto `run_ask` /
  `pipeline_events`. Tests run against `tests/fixtures/pipelines/`, copies of
  the shipped examples, so local edits to `pipelines/` can't change them.

## Constitution Check

| Principle | Status |
|---|---|
| I. Protocols, not implementations | ✅ `LLMProvider` stays the only interface; `system` is part of it for every adapter. Ollama options live on `ModelSpec` and are rejected for other providers at validation rather than branched on by consumers. |
| II. One source of validation truth | ✅ Client-submitted definitions go through `PipelineDefinition.model_validate` — the loader's validator. Clients do no semantic validation; they display the server's verdict. The model allowlist is a separate *policy* gate for client input, not a second schema validator. |
| III. Inject, never globals | ✅ `ModelCatalog` and `PipelineStore` are constructed in `lifespan` and read from `app.state`. |
| IV. Strict typing | ✅ `mypy --strict`, `pyright` (no new errors) and `tsc --noEmit` pass; no new suppressions. |
| V. Fail closed at trust boundaries | ⚠️ See Complexity Tracking — model identities now arrive from clients. |
| VI. One stage at a time | ⚠️ See Complexity Tracking — this track sits outside the stage sequence. |

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected |
|---|---|---|
| **V** — clients choose model identities and write pipeline files. | Configuring the model per node from web and CLI is the core request. Mitigations: writes are off unless `PIPELINE_EDITING_ENABLED=true`, need the API key, and every model must be installed on the configured Ollama server or listed in `EDITOR_CLOUD_MODELS`; the check fails closed when Ollama is unreachable. Only models the stored file already used are accepted without the check. | Free-text model names (no allowlist) — rejected: lets a client make the server call arbitrary models. Clients editing only prompts — rejected: doesn't meet the request. |
| **VI** — feature outside any roadmap stage; DAG visualization was slated for Stage 3. | Explicit user request. Recorded as its own roadmap track. | Waiting for Stage 3 — rejected by the user's sequencing choice. |
| Process-local write lock per pipeline file. | Serializes concurrent saves within one process. Across several worker processes the revision check still catches conflicting saves, but check-then-write is not atomic across processes. | A file lock or a database — deferred to Stage 2, which introduces durable storage anyway. |
| New dependency `ruamel.yaml` (2026-09-24), used only to write. | Keeps hand-written comments and layout when saving (FR-012); PyYAML `safe_load` stays the only loader and validation path, and every write is re-validated. | Canonical rewrites that drop comments — rejected once editors started touching the shipped, heavily commented pipelines. |
| Editing refused with CORS `*` and no API key (2026-09-24). | Fail closed (V): otherwise any website open in the user's browser could rewrite pipelines on a local server. | Relying on documentation to set origins — rejected: docker-compose itself shipped the unsafe combination. |
| Sandboxed templates (2026-09-25). | Templates now come from editor clients; plain Jinja let a saved template reach every loaded Python class, i.e. run code on the server (V). | Restricting templates to `{{ var }}` substitution — rejected: loops rely on `{% if x is defined %}`. |
| OpenAI-compatible endpoint (2026-09-26). | Lets existing chat tools use pipelines. It is a synchronous surface over the same run as `/ask` (shared `pipeline_events`), with the same auth and rate limits — not the MCP tool catalog the roadmap places after Stage 2. | Waiting for the MCP track — rejected: MCP's tools (async submit/poll/cancel) need Stage 2; a chat endpoint doesn't. |
| Test cases and model comparison (2026-09-26). | Evaluation suites and dashboards are Stage 5/6 platform features; these are per-pipeline editor checks, stored in the pipeline file (the engine ignores them), run synchronously and never persisted. Runs use client-chosen models and templates, so they're gated like saving and allowlisted per variant. | A separate evaluation service — rejected: that is Stage 5's scope. |
| Browser-side run history (2026-09-26). | Keeps conversations across reloads without a server store, so Stage 2's durable run store isn't pre-empted or constrained. | Server-side history files — rejected: a Stage 2 capability. |

## Consequences for spec 003

Spec 003's plan deletes `langgraph`, `pipeline_config/` and `dag_builder/`
and replaces the schema with alias-indirected steps. That plan needs
re-planning before implementation:

- Keep LangGraph for topology; put the process-wide resource semaphores
  inside node wrappers (the same place `node_start` is emitted now).
- Carry this spec's additions over: Ollama options, `system_prompt`,
  `layout`, the editing endpoints, `node_start` streaming (spec 003 had
  deferred progress streaming to Stage 2 — it now exists), and the
  React Flow client.
