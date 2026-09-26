# Implementation Plan: Single-Host Resource-Aware DAG Runner (Platform Stage 1)

**Branch**: `003-validated-dag-orchestration` | **Date**: 2026-08-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-validated-dag-orchestration/spec.md`

> ⚠️ **Needs re-plan (2026-09-23).** Spec
> [004-visual-pipeline-builder](../004-visual-pipeline-builder/spec.md) was
> implemented on the current LangGraph engine, by user choice. This plan's
> removal of `langgraph`, `pipeline_config/` and `dag_builder/` conflicts
> with it. Re-plan to keep LangGraph (resource semaphores inside node
> wrappers) and carry 004's additions over: Ollama options, `system_prompt`,
> `layout`, the editing endpoints, `node_start` streaming, and the React
> Flow client. See [004's plan](../004-visual-pipeline-builder/plan.md#consequences-for-spec-003).

## Summary

Replace the existing service's LangGraph execution engine and per-node
`model:` schema with a resource-aware asyncio scheduler over an
alias-indirected schema, and add a second provider tier (an in-process
heavy model) alongside the existing HTTP-served fast models.

Three things drive every design decision below:

1. **Resource-aware scheduling is the hard part and the reason for the
   rewrite.** LangGraph schedules by graph topology alone; it has no
   concept of steps contending for a shared accelerator across
   *different* concurrent runs. That cross-run serialization (FR-027,
   FR-028) cannot be expressed as graph structure, so the scheduler
   becomes first-party code with `graphlib` for validation and
   `asyncio.Semaphore` for capacity.
2. **The heavy model's lease must outlive its awaiter.** `asyncio.to_thread`
   does not stop the underlying thread when the awaiting task is
   cancelled, so a naive `async with semaphore:` releases the accelerator
   while inference is still running — exactly the corruption FR-031/FR-038
   forbid. This needs a deliberate shield-and-drain pattern, not a plain
   context manager.
3. **Everything is deliberately replaceable at Stage 2.** In-process heavy
   model, single-request execution, process-local semaphores, in-memory
   state. The spec records these as knowing compromises; the module
   boundaries below are drawn so Stage 2 swaps implementations rather
   than restructuring.

## Technical Context

**Language/Version**: Python 3.11+ (`requires-python = ">=3.11"`; CI and
Docker run 3.12). Unchanged.

**Primary Dependencies**: Retained — FastAPI, Pydantic, PyYAML, Jinja2,
`uv`. **Added** — `httpx` (already an indirect dep; becomes direct for
the Ollama adapter). **Added, optional extra** — `airllm`, `torch`.
**Removed** — `langgraph`, `langchain-core`, `langchain-ollama`, and the
`langchain-openai`/`anthropic`/`google-genai` extras. `graphlib` is
standard library.

**Storage**: None. Run state lives in memory for the duration of the
request (an explicit Stage 1 compromise; Stage 2 introduces Postgres).
Workflow definitions are YAML files on disk, read-only.

**Testing**: pytest + pytest-asyncio, matching `llm_pipeline/tests`'
existing conventions. New suites for schema validation, graph validation,
template restriction, the scheduler, the resource pool (including
cross-run contention and deadlock ordering), provider routing, and the
AirLLM cancellation/lease-drain behavior. AirLLM is mocked throughout —
CI never downloads weights.

**Target Platform**: One FastAPI process (single worker — mandatory while
the heavy model is in-process, FR-034/FR-037), an external Ollama server
over HTTP, and optionally one accelerator shared between them.

**Project Type**: Single Python backend service with two thin TypeScript
clients (CLI, web) over its HTTP contract.

**Performance Goals**: N independent branches on non-competing resources
finish within 1.5x the slowest branch (SC-003). A health check answers
within 1s while the heavy model is generating (SC-007) — the real
assertion being that heavy inference never occupies the event loop.

**Constraints**: `mypy --strict` and `pyright` (strict) must keep passing;
new suppressions permitted only in the existing narrow form used for
optional lazily-imported SDKs (now `airllm`/`torch`). No step may run
before its workflow fully validates (FR-012). Resource leases must never
be released early (FR-031).

**Scale/Scope**: Single-host, single-tenant, single worker process.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template — no ratified
principles, so no formal gates. This plan holds itself to the project's
observable conventions plus the brief's stated invariants:

| Principle | Status |
|---|---|
| Protocol-based abstraction; adapters behind one interface | ✅ `LLMProvider` Protocol retained verbatim; AirLLM is a third implementation |
| Validation in one place, reused by every entry path | ✅ One `validate_workflow()`; loader, startup check, and executor all call it |
| Dependency injection over module globals | ✅ `ResourcePool`, `WorkflowRegistry`, provider router constructed in lifespan, held on `app.state` |
| Strict typing, no new suppression classes | ✅ Verified post-design; only `airllm`/`torch` gain the existing optional-import treatment |
| Brief §36 "never" invariants (server-controlled model IDs, no generated shell/network access, no unvalidated execution) | ✅ Enforced from Stage 1 — see FR-048/FR-049/FR-012 |

### Gate findings requiring resolution

Two surfaced during Phase 0 and are resolved rather than waived:

**1. Two shipped workflows are inexpressible in the Stage 1 schema.**
`support-router.yaml` uses conditional routing (`branches`) and
`iterative-refinement.yaml` uses iteration (`loops`) plus a
`{% if %}` template statement that FR-014 forbids outright. Stage 1 has
neither construct. Resolution: migrate the three pure-DAG workflows,
park the two with a documented target stage. SC-010 was amended to
require exactly this rather than a silent drop. See research.md §8 —
this also surfaces an open roadmap question, since the brief defines a
`condition` node type but **no loop construct at any stage**.

**2. The migration blast radius is larger than the spec implied.**
Removing branches and loops invalidates ~800 lines of already-implemented
TypeScript graph rendering (`packages/client/src/graphModel.ts`,
`web/src/graphView.ts`) built for those constructs. The spec's
"terminal and browser clients must be migrated" assumed a contract
update; this is closer to a feature amputation. Resolution: simplify
rather than delete — the renderers lose their branch/loop paths and
become pure-DAG layout. Net deletion, not net new work. See research.md §9.

Neither is a violation to justify — both are scope facts now recorded.
**Complexity Tracking is empty.**

**Post-Phase-1 re-check**: all five principles hold under the concrete
design in data-model.md and contracts/. The scheduler and resource pool
are injected, not global; validation has exactly one entry point; the
provider Protocol is unchanged. Gate passes.

## Project Structure

### Documentation (this feature)

```text
specs/003-validated-dag-orchestration/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── workflow-schema.md
│   └── http-api.md
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
llm_pipeline/llm_pipeline/
├── workflow/                    NEW — replaces pipeline_config/
│   ├── schema.py                  Pydantic models, extra="forbid"
│   ├── validation.py               graphlib DAG checks + resource/alias checks
│   ├── templates.py                 restricted-Jinja AST validation + strict render
│   ├── loader.py                     safe_load -> validate -> WorkflowDefinition
│   └── registry.py                    name -> validated definition, loaded at startup
├── runtime/                     NEW — replaces dag_builder/
│   ├── resources.py               ResourcePool; ordered multi-acquire; lease drain
│   ├── scheduler.py                ready-set loop, fan-out/fan-in, parallelism cap
│   ├── executor.py                  one step: render -> route -> time -> record
│   └── failures.py                   FailureCategory + exception classification
├── providers/
│   ├── base.py                    KEEP — LLMProvider Protocol, ProviderType
│   ├── ollama.py                   REWRITE — httpx, drops langchain-ollama
│   ├── airllm.py                    NEW — thread-offloaded, lease-safe
│   ├── router.py                     replaces registry.py; alias -> provider
│   └── resilience.py                  KEEP timeout; retry/breaker unwired (Stage 2)
├── api_schemas.py               REWRITTEN — new run/inspect contract
├── routers/
│   ├── health.py                  + backend availability reporting
│   └── runs.py                     replaces ask.py
├── settings.py                  + airllm model/strictness/resource config
├── auth.py                      KEEP unchanged
├── rate_limit.py                KEEP unchanged
├── error_handling.py            KEEP + new categories
├── logging_context.py           KEEP + step-level structured fields
└── main.py                      lifespan: registry, pool, providers, worker guard

DELETED: dag_builder/, pipeline_config/, state.py, safe_eval.py, history.py

llm_pipeline/pipelines/          3 migrated; 2 moved to deferred/
llm_pipeline/tests/              new suites per Technical Context

packages/client/src/             types.ts rewritten; graphModel.ts simplified
cli/src/, web/src/               formatter/render/graphView: branch-loop paths removed
```

**Structure Decision**: `workflow/` and `runtime/` replace
`pipeline_config/` and `dag_builder/` as new packages rather than
in-place edits — the old modules are built around LangGraph state
reducers and conditional-edge wiring that have no analogue here, so
rewriting them in place would mean deleting nearly every line anyway
while carrying the old names' assumptions forward. The split matters for
Stage 2: `runtime/` is the layer that gets replaced by durable workers,
while `workflow/` (schema, validation, templates) survives intact.

## Complexity Tracking

No Constitution Check violations. Section intentionally empty.
