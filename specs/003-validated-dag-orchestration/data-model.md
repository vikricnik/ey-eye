# Phase 1 Data Model: Single-Host Resource-Aware DAG Runner

Every model is a Pydantic `BaseModel` with `model_config =
ConfigDict(extra="forbid")` unless noted — FR-006 requires unknown fields
to be rejected, and `extra="forbid"` is what makes that structural rather
than a check someone remembers to write.

Three families: the **workflow definition** (parsed from YAML, validated
once, immutable), the **runtime state** (per run, in memory, discarded
when the request ends), and the **wire contract** (what crosses HTTP).
They are deliberately separate types — the Stage 2 rewrite replaces the
runtime family wholesale while the other two survive.

---

## 1. Workflow definition — `workflow/schema.py`

### `WorkflowDefinition`

| Field | Type | Rules |
|---|---|---|
| `version` | `Literal[1]` | Anything else rejected as unsupported (FR-007) |
| `name` | `str` | Filename-safe; must match its file stem |
| `description` | `str` | Default `""` |
| `max_parallel_nodes` | `int` | `ge=1` |
| `resources` | `dict[str, int]` | Each capacity `ge=1` (FR-008) |
| `models` | `dict[str, ModelAlias]` | `min_length=1`; keys are alias names |
| `nodes` | `list[NodeSpec]` | `min_length=1` |
| `input_fields` | `list[str]` | Fields callers must supply (FR-043) |
| `output` | `str` | Must name a defined node |

Derived properties (computed, not stored): `node_ids`, `dependency_map`,
`root_ids`.

### `ModelAlias`

| Field | Type | Rules |
|---|---|---|
| `provider` | `ProviderType` | `ollama` \| `airllm` |
| `model` | `str` | Physical model id. Server-controlled — never client-supplied (FR-048) |
| `resources` | `list[str]` | Each must name a declared resource (FR-008) |
| `system` | `str \| None` | Optional system instruction |
| `max_input_tokens` | `int \| None` | `ge=1` |
| `max_new_tokens` | `int` | `ge=1`, default 512 |
| `temperature` | `float` | `0.0–2.0`, default 0.2 |
| `top_p` | `float \| None` | `0.0–1.0` |
| `keep_alive` | `str \| int \| None` | **Ollama only** — rejected when `provider == airllm` |
| `timeout_seconds` | `float` | `gt=0`, default 60 |

**Validator**: `keep_alive` set with `provider == airllm` → `ValueError`
naming the alias. Mirrors the existing codebase's
`model_required_for_llm_call` pattern.

### `NodeSpec`

| Field | Type | Rules |
|---|---|---|
| `id` | `str` | `^[A-Za-z_][A-Za-z0-9_]*$` (FR-005) |
| `uses` | `str` | Must name a defined alias |
| `depends_on` | `list[str]` | Default `[]`; no self-reference, no duplicates |
| `prompt` | `str` | Restricted template (FR-013–FR-017) |

---

## 2. Validation — `workflow/validation.py`

One entry point, `validate_workflow(definition) -> None`, raising
`WorkflowValidationError` on the first problem with the offending element
named (FR-011). Called by the loader, by startup validation, and never by
the executor — by the time a definition reaches the runtime it is already
valid (FR-012).

Checks, in order:

1. Duplicate node ids
2. Unknown alias per node
3. Unknown dependency; self-dependency; duplicate dependency
4. Output node exists
5. **Cycle detection** — `graphlib.TopologicalSorter.prepare()` raises
   `CycleError`, whose `args[1]` is the cycle path, reported verbatim
6. Alias resources all declared; capacities `ge=1`
7. **Reachability** — every node must reach `output` via reverse-BFS from
   it; unreachable nodes rejected (FR-008)
8. **Template validation** per node — delegated to `templates.py`

Deterministic by construction: fixed check order over sorted collections,
so the same definition yields the same first error every time (FR-009).

### `TemplateSpec` (internal, not serialized)

What template validation returns for one node: the set of
`input.FIELD` references and the set of `nodes.STEP.output` references.
Validation then asserts every step reference is in that node's
`depends_on` (FR-015 — the hidden-dependency check) and every input
reference is in `input_fields` (FR-016).

---

## 3. Runtime state — `runtime/`

In-memory only, one instance per run, discarded when the request returns.
**This is the family Stage 2 replaces with persisted rows.**

### `NodeState` (enum)

`PENDING → READY → RUNNING → SUCCEEDED`, with `FAILED`, `CANCELLED`, and
`SKIPPED` as terminals.

The brief's fuller set (`QUEUED`, `RETRY_WAIT`, `CANCEL_REQUESTED`,
`WAITING_FOR_APPROVAL`) is deliberately not modelled here — those states
only mean something once runs are durable and retries exist (Stage 2) or
approval nodes exist (Stage 4). Modelling them now would create states
nothing can enter.

### `NodeExecution`

| Field | Type | Notes |
|---|---|---|
| `node_id` | `str` | |
| `state` | `NodeState` | |
| `alias` | `str` | Logical alias used |
| `provider` | `ProviderType` | |
| `physical_model` | `str` | |
| `output` | `str \| None` | Populated on success |
| `queued_at` / `started_at` / `finished_at` | `float \| None` | `time.monotonic()` |
| `resource_wait_ms` | `float \| None` | `started_at − queued_at` (FR-026) |
| `execution_ms` | `float \| None` | `finished_at − started_at` |
| `failure` | `StepFailure \| None` | |

`resource_wait_ms` is only measurable because acquisition happens in the
scheduler *outside* the step call — the reason §1 of research.md rejects
wrapping acquisition inside a node body.

### `StepFailure`

| Field | Type |
|---|---|
| `node_id` | `str` |
| `category` | `FailureCategory` |
| `message` | `str` — sanitized, never raw provider output (FR-046) |

### `FailureCategory` (enum) — `runtime/failures.py`

| Value | Raised when | Stage 2 policy (not applied now) |
|---|---|---|
| `PROVIDER_TIMEOUT` | Request exceeded `timeout_seconds` | retry with backoff |
| `PROVIDER_UNAVAILABLE` | Connection refused / transport error | retry, then fallback |
| `BACKEND_UNAVAILABLE` | AirLLM not loaded on this host | non-retryable |
| `CONFIGURATION` | Unknown provider, heavy-model identity mismatch | non-retryable |
| `VALIDATION` | Definition or input rejected | non-retryable |
| `INPUT_TOO_LARGE` | Input or rendered prompt over limit | non-retryable |
| `INTERNAL` | Anything unclassified | non-retryable |

A single `classify(exc) -> FailureCategory` owns the mapping, so the
taxonomy has one definition rather than one per raise site.

### `RunState`

| Field | Type |
|---|---|
| `workflow_name` | `str` |
| `inputs` | `dict[str, str]` |
| `nodes` | `dict[str, NodeExecution]` |
| `failed` | `StepFailure \| None` — set once, ends the run (FR-023) |

---

## 4. Resources — `runtime/resources.py`

### `ResourcePool`

Constructed once in lifespan from server configuration, held on
`app.state`, shared by every run — this sharing *is* FR-027.

| Member | Purpose |
|---|---|
| `_semaphores: dict[str, asyncio.Semaphore]` | One per named resource |
| `lease(names: Sequence[str])` | Async context manager; sorts `names`, acquires in that order, releases in reverse |
| `drain_lease(names, awaitable)` | The heavy-model variant — holds the lease until the underlying work truly finishes, even under cancellation (FR-031, FR-038; research.md §3) |

Sorting inside `lease()` rather than at the call site is what makes
deadlock-freedom a property of the pool instead of a convention callers
must follow.

**Capacity source**: the pool is built from *server* configuration, not
from a workflow's `resources:` block. A workflow declares which resources
its aliases consume; it does not get to declare how much of the host
exists. A workflow naming a resource the server hasn't configured is
rejected at load.

---

## 5. Wire contract — `api_schemas.py`

Full endpoint detail in [contracts/http-api.md](./contracts/http-api.md).

| Model | Shape |
|---|---|
| `RunWorkflowRequest` | `{inputs: dict[str, str]}` — validated against `input_fields` (FR-043) |
| `NodeResultDTO` | `{node_id, alias, provider, physical_model, output, resource_wait_ms, execution_ms}` |
| `RunWorkflowResponse` | `{workflow_name, output_node, final_output, nodes: dict[str, NodeResultDTO]}` |
| `WorkflowSummary` | `{name, description, input_fields}` |
| `WorkflowDetail` | `{name, description, input_fields, output, nodes: [...], models: [...], resources: {...}}` |
| `BackendStatus` | `{provider, available, physical_model \| None}` |
| `HealthResponse` | `{status, ollama_reachable, backends: [BackendStatus]}` (FR-041) |
| `ErrorResponse` | Existing shape, plus `category: FailureCategory` |

`ErrorResponse` keeps its current fields (`timestamp`, `status`, `error`,
`message`, `request`, `exceptionUID`, `details`, `validations`) — the
existing error contract is sound and the clients already parse it. Only
`category` is added.

---

## 6. Invariants the design must preserve

- **A definition reaching the runtime is already valid.** Validation
  happens at load; the executor performs no structural checks and has no
  repair path (FR-010, FR-012).
- **Resource capacity is global.** One `ResourcePool` per process,
  injected. Never constructed per request — that would silently satisfy
  single-run tests while failing FR-028 under concurrency.
- **A lease outlives its awaiter.** Release is only reachable after the
  underlying work completes; cancellation drains rather than abandons.
- **Failure is classified once, at the raise site.** No downstream
  re-inference of category from a message string.
- **Nothing persists.** No run survives the request. Making this explicit
  now is what keeps Stage 2's persistence layer an addition rather than a
  reconciliation of two competing sources of truth.
