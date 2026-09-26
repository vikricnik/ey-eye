# Feature Specification: Single-Host Resource-Aware DAG Runner (Platform Stage 1)

**Feature Branch**: `[003-validated-dag-orchestration]`

**Created**: 2026-08-27

**Status**: Draft

**Scope**: Stage 1 of the Local-First LLM Workflow Platform roadmap — see [ROADMAP.md](../ROADMAP.md)

**Input**: A workflow service that executes LLM workflows defined as validated DAGs — mixing multiple fast local models with one preloaded heavy reasoning model, with fan-out/fan-in scheduling and process-wide resource-aware serialization. Scoped down from a broader platform brief to the smallest milestone that proves mixed-model, resource-aware DAG execution works on a single host.

## Clarifications

### Session 2026-08-27

- Q: How should this relate to the existing pipeline service, whose workflow schema is incompatible with the one described here? → A: Evolve the existing service in place — one service, whose execution engine and workflow schema are replaced by the ones specified here, reusing its existing authentication, rate limiting, error-response shape, and logging. The currently shipped workflow definitions and the terminal/browser clients that depend on the old schema must be migrated as part of this work.
- Q: Should the service start when the heavy reasoning model cannot be loaded (e.g. on a development machine without the required hardware)? → A: Configurable strictness — a server setting decides whether a failed heavy-model load aborts startup (production default) or allows the service to start with that backend reported as unavailable (development default), in which case only workflows using it fail, and only when they are actually run.
- Q: A platform brief was supplied that stages this work across six milestones. How much of it belongs in this feature? → A: Stage 1 only. This feature is the single-host runner. The LLM workflow planner, durable run state, stored/compiled plans, and the tool-discovery interface for LLM clients are each deferred to their own specs at their own stages, tracked in [ROADMAP.md](../ROADMAP.md). An earlier draft of this spec bundled the planner, stored plans, and tool discovery into this milestone; those were removed on 2026-08-27 to match the brief's staging.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a predefined workflow with parallel, resource-aware execution (Priority: P1)

An operator has a trusted workflow definition stored on the server. They
submit input values for it and receive the workflow's final output plus
per-step detail: what each step produced, which model answered it, how
long it waited before starting, and how long it took to run. Steps that
don't depend on each other run at the same time when the hardware they
need is free; a step that combines several earlier steps waits for all of
them.

**Why this priority**: This is the core of the milestone — validation and
model mixing both exist to protect and feed this path. Without it there
is no runner.

**Independent Test**: Submit input to a stored multi-step workflow with at
least one fan-out and one fan-in, and confirm the final output plus
complete per-step metadata come back, with the independent branches
demonstrably overlapping in time.

**Acceptance Scenarios**:

1. **Given** a stored workflow whose steps form a chain, **When** input is
   submitted, **Then** the steps run in dependency order and the response
   contains the final output, the identifier of the step that produced it,
   and every completed step's output.
2. **Given** a workflow where two steps share a parent but not each other,
   **When** it runs and the resources they need are free, **Then** those
   two steps execute concurrently rather than one after the other.
3. **Given** a step that depends on three earlier steps, **When** it runs,
   **Then** it does not begin until all three have completed, and all
   three of their outputs are available to it.
4. **Given** a running workflow, **When** any step fails, **Then** the run
   stops without starting further steps, and the error identifies the
   specific step that failed, the category of failure, and the underlying
   reason.
5. **Given** any completed run, **When** the response is inspected,
   **Then** each step reports the provider and model that answered it, the
   time it spent waiting to start, and the time it spent executing.
6. **Given** a workflow whose configured limit on simultaneously active
   steps is N, **When** more than N steps are eligible to run at once,
   **Then** no more than N are ever active simultaneously.

---

### User Story 2 - Reject invalid workflows before anything executes (Priority: P2)

An author submits or stores a workflow definition that is malformed — a
dependency cycle, a step referencing a model alias that doesn't exist, a
prompt referencing a step it doesn't depend on, an undefined resource, a
typo'd field name. The service refuses it up front with a message naming
the specific offending element, and no model is ever called.

**Why this priority**: Deterministic, early rejection is the safety
property every later stage depends on — a workflow planner (Stage 4) can
only be trusted once this is airtight. It is independently valuable and
independently testable with hand-written workflows alone.

**Independent Test**: Submit each category of invalid workflow and
confirm each is rejected with a message identifying the specific problem,
with zero model calls issued in every case.

**Acceptance Scenarios**:

1. **Given** a workflow whose steps form a dependency cycle, **When** it
   is loaded, **Then** it is rejected as cyclic before execution and the
   cycle's participants are identifiable from the message.
2. **Given** a step that names a model alias not defined in the workflow,
   **When** it is loaded, **Then** it is rejected naming that step and
   that alias.
3. **Given** a prompt that references a step which is not among that
   step's declared dependencies, **When** it is loaded, **Then** it is
   rejected naming the referencing step and the disallowed reference — a
   hidden dependency must never survive validation.
4. **Given** a workflow containing a field name not in the documented
   schema, **When** it is loaded, **Then** it is rejected rather than
   silently ignoring the unknown field.
5. **Given** a workflow with a step that cannot reach the designated
   output step, **When** it is loaded, **Then** it is rejected as
   containing work that cannot contribute to the result.
6. **Given** any invalid workflow from the categories above, **When** it
   is rejected, **Then** the service has made zero model calls and has
   made no attempt to silently correct the definition.

---

### User Story 3 - Mix fast local models with one heavy reasoning model, safely sharing hardware (Priority: P3)

A workflow uses several fast local models for extraction and drafting,
and one heavy reasoning model for the expensive analysis step. The heavy
model is prepared once when the service starts, never mid-request. When
the fast and heavy models share the same accelerator, their work is
serialized — including across simultaneous requests from different
clients — so they never compete for the same memory. Meanwhile, requests
that don't need the heavy model stay responsive while it is working.

**Why this priority**: This is the distinguishing capability of the
platform — cheap models for cheap work, one expensive model for hard work
on constrained hardware — and proving it is the entire point of this
milestone. It builds on the execution engine (US1) and the safety net
(US2).

**Independent Test**: Run a workflow mixing both kinds of model on shared
hardware while issuing concurrent unrelated requests; confirm the mixed
workflow completes, that shared-hardware steps never overlap, and that
the unrelated requests are served promptly throughout.

**Acceptance Scenarios**:

1. **Given** a workflow with both fast-model and heavy-model steps,
   **When** it runs, **Then** it completes and each step reports which
   provider and model answered it.
2. **Given** fast-model and heavy-model steps that both declare the same
   single-capacity hardware resource, **When** both are eligible, **Then**
   they never execute simultaneously.
3. **Given** two simultaneous requests whose steps declare the same
   single-capacity resource, **When** both are in flight, **Then** the
   resource limit holds across both requests — the second waits rather
   than both proceeding.
4. **Given** the heavy model is generating, **When** an unrelated
   lightweight request arrives, **Then** it is served promptly rather
   than waiting for the heavy generation to finish.
5. **Given** the service has started, **When** any number of requests use
   the heavy model, **Then** the heavy model was prepared exactly once,
   at startup, and never during a request.
6. **Given** a workflow whose heavy-model step names a model other than
   the one this instance prepared, **When** it is validated or run,
   **Then** it is rejected rather than attempting to load a different
   model.
7. **Given** fast-model and heavy-model steps that declare *different*
   hardware resources, **When** both are eligible, **Then** they may run
   concurrently.
8. **Given** a client abandons an in-flight request during heavy-model
   generation, **When** the request is torn down, **Then** the hardware
   allotment is not released back to other work until that generation has
   genuinely finished.

---

### Edge Cases

- A step fails while sibling branches are still running: the run must
  fail fast, stop starting new work, stop in-flight work where it is safe
  to do so, and still report which step failed, its failure category, and
  why.
- A client disconnects mid-run while the heavy model is generating:
  abandoning the waiting request must not hand the hardware allotment to
  another request while generation is genuinely still in progress.
- The fast-model backend is unreachable or times out: the affected step
  must fail with a distinguishable category (unreachable vs. timed out),
  not a generic error.
- The heavy model could not be prepared at startup: under permissive
  configuration the service must start and report that backend as
  unavailable, failing only the workflows that actually use it, and only
  when they run; under strict configuration startup must fail loudly.
- Two simultaneous requests each need the same single-capacity resource:
  one must wait rather than both proceeding or either failing.
- A step needs several resources at once while another step needs the
  same set in a different order: acquisition order must be deterministic
  so the two cannot deadlock each other.
- The service is started with more than one worker process while the
  heavy model is in-process: each worker would prepare its own copy, and
  the resource limits would no longer be shared — this configuration must
  be prevented or loudly flagged.
- Input values are enormous, or a rendered prompt balloons past the
  model's usable window: both must be refused by explicit size limits
  rather than passed through.
- A workflow declares a resource capacity of zero or a negative number:
  rejected at validation, since no step needing it could ever run.
- An existing workflow written against the previous schema is loaded:
  it must be rejected clearly as an unsupported schema version rather
  than partially interpreted.
- A run is still executing when the service is shut down: because this
  stage keeps run state in memory only, that run is lost. This is an
  accepted Stage 1 limitation, but the failure must be visible rather
  than leaving a client waiting indefinitely.

## Requirements *(mandatory)*

### Functional Requirements

#### Workflow definition and schema

- **FR-001**: The service MUST load workflow definitions from trusted,
  server-side sources only, and MUST parse them without permitting the
  definition format to construct arbitrary objects or execute code.
- **FR-002**: A workflow definition MUST declare a schema version, a
  limit on simultaneously active steps, a set of named resources with
  capacities, a set of named model aliases, an ordered set of steps, and
  exactly one designated output step.
- **FR-003**: Each model alias MUST declare its provider kind, the
  physical model it resolves to, which named resources it consumes, and
  its generation settings — optional system instruction, maximum input
  tokens, maximum generated tokens, temperature, and nucleus-sampling
  threshold — plus, for the HTTP-based provider only, a model-retention
  hint.
- **FR-004**: Each step MUST declare a unique identifier, the model alias
  it uses, the identifiers it depends on, and its prompt template.
- **FR-005**: Step identifiers MUST be restricted to a conservative
  identifier form: a letter or underscore followed by letters, digits, or
  underscores.
- **FR-006**: Any definition containing a field not present in the
  documented schema MUST be rejected, never silently ignored.
- **FR-007**: A definition declaring an unsupported schema version MUST be
  rejected as such, distinctly from other validation failures.

#### Validation (deterministic, pre-execution)

- **FR-008**: Before any step executes, the service MUST verify all of
  the following, rejecting the workflow if any fails: step identifiers are
  unique; every step's model alias is defined; every declared dependency
  names an existing step; no step depends on itself; no dependency is
  listed twice for the same step; the designated output step exists; the
  dependency graph contains no cycles; every model alias references only
  resources the workflow defines; every resource capacity is at least one;
  and every step can reach the output step.
- **FR-009**: Validation MUST be deterministic — the same definition
  always produces the same verdict and the same reported problems.
- **FR-010**: The service MUST NOT silently repair, normalize away, or
  work around any validation failure; a workflow either passes and runs,
  or is rejected and does not.
- **FR-011**: Every rejection MUST identify the specific offending element
  — the step, alias, dependency, resource, or field at fault.
- **FR-012**: Validation MUST complete before any model is contacted; a
  rejected workflow MUST result in zero model calls.

#### Prompt templates

- **FR-013**: Prompt templates MUST support exactly two substitution
  forms: a named field of the run's input, and the output of a named step.
- **FR-014**: Templates MUST reject every other construct the templating
  form might otherwise allow — loops, filters, function calls, arbitrary
  attribute traversal, control statements, comments, and malformed
  placeholders.
- **FR-015**: A step's template MUST be permitted to reference only steps
  listed among that step's own declared dependencies; any other step
  reference MUST be rejected, so that a hidden dependency cannot exist.
- **FR-016**: A template referencing an input field the run does not
  declare MUST be rejected.
- **FR-017**: Template rendering MUST be strict — a missing value MUST
  produce a clear failure rather than substituting an empty or placeholder
  value.
- **FR-018**: Template validation MUST occur during workflow validation,
  before execution begins, not lazily at the moment a step runs.

#### Execution and scheduling

- **FR-019**: The scheduler MUST start every step whose dependencies have
  all completed, as soon as its required resources are available.
- **FR-020**: Steps with no dependency relationship between them MUST be
  able to execute concurrently when their resource requirements permit.
- **FR-021**: A step with multiple dependencies MUST NOT begin until all
  of them have completed, and MUST receive all of their outputs.
- **FR-022**: The number of simultaneously active steps MUST NOT exceed
  the workflow's declared limit.
- **FR-023**: When a step fails, the run MUST fail fast: no further steps
  may start, and in-flight work MUST be stopped where doing so is safe.
- **FR-024**: A failed run's error MUST preserve and report the failing
  step's identifier, a failure category, and the underlying reason.
- **FR-025**: Failure categories MUST be distinguishable at minimum
  between: provider timeout, provider unavailable, configuration error
  (such as an unknown alias), validation failure, and input-size
  violation — so that per-category retry and fallback policies can be
  added in a later stage without reclassifying failures.
- **FR-026**: A successful run's response MUST contain the final output,
  the identifier of the step that produced it, every completed step's
  output, and for each step: the provider used, the model used, the time
  spent waiting to start, and the time spent executing.

#### Resource management

- **FR-027**: Resource capacities MUST be enforced across the entire
  service instance and shared by all concurrent runs — the service MUST
  NOT create a separate resource allotment per request.
- **FR-028**: Two steps that both require the same single-capacity
  resource MUST NOT execute simultaneously, whether they belong to the
  same run or to different concurrent runs.
- **FR-029**: Steps whose resource requirements do not overlap MUST be
  able to execute concurrently.
- **FR-030**: When a step requires several resources, the service MUST
  acquire them in a deterministic, globally consistent order so that
  concurrent steps requiring overlapping sets cannot deadlock.
- **FR-031**: A resource allotment MUST remain held until the underlying
  work has genuinely finished — not merely until the waiting request has
  been abandoned or cancelled.

#### Model providers

- **FR-032**: The service MUST support multiple fast models served over
  HTTP by a local model server, selected per step through approved
  aliases, supporting per-alias temperature, nucleus-sampling threshold,
  generated-token limit, model-retention hint, and a request timeout, with
  connection failures and timeouts surfaced as distinguishable categories.
- **FR-033**: Streaming responses are out of scope for this stage;
  provider calls MUST operate in non-streaming mode.
- **FR-034**: The service MUST prepare exactly one heavy reasoning model
  per process, during startup, and MUST NOT prepare it inside a request.
- **FR-035**: The heavy model's identity MUST come exclusively from
  trusted server configuration; clients MUST NOT be able to specify it.
- **FR-036**: Heavy-model generation MUST run off the request-handling
  path so that unrelated requests continue to be served while it works.
- **FR-037**: Access to the prepared heavy model MUST be serialized — it
  MUST be treated as having capacity for exactly one concurrent
  generation.
- **FR-038**: Abandoning or cancelling a request that is awaiting
  heavy-model generation MUST be handled correctly: the underlying
  generation does not stop merely because the waiter went away, and the
  service MUST NOT treat its resources as free until it truly ends.
- **FR-039**: The provider router MUST dispatch each step to the provider
  its alias names, MUST reject unknown providers, MUST reject a
  heavy-model step naming a model other than the one this instance
  prepared, and MUST normalize every provider's result to plain text.
- **FR-040**: Whether a failed heavy-model preparation aborts startup MUST
  be governed by server configuration: under strict configuration startup
  fails; under permissive configuration the service starts, reports that
  backend as unavailable, and fails only workflows that actually use it,
  and only when they run.

#### Service interface

- **FR-041**: The service MUST expose a health check reporting overall
  status, whether the local model server is reachable, whether the heavy
  model is prepared, and which heavy model it is.
- **FR-042**: The service MUST expose a way to execute a predefined,
  trusted server-side workflow by name, supplying values for its declared
  input fields.
- **FR-043**: Supplied input values MUST be validated against the
  workflow's declared input fields; a missing declared field or an
  undeclared supplied field MUST be rejected naming that field.
- **FR-044**: The service MUST expose a way to list the workflows
  available on it and to inspect one workflow's structure without running
  it.

#### Error handling

- **FR-045**: The service MUST produce a distinguishable, specific error
  for each of: malformed definition content; unsupported schema version;
  unknown provider; unknown model alias; unknown dependency; cyclic
  graph; disallowed prompt reference; missing input field; invalid
  resource declaration; local model server unreachable; local model server
  timeout; heavy-model identity mismatch; and step execution failure.
- **FR-046**: Public error responses MUST NOT contain stack traces,
  secrets, internal filesystem paths, or unrestricted raw model output.
- **FR-047**: A run that cannot complete because the service is shutting
  down MUST fail visibly rather than leaving a client waiting
  indefinitely.

#### Security

- **FR-048**: Physical model identities MUST NOT be accepted from client
  input — only from server configuration.
- **FR-049**: The service MUST NOT execute shell commands, filesystem
  operations, or outbound requests derived from workflow content.
- **FR-050**: Secrets and provider configuration MUST never be exposed to
  prompts or to any client-visible output.
- **FR-051**: The service MUST enforce explicit size limits on submitted
  input values and on rendered prompts, rejecting oversized content.
- **FR-052**: All execution-capable surfaces MUST enforce authentication
  and rate limiting.

#### Observability

- **FR-053**: The service MUST emit structured logs recording, where
  applicable: the workflow identifier, the request identifier, the step
  identifier, the provider, the model alias, the physical model, the time
  spent waiting for resources, the execution time, the success or failure
  outcome with its category, and input/output token counts when the
  provider reports them.
- **FR-054**: Logs MUST record identifiers rather than full prompt or
  output content by default, so that enabling logging does not by itself
  expose sensitive workflow content.

### Key Entities

- **Workflow Definition**: The complete, validated description of a
  runnable workflow — its schema version, concurrency limit, resource
  declarations, model aliases, steps, and designated output step. The unit
  that is validated and executed.
- **Model Alias**: A logical capability name (e.g. "fast extractor",
  "deep reasoner", "writer") that a step selects. Maps to a
  server-controlled provider, physical model, resource requirements, and
  generation settings. The indirection that will later let a planner
  choose capabilities without controlling infrastructure.
- **Step**: One unit of work in a workflow — an identifier, the alias it
  uses, its dependencies, and its prompt template.
- **Resource**: A named, capacity-bearing thing that steps contend for
  (an accelerator, a model server's concurrency budget, a heavy-model
  instance). Capacities are enforced service-wide, not per run.
- **Run**: One execution of a workflow against one set of input values.
  Produces a final output, an output step identifier, and a Step Result
  for every completed step. Exists in memory for the duration of the
  request only at this stage.
- **Step Result**: What one step produced during one run — its output,
  the provider and model that answered it, its wait time, and its
  execution time.
- **Failure Category**: The classification of why a step failed, chosen
  from a fixed set, so that later stages can attach retry and fallback
  policies per category.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workflow that mixes fast models and the heavy reasoning
  model runs to completion and returns the final output plus complete
  per-step detail for every step.
- **SC-002**: 100% of invalid workflows across every category enumerated
  in FR-008 and FR-013–FR-016 are rejected before execution, with zero
  model calls made and the specific offending element named.
- **SC-003**: For a workflow with N independent branches on non-competing
  resources, total run time does not exceed 1.5x the duration of the
  slowest single branch, and is measurably less than the sum of all
  branch durations.
- **SC-004**: Across 10 simultaneous runs contending for the same
  single-capacity resource, that resource is never held by more than one
  step at a time, and no run fails merely because it had to wait.
- **SC-005**: 100% of failed runs report the identifier of the step that
  failed together with its failure category.
- **SC-006**: The heavy reasoning model is prepared exactly once per
  service process, never during a request.
- **SC-007**: While the heavy model is generating, a health check
  completes within one second, demonstrating unrelated work is not
  blocked.
- **SC-008**: Zero error responses across the full error catalog contain a
  stack trace, a secret, an internal filesystem path, or raw unrestricted
  model output.
- **SC-009**: Automated tests cover workflow validation, scheduling
  behavior, resource locking, and provider routing.
- **SC-010**: Every shipped workflow definition whose shape the Stage 1
  schema can express — those that are pure dependency graphs — loads,
  validates, and runs under the new schema. Definitions requiring control
  flow the Stage 1 schema deliberately omits (conditional routing,
  iteration) are parked with a documented reason and a target stage
  rather than silently dropped or partially migrated; none is left in the
  old format.

## Assumptions

### Stage boundaries — what this feature deliberately excludes

This feature is Stage 1 of a six-stage roadmap ([ROADMAP.md](../ROADMAP.md)).
The following are **explicitly out of scope here** and belong to later
stages; each will get its own spec:

- **Durable run state** (Stage 2). Run state lives in memory for the
  duration of the request. A restart loses in-flight runs.
- **Asynchronous run submission, run IDs, progress streaming, cancel /
  retry / resume** (Stage 2). This stage executes a workflow within a
  single request and returns when it finishes.
- **Node-level retry and fallback policies** (Stage 2). This stage
  classifies failures (FR-025) so those policies can be added later, but
  applies none.
- **Artifact storage** (Stage 2). Outputs are returned inline.
- **Dedicated per-model worker processes** (Stage 2). The heavy model is
  in-process for this stage.
- **The logical/physical plan split, capability registry, typed input
  bindings, output schemas, versioned prompt templates, caching, plan
  hashing** (Stage 3).
- **The LLM workflow planner, pattern catalog, policy engine, repair
  loop, conditional nodes, bounded map/reduce, human approval** (Stage 4).
- **Deterministic non-LLM node kinds** — transform, validate, split, map,
  reduce, condition, retrieval, tool, subworkflow (Stages 3–4). Every
  step in this stage calls a model.
- **Multi-tenancy, quotas, priority scheduling, audit exports**
  (Stage 5).
- **Workflow packaging and catalog** (Stage 6).
- **Tool-discovery interface for LLM clients (MCP)** — deferred to its own
  spec; see ROADMAP.md.
- **Mid-execution replanning** — explicitly not part of any early stage.

### Accepted Stage 1 compromises — do not treat as permanent

The source brief lists architectural choices that must not become
permanent assumptions. This stage knowingly makes several of them because
they are the correct MVP trade-off, and they are recorded here so that
later stages are expected to replace them rather than inherit them:

- The heavy model is owned by the main API process. Stage 2 moves it to a
  dedicated worker.
- A whole workflow executes inside one request. Stage 2 introduces
  asynchronous runs.
- Resource coordination uses process-local primitives. These are valid
  only for a single-process deployment; Stage 2 replaces them with real
  queues or leases.
- Workflow state exists only in memory. Stage 2 persists it.
- Outputs are returned inline rather than as stored artifacts. Stage 2
  adds artifact storage.

Because of these, this stage MUST run as a single worker process.

### Environment and deployment

- This feature evolves the existing pipeline service in place rather than
  standing up a second service; its execution engine and workflow schema
  are replaced by the ones specified here. The workflow definitions
  currently shipped with the project, and the terminal and browser clients
  that consume the old schema, must be migrated as part of this work —
  that migration is in scope (SC-010), and old-schema definitions are
  rejected rather than dual-supported (FR-007).
- The local model server hosting the fast models is operated separately
  and is reachable over HTTP; this feature does not provision or manage
  it.
- Development machines may lack the hardware the heavy model requires;
  the configurable startup strictness (FR-040) exists precisely so that
  everything except heavy-model execution remains developable and testable
  on such a machine.
- Authentication and rate limiting reuse the existing service's
  established mechanisms rather than introducing a new scheme.

### User-mandated technical constraints

Specified explicitly in the source brief and recorded here so they carry
into planning rather than being re-decided:

- Project and dependency management via `uv`.
- Definition parsing must use a safe loader that cannot construct
  arbitrary objects; schema models must forbid unknown fields.
- Deterministic graph validation via the standard library's topological
  sorting facility rather than an ad-hoc traversal.
- Step identifiers restricted to the pattern `^[A-Za-z_][A-Za-z0-9_]*$`.
- The fast-model provider is reached over its HTTP API; a
  model-retention hint of zero is used for its steps when it shares an
  accelerator with the heavy model, so memory is released before the next
  step. This is a supplement to proper scheduling, never a replacement
  for it.
- The simplest reliable hardware split, where two accelerators are
  available, is to give one to the fast-model server and one to the heavy
  model, so the two need not serialize at all.
