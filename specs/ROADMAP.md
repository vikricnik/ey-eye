# Platform Roadmap

Maps the six stages of [PLATFORM_BRIEF.md](./PLATFORM_BRIEF.md) onto Spec
Kit features, so each `/speckit-specify` run has a defined scope and
features stop overlapping each other.

**The rule this roadmap exists to enforce**: one stage at a time. Specs
`002` and `003` initially overlapped badly — `002` was superseded before
it was ever built, and `003` had to be cut back from four stages' worth
of scope to one. Check this file before writing a new spec.

Spec numbers are assigned sequentially when a spec is created, so only
existing specs are numbered below.

---

## Stage status

| Stage | Goal | Spec | Status |
|---|---|---|---|
| **1. Single-host workflow runner** | Prove mixed fast/heavy model DAG execution on one host | [`003-validated-dag-orchestration`](./003-validated-dag-orchestration/spec.md) | ⚠️ Planned, needs re-plan — keep LangGraph (see 004) |
| **2. Durable orchestration** | Make runs reliable and operationally usable | — | ⬜ Not started |
| **3. Workflow compiler** | Separate intent from infrastructure | — | ⬜ Not started |
| **4. Controlled agent platform** | Let LLMs adapt workflows safely | — | ⬜ Not started |
| **5. Org-wide control plane** | Operate as shared infrastructure | — | ⬜ Not started |
| **6. Workflow ecosystem** | Turn workflows into reusable packages | — | ⬜ Not started |
| **Tool discovery (MCP)** | Expose the platform to LLM clients | — | ⬜ Deferred — see below |
| **Visual pipeline builder** | Build, configure, save and watch pipelines from web and CLI | [`004-visual-pipeline-builder`](./004-visual-pipeline-builder/spec.md) | ✅ Implemented (user-requested track) |

---

## Stage 1 — Single-host workflow runner

**Spec**: [`003-validated-dag-orchestration`](./003-validated-dag-orchestration/spec.md) · Brief §37 Stage 1

Validated YAML DAGs, multiple fast models by alias plus one in-process
heavy model, deterministic validation, restricted templates, an async
scheduler, process-wide resource semaphores, one execution endpoint, a
health endpoint.

**Exit criteria** (from the brief):

- A YAML DAG mixing fast and heavy models executes
- Fan-out and fan-in work
- Cyclic graphs are rejected before execution
- The heavy model is loaded exactly once
- Shared-accelerator calls are serialized
- Concurrent requests respect the same process-wide resource limits

**Knowingly deferred here**: durable state, async runs, retries,
artifacts, worker processes. See the spec's "Accepted Stage 1
compromises" section — these are the correct MVP trade-off, but Stage 2
is expected to replace them, not inherit them.

---

## Stage 2 — Durable orchestration

**Brief §37 Stage 2, §19, §26, §27, §28**

Postgres-backed plan and run store, persistent workers or a queue,
asynchronous run submission, run status API, progress event streaming,
cancellation, persistent node state, retry and fallback policies,
artifact storage, restart recovery, a dedicated heavy-model worker,
structured logs and metrics.

**Exit criteria**: a process restart does not lose run state; failed
nodes can be retried; long workflows do not hold an open request; the
heavy model restarts independently of the API; run history and artifacts
are inspectable.

**Depends on Stage 1.** This stage is where the five accepted Stage 1
compromises get undone. Stage 1's failure categorization (its FR-025)
exists specifically so the per-category retry and fallback policies here
can be added without reclassifying anything.

---

## Stage 3 — Workflow compiler

**Brief §37 Stage 3, §10, §12, §14, §29**

Logical DAG schema separated from the compiled physical plan, a model
capability registry, a deterministic plan compiler, typed input
bindings, typed output schemas, versioned prompt templates, cost and
latency estimation, dry-run mode, content-addressed caching, plan
hashing for reproducibility.

**Exit criteria**: workflows reference capabilities rather than physical
models; every run records an immutable compiled plan; nodes exchange
validated structured data; plans reproduce after registry changes.

**Depends on Stage 2.** This is where Stage 1's raw prompt templates give
way to typed bindings, and where the deterministic non-LLM node kinds
(transform, validate, split, condition) start to make sense.

---

## Stage 4 — Controlled agent platform

**Brief §37 Stage 4, §21, §22, §23, §25, §30**

The LLM workflow planner, structured planner output, a pattern catalog,
a planner policy engine, a bounded repair loop, conditional nodes,
bounded map/reduce, human approval nodes, retrieval and allowlisted
tools, plan risk classification.

**Exit criteria**: an LLM can create a valid logical plan; the planner
cannot control physical infrastructure; invalid plans never execute;
sensitive actions require approval; dynamic behavior stays bounded and
auditable.

**Depends on Stage 3.** The brief is deliberate about this ordering: the
planner is only *safe* once validation and deterministic compilation are
solid, and only *useful* once runs are durable. An earlier draft of spec
003 pulled the planner into Stage 1 — that was the scoping error this
roadmap exists to prevent.

---

## Stage 5 — Organization-wide control plane

**Brief §37 Stage 5**

Multi-tenancy, team and role permissions, quotas and token budgets,
priority and fair scheduling, a model deployment registry, workflow
versioning, evaluation dashboards, cost accounting, retention policies,
audit exports, tenant privacy policies, high availability.

---

## Stage 6 — Workflow ecosystem

**Brief §37 Stage 6**

Versioned workflow packages, an internal catalog, input/output
contracts, bundled evaluation suites, compatibility declarations,
install and upgrade mechanisms.

---

## Visual pipeline builder — user-requested track

**Spec**: [`004-visual-pipeline-builder`](./004-visual-pipeline-builder/spec.md)

Requested directly rather than drawn from the brief: a React Flow editor
for pipelines, per-node configuration (model, temperature, prompts, Ollama
options) from web and CLI, server-sent `node_start` events for live run
status, saving pipelines and node presets, YAML import/export.

It was built on the **current** LangGraph engine and schema, ahead of Stage
1. Its constitution deviations (client-chosen models behind an allowlist,
work outside the stage sequence) are recorded in its plan's Complexity
Tracking.

**Effect on Stage 1**: spec 003's plan removes LangGraph and replaces the
schema. It must be re-planned before implementation to keep LangGraph (with
resource semaphores inside node wrappers) and to carry 004's additions over
— see [004's plan](./004-visual-pipeline-builder/plan.md#consequences-for-spec-003).
It also means node-level progress streaming now exists ahead of Stage 2.

---

## Tool discovery (MCP) — unscheduled

Not part of the brief; requested separately. Exposes the platform's
capabilities to LLM clients over the Model Context Protocol, with
runtime tool discovery, over both a local process transport and an
authenticated network transport.

**Suggested placement: after Stage 2.** It is a surface over existing
capability, and the tools worth exposing (submit a run, poll its status,
cancel it, fetch artifacts) only exist once runs are asynchronous and
durable. Building it against Stage 1's synchronous, in-memory model
would mean rewriting it at Stage 2.

**Prior work to reuse**: spec
[`002-dynamic-dag-airllm-mcp`](./002-dynamic-dag-airllm-mcp/spec.md) is
superseded, but its
[`contracts/mcp-tools.md`](./002-dynamic-dag-airllm-mcp/contracts/mcp-tools.md)
and [`research.md`](./002-dynamic-dag-airllm-mcp/research.md) already
work out the tool catalog, the stdio-vs-HTTP transport split, and the
authentication trade-off. Start from those rather than re-researching.

---

## Cross-cutting: what not to make permanent

Brief §36. These are acceptable at early stages but must not survive as
architectural assumptions:

- Heavy model owned by the main API process → Stage 2 worker
- Whole workflow executed in one HTTP request → Stage 2 async runs
- Process-local locks as global accelerator coordination → Stage 2 queues/leases
- Physical model IDs chosen by the planner → never; server-controlled always
- Arbitrary templating as the dataflow definition → Stage 3 typed bindings
- Every operation implemented as an LLM node → Stage 3 deterministic nodes
- Large outputs stored inline → Stage 2 artifacts
- One generic retry policy → Stage 2 per-category policies
- Workflow state only in worker memory → Stage 2 persistence
- Arbitrary tool or network access for generated plans → never
- Automatic execution of unvalidated planner output → never

The four marked "never" are invariants, not staged improvements — they
hold from Stage 1 onward.

---

## Open questions

### Iteration has no target stage

Surfaced while planning Stage 1 ([research.md §8](./003-validated-dag-orchestration/research.md)).

The shipped `iterative-refinement` workflow loops — generate, critique,
revise, up to N times. Stage 1 drops the `loops` construct, so it is
parked under `pipelines/deferred/`.

`support-router` is parked alongside it but has a clear return path: the
brief's node-type catalog (§13) includes `condition`, which restores
conditional routing at Stage 4.

**Iteration has no such path.** The brief's node types are `llm`,
`transform`, `validate`, `split`, `map`, `reduce`, `condition`,
`retrieval`, `tool`, `human_approval`, `subworkflow` — none expresses
"repeat until a condition holds". `map` is bounded fan-out over a known
collection, not iteration to a fixed point.

Needs a decision before Stage 4:

- **Add a bounded-iteration node type** at Stage 4, with the same
  max-iteration and token-budget caps the brief already applies to `map`.
- **Express it as a subworkflow** invoked N times with a
  runtime-evaluated exit condition.
- **Retire the pattern** and accept that refine-until-approved is not
  something this platform expresses.

Until then `iterative-refinement.yaml` stays parked. It is preserved
rather than deleted specifically so the decision is made deliberately.

---

## Superseded

- [`002-dynamic-dag-airllm-mcp`](./002-dynamic-dag-airllm-mcp/spec.md) —
  superseded by 003. Retained for its MCP contracts and research.
- `001-visual-dag-graph` — removed 2026-08-27. Targeted the pre-Stage-1
  workflow schema. Recoverable from git at commit `97240fd`. Its read-only
  DAG view was absorbed into the editor built by spec
  [`004-visual-pipeline-builder`](./004-visual-pipeline-builder/spec.md).
