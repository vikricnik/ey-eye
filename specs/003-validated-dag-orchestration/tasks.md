---
description: "Task list for Single-Host Resource-Aware DAG Runner (Platform Stage 1)"
---

# Tasks: Single-Host Resource-Aware DAG Runner (Platform Stage 1)

**Input**: Design documents from `/specs/003-validated-dag-orchestration/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. SC-009 explicitly requires automated coverage of workflow validation, scheduling behavior, resource locking, and provider routing.

**Organization**: Grouped by user story. Note that this is a **rewrite of an existing engine**, not a greenfield build — Phase 2 removes the LangGraph engine, so the service is intentionally non-functional between the end of Phase 2 and the end of Phase 3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1, US2, US3 — maps to spec.md user stories

## Path Conventions

Python service: `llm_pipeline/llm_pipeline/`, tests `llm_pipeline/tests/`.
TypeScript clients: `packages/client/src/`, `cli/src/`, `web/src/`.
Paths below are repo-relative.

---

## Phase 1: Setup

**Purpose**: Dependency and configuration changes that everything else builds on.

- [ ] T001 Rewrite dependencies in `llm_pipeline/pyproject.toml`: remove `langgraph`, `langchain-core`, `langchain-ollama` and the `openai`/`anthropic`/`gemini` extras; promote `httpx` to a direct dependency; add an `airllm` optional extra (`airllm`, `torch`); replace the langchain mypy/pyright override blocks with equivalents for `airllm.*` and `torch.*`
- [ ] T002 [P] Extend `llm_pipeline/llm_pipeline/settings.py` with `airllm_model`, `airllm_required` (bool, default false), `airllm_compression`, and `resource_capacities` (server-owned resource name → capacity, per data-model.md §4)
- [ ] T003 [P] Create empty packages `llm_pipeline/llm_pipeline/workflow/__init__.py` and `llm_pipeline/llm_pipeline/runtime/__init__.py`
- [ ] T004 Run `uv sync` in `llm_pipeline/` and confirm `uv run pytest`, `uv run mypy .`, and `uv run pyright` all still execute on the untouched tree, establishing a green baseline before the rewrite

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The workflow schema, validation core, resource pool, and failure taxonomy every story needs — plus removal of the old engine.

**⚠️ CRITICAL**: No user story work can begin until this phase completes. T015 deliberately breaks the running service; it is restored by T028.

- [ ] T005 Implement `llm_pipeline/llm_pipeline/workflow/schema.py`: `ModelAlias`, `NodeSpec`, `WorkflowDefinition` per data-model.md §1, all with `ConfigDict(extra="forbid")`, the `^[A-Za-z_][A-Za-z0-9_]*$` id pattern, and the validator rejecting `keep_alive` on an `airllm` alias
- [ ] T006 [P] Implement `llm_pipeline/llm_pipeline/runtime/failures.py`: the `FailureCategory` enum and a single `classify(exc) -> FailureCategory` function per data-model.md §3
- [ ] T007 [P] Replace `llm_pipeline/llm_pipeline/errors.py` with `WorkflowValidationError`, `WorkflowNotFoundError`, and `StepExecutionError` (carrying `node_id` and `category`); delete the `loop_id` field, which has no referent now that loops are gone
- [ ] T008 Implement the validation entry point `validate_workflow()` in `llm_pipeline/llm_pipeline/workflow/validation.py` with the checks the scheduler cannot run without: duplicate ids, unknown alias, unknown/self/duplicate dependency, output node exists, and cycle detection via `graphlib.TopologicalSorter.prepare()` reporting `CycleError.args[1]` verbatim
- [ ] T009 Implement `llm_pipeline/llm_pipeline/workflow/templates.py` with reference extraction (returning the `input.FIELD` and `nodes.STEP.output` sets) and strict rendering via `StrictUndefined` — the AST allowlist that rejects forbidden constructs is T031
- [ ] T010 Implement `llm_pipeline/llm_pipeline/workflow/loader.py`: `yaml.safe_load` → `WorkflowDefinition.model_validate` → `validate_workflow`, raising `WorkflowValidationError` with the source filename attached
- [ ] T011 Implement `llm_pipeline/llm_pipeline/workflow/registry.py`: scan the pipelines directory at startup, load and validate every `*.yaml`, expose name → definition lookup, and collect per-file failures for startup reporting
- [ ] T012 Implement `ResourcePool` in `llm_pipeline/llm_pipeline/runtime/resources.py` with one `asyncio.Semaphore` per configured resource and a `lease(names)` async context manager that **sorts names before acquiring** and releases in reverse (research.md §2). `drain_lease` is T042
- [ ] T013 Update `llm_pipeline/llm_pipeline/error_handling.py` to map each `FailureCategory` to an `ErrorCode` (adding the missing codes — `ErrorResponse` already has `code`, so no `category` field) and map the new exception types to the status codes in contracts/http-api.md
- [ ] T014 Update `llm_pipeline/llm_pipeline/logging_context.py` to carry per-step structured fields (workflow, request id, node id, provider, alias, physical model, resource wait, execution time, outcome, category) per FR-053
- [ ] T015 Remove the LangGraph engine: delete `llm_pipeline/llm_pipeline/dag_builder/`, `pipeline_config/`, `state.py`, `safe_eval.py`, `history.py`, `routers/ask.py`, `providers/registry.py`, and the now-obsolete tests `test_dag_builder.py`, `test_pipeline_config.py`, `test_safe_eval.py`, `test_history.py`, `test_streaming.py`
- [ ] T016 Rewrite `llm_pipeline/llm_pipeline/main.py` lifespan to construct the `WorkflowRegistry`, `ResourcePool`, and provider router and store them on `app.state`, logging the startup validation summary from T011

**Checkpoint**: Schema, validation core, resource pool, and failure taxonomy exist. The service does not serve requests yet.

---

## Phase 3: User Story 1 - Run a predefined workflow with parallel, resource-aware execution (Priority: P1) 🎯 MVP

**Goal**: A stored workflow runs end to end, returning the final output plus per-step provider, model, wait time, and execution time — with independent branches overlapping and fan-in waiting for all parents.

**Independent Test**: `POST /v1/workflows/{name}/run` against a workflow with one fan-out and one fan-in returns the full response shape, with the two independent steps demonstrably overlapping in wall-clock time.

### Tests for User Story 1

- [ ] T017 [P] [US1] Scheduler fan-out/fan-in ordering test in `llm_pipeline/tests/test_scheduler.py` — a fan-in step must not start until every parent has succeeded, and independent steps must overlap (fake providers with controlled delays, no network)
- [ ] T018 [P] [US1] Parallelism-cap test in `llm_pipeline/tests/test_scheduler.py` — with `max_parallel_nodes: N` and more than N eligible steps, observed concurrency never exceeds N (FR-022)
- [ ] T019 [P] [US1] Fail-fast test in `llm_pipeline/tests/test_scheduler.py` — one failing step stops further dispatch, and the raised error carries that step's id and category (FR-023, FR-024)
- [ ] T020 [P] [US1] Provider routing test in `llm_pipeline/tests/test_provider_router.py` — each alias dispatches to its declared provider; an unknown provider raises `CONFIGURATION` (FR-039)
- [ ] T021 [P] [US1] Contract test in `llm_pipeline/tests/test_run_endpoint.py` asserting the `POST /v1/workflows/{name}/run` response matches contracts/http-api.md, including `resource_wait_ms` and `execution_ms` as separate fields

### Implementation for User Story 1

- [ ] T022 [P] [US1] Trim `ProviderType` in `llm_pipeline/llm_pipeline/providers/base.py` to `ollama | airllm`, keeping the `LLMProvider` Protocol unchanged; delete `openai.py`, `anthropic.py`, `gemini.py`, `copilot.py`
- [ ] T023 [US1] Rewrite `llm_pipeline/llm_pipeline/providers/ollama.py` against `httpx.AsyncClient`: `POST /api/generate` with `stream: false`, `options: {temperature, top_p, num_predict}`, top-level `keep_alive`, per-alias timeout, mapping `httpx.ConnectError` → `PROVIDER_UNAVAILABLE` and `httpx.ReadTimeout` → `PROVIDER_TIMEOUT` (research.md §5)
- [ ] T024 [US1] Implement `llm_pipeline/llm_pipeline/providers/router.py` resolving a `ModelAlias` to a provider instance and rejecting unknown providers; replaces the deleted `registry.py`
- [ ] T025 [US1] Implement `llm_pipeline/llm_pipeline/runtime/executor.py`: render one step's prompt, acquire nothing (the scheduler owns leases), call the provider under its timeout, and record `NodeExecution` timings and outcome per data-model.md §3
- [ ] T026 [US1] Implement `llm_pipeline/llm_pipeline/runtime/scheduler.py`: the ready-set loop that acquires each step's lease **before** invoking the executor — so `resource_wait_ms` is measurable — honours `max_parallel_nodes`, joins fan-in on all parents, and fails fast
- [ ] T027 [P] [US1] Rewrite `llm_pipeline/llm_pipeline/api_schemas.py` with `RunWorkflowRequest`, `NodeResultDTO`, `RunWorkflowResponse`, `WorkflowSummary`, `WorkflowDetail`, `BackendStatus`, `HealthResponse` per data-model.md §5
- [ ] T028 [US1] Implement `llm_pipeline/llm_pipeline/routers/runs.py` with `POST /v1/workflows/{name}/run`, behind the existing auth and rate-limit dependencies
- [ ] T029 [US1] Implement `llm_pipeline/llm_pipeline/routers/workflows.py` with `GET /v1/workflows` and `GET /v1/workflows/{name}`
- [ ] T030 [US1] Rewrite `llm_pipeline/llm_pipeline/routers/health.py` for the new shape — `status` and `ollama_reachable`; the `backends` array is completed in T048
- [ ] T031 [US1] Enforce input validation in `llm_pipeline/llm_pipeline/routers/runs.py`: `inputs` keys must match `input_fields` exactly, rejecting missing and undeclared fields by name, plus the input-size and rendered-prompt-size limits (FR-043, FR-051)

**Checkpoint**: A valid workflow runs end to end with correct parallelism and per-step metadata. MVP is functional.

---

## Phase 4: User Story 2 - Reject invalid workflows before anything executes (Priority: P2)

**Goal**: Every malformed workflow is refused up front with a message naming the offending element, and no model is ever called.

**Independent Test**: Submit each category from the error catalog in contracts/workflow-schema.md; each is rejected with its specific message and zero model calls are issued.

### Tests for User Story 2

- [ ] T032 [P] [US2] Validation catalog test in `llm_pipeline/tests/test_workflow_validation.py` — one case per row of the error catalog in contracts/workflow-schema.md, asserting the offending element appears in the message
- [ ] T033 [P] [US2] Template restriction test in `llm_pipeline/tests/test_templates.py` — a case per forbidden construct (for-loop, filter, function call, `{% %}` statement, `{# #}` comment, arbitrary attribute traversal, malformed placeholder), each rejected
- [ ] T034 [P] [US2] Hidden-dependency test in `llm_pipeline/tests/test_templates.py` — a prompt referencing `nodes.X.output` without `X` in `depends_on` is rejected (FR-015)
- [ ] T035 [P] [US2] Zero-model-call test in `llm_pipeline/tests/test_workflow_validation.py` — a provider double that raises if invoked; every invalid workflow must leave it untouched (SC-002)
- [ ] T036 [P] [US2] Determinism test in `llm_pipeline/tests/test_workflow_validation.py` — validating the same invalid definition repeatedly yields the identical first error (FR-009)

### Implementation for User Story 2

- [ ] T037 [US2] Add the AST allowlist to `llm_pipeline/llm_pipeline/workflow/templates.py`: walk the parsed Jinja tree and reject any node type outside `Output`, `TemplateData`, and `Getattr`/`Name` chains resolving to exactly `input.FIELD` or `nodes.STEP.output` — an allowlist so unanticipated constructs fail closed (research.md §4)
- [ ] T038 [US2] Add reachability checking to `llm_pipeline/llm_pipeline/workflow/validation.py` via reverse traversal from the output node; reject any node that cannot reach it (FR-008)
- [ ] T039 [US2] Add the hidden-dependency check to `llm_pipeline/llm_pipeline/workflow/validation.py`: every `nodes.STEP.output` reference must appear in that node's `depends_on`, and every `input.FIELD` reference in `input_fields`
- [ ] T040 [US2] Add resource validation to `llm_pipeline/llm_pipeline/workflow/validation.py`: every alias resource must be declared, every capacity `>= 1`, and every declared resource must exist in server configuration
- [ ] T041 [US2] Align every validation message in `llm_pipeline/llm_pipeline/workflow/validation.py` with the catalog in contracts/workflow-schema.md so each names its offending element (FR-011)
- [ ] T042 [US2] Report per-file validation failures at startup in `llm_pipeline/llm_pipeline/main.py` — invalid workflows are logged with their reason and excluded from the registry rather than crashing startup

**Checkpoint**: The full validation catalog is enforced and proven to run before any model call.

---

## Phase 5: User Story 3 - Mix fast local models with one heavy reasoning model (Priority: P3)

**Goal**: A workflow mixing Ollama and AirLLM completes; shared-accelerator steps serialize across concurrent requests; unrelated requests stay responsive; the heavy model loads exactly once.

**Independent Test**: Run a mixed workflow while issuing concurrent unrelated requests — the workflow completes, shared-resource steps never overlap, and a health check answers within 1s throughout.

### Tests for User Story 3

- [ ] T043 [P] [US3] Cross-run serialization test in `llm_pipeline/tests/test_resource_pool.py` — two concurrent runs whose steps declare the same single-capacity resource never hold it simultaneously (FR-028, SC-004)
- [ ] T044 [P] [US3] **Lease-drain test** in `llm_pipeline/tests/test_resource_pool.py` — cancel a task awaiting thread-offloaded work and assert the lease is still held until the thread finishes. This is the regression guard for the measured failure in research.md §3, where a naive `async with` released the lease 250ms early
- [ ] T045 [P] [US3] Deadlock-ordering test in `llm_pipeline/tests/test_resource_pool.py` — two steps requesting the same resource set in opposite declaration order both complete, proving sorted acquisition (FR-030)
- [ ] T046 [P] [US3] AirLLM identity-mismatch test in `llm_pipeline/tests/test_airllm_provider.py` — an alias naming a model this process did not load fails with `CONFIGURATION` and never attempts a load (FR-039)
- [ ] T047 [P] [US3] Event-loop responsiveness test in `llm_pipeline/tests/test_airllm_provider.py` — while a mocked slow AirLLM generation runs, a concurrent request completes promptly (FR-036, SC-007)
- [ ] T048 [P] [US3] Startup strictness test in `llm_pipeline/tests/test_airllm_provider.py` — with `airllm_required=true` a load failure aborts startup; with `false` the service starts and reports the backend unavailable (FR-040)

### Implementation for User Story 3

- [ ] T049 [US3] Implement `llm_pipeline/llm_pipeline/providers/airllm.py`: lazy import behind the optional extra, `AutoModel.from_pretrained` at load time only, and a `generate` that offloads to a dedicated single-thread executor, satisfying the `LLMProvider` Protocol unchanged
- [ ] T050 [US3] Add `drain_lease(names, awaitable)` to `llm_pipeline/llm_pipeline/runtime/resources.py`: await under `asyncio.shield`; on `CancelledError` wait for the underlying future to finish **before** releasing, then re-raise (research.md §3)
- [ ] T051 [US3] Route AirLLM steps through `drain_lease` in `llm_pipeline/llm_pipeline/runtime/scheduler.py`, leaving Ollama steps on the plain `lease` path
- [ ] T052 [US3] Load the AirLLM model in `llm_pipeline/llm_pipeline/main.py` lifespan, honouring `airllm_required`: raise on failure when strict, log and mark unavailable when permissive
- [ ] T053 [US3] Add a single-worker guard in `llm_pipeline/llm_pipeline/main.py` that detects multiple workers with an in-process heavy model and logs a prominent startup error, since per-process copies would silently break shared resource limits
- [ ] T054 [US3] Complete the `backends` array in `llm_pipeline/llm_pipeline/routers/health.py`, reporting each provider's availability and the heavy model this process actually holds (FR-041)
- [ ] T055 [US3] Fail steps routed to an unloaded backend with `BACKEND_UNAVAILABLE` at execution time, never at validation, so a definition stays portable between hosts (research.md §7)

**Checkpoint**: All three user stories are independently functional.

---

## Phase 6: Migration

**Purpose**: Bring the shipped workflows and both TypeScript clients onto the new schema. Required by SC-010; see research.md §8 and §9.

- [ ] T056 [P] Migrate `llm_pipeline/pipelines/simple-local.yaml` to the version-1 schema per the migration table in contracts/workflow-schema.md
- [ ] T057 [P] Migrate `llm_pipeline/pipelines/consensus-qa.yaml`, converting its four per-node `model:` blocks into named aliases and rewriting `{{ input }}` → `{{ input.FIELD }}` and `{{ x.output }}` → `{{ nodes.x.output }}`
- [ ] T058 [P] Migrate `llm_pipeline/pipelines/code-review-pipeline.yaml` the same way, preserving its existing fan-out/fan-in shape
- [ ] T059 Move `support-router.yaml` and `iterative-refinement.yaml` to `llm_pipeline/pipelines/deferred/`, each with a header comment naming the construct it needs and its target stage — conditional routing at Stage 4 for the router, and **no defined stage** for iteration (see the open question in `specs/ROADMAP.md`)
- [ ] T060 Exclude `deferred/` from the registry scan in `llm_pipeline/llm_pipeline/workflow/registry.py` so parked workflows produce neither listings nor startup errors
- [ ] T061 Rewrite `packages/client/src/types.ts` against the new contract: drop `PipelineBranchInfo`, `PipelineLoopInfo`, and their route/loop types; add alias, resource, and per-step timing types
- [ ] T062 Update `packages/client/src/apiClient.ts` for the new endpoint paths and request/response shapes in contracts/http-api.md
- [ ] T063 Simplify `packages/client/src/graphModel.ts` to pure-DAG layout, deleting the branch and loop edge classification (91 references) — net deletion, per research.md §9
- [ ] T064 [P] Simplify `web/src/graphView.ts`, removing branch and loop edge rendering (31 references)
- [ ] T065 [P] Update `web/src/main.ts` and `web/src/render.ts` for the typed-inputs request shape, replacing the single prompt box with one field per `input_fields` entry
- [ ] T066 [P] Update `cli/src/formatter.ts` and `cli/src/index.ts` for the new detail shape and typed inputs
- [ ] T067 Run `npm run typecheck` at the repo root and resolve every error across `packages/client`, `cli`, and `web`
- [ ] T068 Update `docker-compose.yml` and `llm_pipeline/Dockerfile`: single worker for the pipeline service, the new AirLLM environment variables, and removal of the deleted cloud-provider build args

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T069 [P] Rewrite the architecture section of `README.md` — the YAML schema example, the removal of branches and loops, and the alias/resource model
- [ ] T070 [P] Update `llm_pipeline/README.md` for the new endpoints, the AirLLM extra, and the single-worker requirement
- [ ] T071 [P] Update `llm_pipeline/.env.example` with the AirLLM and resource-capacity settings from T002
- [ ] T072 Work through [quickstart.md](./quickstart.md) end to end on a real host and correct any step that does not behave as written
- [ ] T073 Run the full sweep — `uv run pytest`, `uv run mypy .`, `uv run pyright` — and confirm no new type-checker suppressions beyond the optional-import pattern now covering `airllm`/`torch`
- [ ] T074 Verify SC-003 by timing a workflow whose independent branches use distinct resources: total time must stay within 1.5x the slowest branch

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: needs Setup. **Blocks every user story.** T015 deliberately leaves the service non-functional until T028
- **US1 (Phase 3)**: needs Foundational. Delivers the MVP
- **US2 (Phase 4)**: needs Foundational. Independently testable, but in practice follows US1 since its zero-model-call proof (T035) is more meaningful once a real execution path exists
- **US3 (Phase 5)**: needs Foundational and US1's scheduler and executor (T025, T026)
- **Migration (Phase 6)**: needs US1 and US2; T056–T058 need the validator to confirm the migrations are correct
- **Polish (Phase 7)**: needs everything

### Story Dependencies — an honest note

The template's usual assumption is that stories are fully independent. That is only partly true here, because this is a rewrite rather than an additive feature:

- **US1** is genuinely independent once Phase 2 lands
- **US2** shares `validation.py` with Phase 2. The core checks the scheduler cannot run without (T008) are foundational; US2 owns the *comprehensive* catalog, the template allowlist, and the proof of zero model calls
- **US3** builds on US1's scheduler — it cannot be delivered first

### Within Each Story

Tests before implementation. Providers before executor, executor before scheduler, scheduler before endpoints.

---

## Parallel Opportunities

**Phase 1**: T002 and T003 together, after T001.

**Phase 2**: T006 and T007 together. T008–T011 are sequential (each builds on the previous), T012 is independent of all of them.

**Phase 3 tests**: T017–T021 all together — five files, no shared state.

```bash
Task: "Scheduler fan-out/fan-in ordering test in llm_pipeline/tests/test_scheduler.py"
Task: "Provider routing test in llm_pipeline/tests/test_provider_router.py"
Task: "Contract test in llm_pipeline/tests/test_run_endpoint.py"
```

**Phase 4 tests**: T032–T036 all together.

**Phase 5 tests**: T043–T048 all together — six independent cases.

**Phase 6**: T056–T058 (three YAML files) in parallel; then T064–T066 (three client surfaces) in parallel after T061–T063.

**Phase 7**: T069–T071 together.

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup
2. Phase 2 Foundational — the service goes dark at T015
3. Phase 3 US1 — the service comes back at T028
4. **STOP and VALIDATE**: run a fan-out/fan-in workflow, confirm parallelism and per-step metadata

At this point mixed-model execution is not yet proven — that is US3, and it is the whole point of the milestone. The MVP is a checkpoint, not a deliverable.

### Incremental Delivery

1. Setup + Foundational → schema and validation exist
2. + US1 → workflows execute (MVP checkpoint)
3. + US2 → invalid workflows provably rejected
4. + US3 → **the actual Stage 1 goal**: mixed models sharing hardware safely
5. + Migration → shipped workflows and clients on the new schema
6. + Polish → Stage 1 exit criteria met

### Highest-risk tasks

Front-load thinking on these three; the rest is mechanical by comparison:

- **T050** (`drain_lease`) — the measured 250ms lease leak in research.md §3. Wrong here means silent accelerator corruption under load, not a test failure
- **T026** (scheduler) — acquiring leases outside the executor is what makes `resource_wait_ms` measurable and prevents a step blocked on a semaphore from counting against `max_parallel_nodes`
- **T037** (AST allowlist) — must fail closed. A blocklist here becomes a real problem at Stage 4, when templates start arriving from a model

---

## Notes

- `[P]` = different files, no dependencies on incomplete work
- Commit after each task or logical group
- The service is intentionally non-functional between T015 and T028 — do not treat that window as a regression
- Two shipped workflows are parked, not migrated (T059); SC-010 was amended to require exactly that
