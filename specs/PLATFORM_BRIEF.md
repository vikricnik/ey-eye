# Master Brief: Local-First, Resource-Aware LLM Workflow Platform

## 1. Product vision

Build a **private AI workflow platform** that converts a user objective into a validated directed acyclic graph (DAG), assigns each node to an appropriate model or deterministic worker, schedules execution across constrained hardware, validates intermediate outputs, and returns an auditable result.

The platform should support:

- Multiple Ollama models
- Large models executed through AirLLM
- Deterministic Python operations
- Retrieval and approved tools
- Conditional branches
- Parallel fan-out and fan-in
- Structured intermediate results
- Retries, fallbacks, caching, and human approval
- Local-only and privacy-sensitive deployments

A concise product description:

> A private, resource-aware AI orchestration platform that compiles business objectives into validated model workflows and executes them across local and optional cloud inference infrastructure.

AirLLM is an execution backend, not the identity of the product. Its role is to provide a slow, high-capability reasoning tier on hardware with limited VRAM.

---

## 2. Core concept

The platform behaves like an AI compiler:

```text
User objective and constraints
            ↓
Logical workflow plan
            ↓
Validation and policy checks
            ↓
Deterministic plan compiler
            ↓
Physical execution plan
            ↓
Resource-aware DAG runtime
            ↓
Validated output, artifacts, and audit trail
```

Example input:

```json
{
  "objective": "Analyze an incident, identify the likely root cause, propose remediation, verify it, and produce an executive summary.",
  "constraints": {
    "privacy": "local_only",
    "quality": "high",
    "maximum_airllm_calls": 1,
    "maximum_runtime_seconds": 900
  }
}
```

Possible generated workflow:

```text
parse_logs ─────────────┐
extract_changes ────────┼── correlate_events ── root_cause ──┐
detect_anomalies ───────┘                                    │
                                                             ├── final_summary
root_cause ── remediation ── verification ───────────────────┘
```

---

## 3. Model hierarchy

Use models according to capability, latency, and resource cost.

```text
Small Ollama model
    → classification, extraction, routing, summarization

Medium Ollama model
    → writing, structured output, tools, normal reasoning

AirLLM model
    → slow, expensive, high-value deep reasoning

Optional cloud model
    → explicitly approved fallback only
```

AirLLM should normally be used for one or a small number of high-value nodes rather than every pipeline step.

---

## 4. Initial technology stack

Use:

- Python
- `uv` for dependency and environment management
- FastAPI for the control-plane API
- Pydantic for schemas
- `httpx` for Ollama communication
- AirLLM and PyTorch for large-model execution
- YAML for trusted predefined pipeline files
- JSON for LLM-generated plans
- PostgreSQL for durable plans, runs, and node state
- Artifact storage for documents and large outputs
- SSE for live run events
- OpenTelemetry for traces and metrics
- Python `graphlib.TopologicalSorter` for basic DAG validation

A durable workflow system such as Temporal may be added when workflows need multi-host execution, long waits, strong crash recovery, or human approval lasting hours or days.

---

## 5. Recommended architecture

```text
                         ┌──────────────────────────┐
Client ─────────────────►│ Stateless FastAPI API    │
                         │ auth, plans, runs, SSE   │
                         └─────────────┬────────────┘
                                       │
                     ┌─────────────────┼──────────────────┐
                     ▼                 ▼                  ▼
               Plan compiler      PostgreSQL       Event stream
               Policy engine      Run state        SSE/WebSocket
                     │
                     ▼
             Durable workflow runtime
               or persistent workers
                     │
          ┌──────────┼────────────┬──────────────┐
          ▼          ▼            ▼              ▼
       Ollama      AirLLM     deterministic   retrieval/tool
       worker      worker        workers          workers
          │          │
          ▼          ▼
       Ollama      one fixed model
                  per process/GPU

                   Artifact storage
             documents, outputs, provenance
```

The main architectural rule:

> FastAPI should be the control plane, not the long-running workflow runtime.

---

## 6. Separation of responsibilities

### FastAPI control plane

Responsible for:

- Authentication and authorization
- Creating plans
- Validating submitted inputs
- Starting runs
- Returning run status
- Streaming run events
- Cancellation requests
- Fetching outputs and artifacts
- Managing workflow versions
- Exposing model and capability metadata

It should not directly own long-running AirLLM inference in the production architecture.

### Plan compiler

Responsible for converting a logical workflow into a physical execution plan.

It decides:

- Which approved model alias executes each node
- Which queue or worker owns the node
- Timeouts and retry policies
- Token limits
- Resource requirements
- Fallback models
- Prompt-template versions
- Output schemas

### DAG runtime

Responsible for:

- Dependency tracking
- Fan-out and fan-in
- Scheduling ready nodes
- Resource acquisition
- Persistent state transitions
- Retry and fallback execution
- Cancellation
- Failure propagation
- Resuming after restarts

### Model workers

Responsible for model-specific behavior.

Examples:

```text
ollama-worker
airllm-qwen32b-worker
python-transform-worker
retrieval-worker
tool-worker
```

---

## 7. AirLLM integration

### MVP option

AirLLM may initially be loaded once during FastAPI lifespan and executed in a worker thread.

Requirements:

- Load one fixed AirLLM model per process
- Never load it inside an endpoint
- Never allow a client or planner to select an arbitrary Hugging Face repository
- Serialize access to the loaded model
- Treat concurrency as one per AirLLM instance
- Keep the resource lease until the underlying inference thread has completed
- Use one FastAPI worker when AirLLM is in-process

### Recommended production option

Move AirLLM into a dedicated service or worker.

```text
airllm-qwen32b-worker
    model: fixed model and revision
    concurrency: 1
    GPU ownership: exclusive or brokered
    shard storage: local NVMe
    health check: after model warmup
```

Prepare AirLLM models outside normal startup:

1. Download the exact model revision.
2. Split and prepare layer shards.
3. Store checksums and metadata.
4. Mount shards on fast local storage.
5. Start the worker.
6. Run a warmup inference.
7. Mark the worker ready.

For multiple AirLLM models, run one worker or service per model.

---

## 8. Ollama integration

Support multiple approved Ollama models through logical aliases.

The adapter should support:

- Chat messages or rendered prompts
- Model selection
- Temperature
- Top-p
- Maximum output tokens
- Structured JSON output where supported
- Tool calls where supported
- Streaming
- Model lifetime via `keep_alive`
- Timeouts
- HTTP errors
- Token and timing metadata

When Ollama and AirLLM share one GPU, use:

```yaml
keep_alive: 0
```

for Ollama nodes that must release VRAM before AirLLM executes.

This does not replace proper scheduling. All GPU work still needs to pass through the same resource broker or queue.

---

## 9. Logical model aliases

The planner should work with logical aliases rather than physical model names.

Example:

```yaml
model_capabilities:
  extract_fast:
    capability: structured_extraction
    cost_weight: 1
    latency_tier: interactive

  deep_reasoner:
    capability: deep_reasoning
    cost_weight: 8
    latency_tier: batch

  writer:
    capability: professional_writing
    cost_weight: 2

  verifier:
    capability: consistency_verification
    cost_weight: 2
```

Server-controlled physical registry:

```yaml
models:
  extract_fast:
    provider: ollama
    physical_model: qwen3:8b
    revision: local-2026-08
    supports:
      structured_output: true
      tools: false
      streaming: true

  deep_reasoner:
    provider: airllm
    physical_model: Qwen/Qwen3-32B
    revision: pinned-revision
    supports:
      structured_output: false
      tools: false
      streaming: false
    concurrency: 1
```

The LLM planner may select `deep_reasoner`. It may not change the physical model, revision, endpoint, queue, GPU, or dependency versions.

---

## 10. Logical and physical plans

Keep two immutable artifacts.

### Logical plan

Describes what must happen:

```yaml
nodes:
  - id: analyze
    task: analyze_evidence
    capability: deep_reasoning
    quality_tier: high
    latency_tier: batch
```

### Compiled physical plan

Describes exactly how it will execute:

```yaml
nodes:
  - id: analyze
    provider: airllm
    model_alias: deep_reasoner
    physical_model_revision: qwen32b-pinned
    queue: airllm-qwen32b
    timeout_seconds: 900
    max_new_tokens: 600
```

Hash and store the compiled plan so a run can be reproduced even after routing rules change.

---

## 11. DAG definition

A basic executable YAML DAG may initially look like this:

```yaml
version: 1
max_parallel_nodes: 4

resources:
  gpu0: 1
  ollama_server: 2
  airllm_instance: 1

models:
  extract_fast:
    provider: ollama
    model: qwen3:8b
    resources:
      - gpu0
      - ollama_server
    temperature: 0
    max_new_tokens: 300
    keep_alive: 0

  deep_reasoner:
    provider: airllm
    model: Qwen/Qwen3-32B
    resources:
      - gpu0
      - airllm_instance
    temperature: 0.2
    max_input_tokens: 3000
    max_new_tokens: 500

  writer:
    provider: ollama
    model: qwen3:8b
    resources:
      - gpu0
      - ollama_server
    temperature: 0.3
    max_new_tokens: 500
    keep_alive: 0

nodes:
  - id: extract
    uses: extract_fast
    depends_on: []
    prompt: |
      Extract relevant facts from:
      {{ input.text }}

  - id: analyze
    uses: deep_reasoner
    depends_on:
      - extract
    prompt: |
      Analyze these facts:
      {{ nodes.extract.output }}

      Question:
      {{ input.question }}

  - id: final
    uses: writer
    depends_on:
      - analyze
    prompt: |
      Produce the final answer:
      {{ nodes.analyze.output }}

output: final
```

This is suitable for the MVP, but later versions should replace raw prompt references with typed bindings.

---

## 12. Improved typed node format

Prefer explicit input bindings and approved prompt templates:

```yaml
- id: analyze
  kind: llm
  task: analyze_evidence

  inputs:
    facts:
      from: nodes.extract.output
    question:
      from: input.question

  prompt_template: analyze_evidence_v3
  output_schema: analysis_result_v1

  execution:
    timeout_seconds: 900
    max_attempts: 2

  fallback:
    capabilities:
      - deep_reasoning
```

Benefits:

- Dependencies can be inferred
- Hidden dependencies are impossible
- Input and output types can be validated
- Prompt templates are versioned separately
- Template injection risk is reduced
- Graph lineage is clearer

Internally, the compiler may generate `depends_on`, but it should derive it from input bindings.

---

## 13. Node types

Not every node should call an LLM.

Support these node kinds over time:

```text
llm
transform
validate
split
map
reduce
condition
retrieval
tool
human_approval
subworkflow
```

Examples of deterministic nodes:

- Parse JSON
- Validate a schema
- Split a document
- Merge arrays
- Normalize records
- Calculate hashes
- Filter results
- Evaluate branch conditions
- Limit context length

---

## 14. Structured outputs

Use typed JSON between nodes whenever possible.

Prefer:

```json
{
  "claims": [
    {
      "text": "The service failed after deployment.",
      "source_reference": "log-184",
      "confidence": 0.93
    }
  ],
  "uncertainties": []
}
```

instead of unstructured prose.

Every node should declare an output schema.

For models with native structured-output support:

1. Pass the schema to the provider.
2. Validate the returned JSON.

For AirLLM or models without reliable schema constraints:

1. Prompt for the required schema.
2. Parse and validate.
3. Perform one bounded repair attempt.
4. Optionally fall back to a structured-output model.
5. Fail the node if validation still fails.

---

## 15. DAG validation

Before a plan can execute, validate:

- Unique node IDs
- Existing model aliases
- Existing dependency references
- No self-dependencies
- No duplicate dependencies
- Existing output node
- No graph cycles
- No orphan nodes
- Every node contributes to the output
- Valid resource names and capacities
- Valid input references
- Valid output-schema references
- Valid node types
- Bounded node count
- Bounded graph depth
- Bounded fan-out
- Bounded map expansion
- Bounded token budget
- Bounded cost
- Bounded AirLLM usage
- Valid privacy and provider rules

Do not silently repair invalid execution plans inside the runtime.

---

## 16. Template restrictions for the MVP

When raw templates are still supported, permit only:

```jinja2
{{ input.FIELD }}
{{ nodes.DEPENDENCY.output }}
```

Reject:

- Jinja loops
- Filters
- Function calls
- Template statements
- Template comments
- Arbitrary attribute traversal
- Unknown input fields
- Undeclared node references
- Malformed placeholders

Use strict rendering so missing fields fail explicitly.

---

## 17. Resource-aware scheduling

The scheduler must understand that different nodes compete for limited resources.

Example:

```yaml
resources:
  gpu0: 1
  ollama_server: 2
  airllm_instance: 1
  cpu_general: 8
```

Ollama node:

```yaml
resources:
  - gpu0
  - ollama_server
```

AirLLM node:

```yaml
resources:
  - gpu0
  - airllm_instance
```

With `gpu0: 1`, Ollama and AirLLM are serialized even across separate pipeline runs.

Acquire multiple resources in a stable order to avoid deadlocks.

### Important improvement

Process-local `asyncio.Semaphore` objects are sufficient only for a single-process MVP.

For production, use:

- Dedicated resource queues
- Dedicated GPU ownership
- Distributed leases with heartbeats
- A durable workflow engine

The simplest reliable deployment is:

```text
GPU 0 → Ollama workers
GPU 1 → AirLLM worker
```

---

## 18. DAG execution behavior

The runtime must:

- Find all ready nodes
- Run independent branches concurrently where resources permit
- Wait for all parents before fan-in
- Pass parent outputs into dependent nodes
- Enforce maximum parallelism
- Persist state transitions
- Apply node-specific retries
- Apply explicit fallbacks
- Cancel pending branches after terminal failure where appropriate
- Support cooperative cancellation
- Return the failed node ID and sanitized error
- Resume after worker or process restart

Suggested node states:

```text
PENDING
READY
QUEUED
RUNNING
SUCCEEDED
FAILED
RETRY_WAIT
CANCEL_REQUESTED
CANCELLED
SKIPPED
WAITING_FOR_APPROVAL
```

---

## 19. Durable execution API

Avoid keeping one HTTP request open for the entire pipeline.

Use:

```text
POST /v1/runs
    → validate and enqueue
    → return 202 and run_id

GET /v1/runs/{run_id}
    → current state and outputs

GET /v1/runs/{run_id}/events
    → SSE progress stream

POST /v1/runs/{run_id}/cancel
    → request cancellation

POST /v1/runs/{run_id}/retry
    → retry failed work

POST /v1/runs/{run_id}/resume
    → resume a paused run
```

Run events might include:

```json
{"event": "node_queued", "node": "extract"}
{"event": "node_started", "node": "extract"}
{"event": "node_output_delta", "node": "draft", "text": "..."}
{"event": "node_completed", "node": "extract"}
{"event": "run_completed"}
```

---

## 20. Planning API

Use a separate plan phase.

```text
POST /v1/dags/plan
```

Input:

```json
{
  "objective": "Analyze a document and answer the question.",
  "input_fields": ["text", "question"],
  "constraints": {
    "privacy": "local_only",
    "quality": "high",
    "maximum_airllm_calls": 1
  }
}
```

Return:

- Plan ID
- Logical plan
- Compiled plan summary
- Validation status
- Estimated latency tier
- Estimated model usage
- Estimated token budget
- Optional YAML preview
- Approval status

Execution should use the stored, validated plan:

```text
POST /v1/dags/{plan_id}/execute
```

Do not accept a silently modified YAML document at execution time.

---

## 21. LLM-generated DAGs

An LLM may generate a DAG, but it acts only as a planner.

```text
Objective
    ↓
Planner LLM
    ↓
Structured logical plan
    ↓
Pydantic validation
    ↓
Graph validation
    ↓
Policy and cost validation
    ↓
Deterministic compilation
    ↓
Stored executable plan
```

The core rule:

> The LLM proposes the workflow; deterministic server code authorizes and compiles it.

Use an Ollama model initially because structured JSON output is convenient.

The planner may select only approved capabilities and aliases.

It must not control:

- Physical model names
- Model repository IDs
- Provider URLs
- GPU assignments
- Queues
- Resource capacities
- Secrets
- Filesystem paths
- Shell commands
- Arbitrary URLs
- Database credentials
- Unapproved tools

---

## 22. Planner strategy

Prefer approved workflow patterns over unrestricted graph generation.

Initial pattern catalog:

```text
document_qa
map_reduce_summary
candidate_judge
extract_analyze_verify
support_diagnosis
code_review
incident_root_cause
contract_review
```

Planner output example:

```json
{
  "pattern": "extract_analyze_verify",
  "requires_deep_reasoning": true,
  "requires_verification": true,
  "extraction_focus": "contractual obligations"
}
```

The compiler expands this into a validated graph.

Allow free-form graph generation only as a fallback with stricter policy checks or human approval.

---

## 23. Planner limits

Initial limits could include:

- Maximum 8 nodes
- Maximum 5 parents per node
- Maximum graph depth
- Maximum fan-out
- Maximum one AirLLM node
- Maximum total token budget
- Maximum weighted model cost
- Maximum map items
- Exactly one output node
- No orphan nodes
- No arbitrary tools
- No unapproved providers
- Verifier required for designated sensitive workflows

A bounded repair loop may be used:

```text
Planner draft
    ↓
Validation error
    ↓
Planner receives concise errors
    ↓
Complete corrected draft
    ↓
Validation again
```

Limit repair attempts, for example to two.

---

## 24. Example DAG patterns

### Document question answering

```text
extract_facts ─────┐
                   ├── analyze ──┬── draft ────┐
find_issues ───────┘             │              ├── final
                                 └── verify ────┘
```

### Map/reduce summary

```text
summarize_chunk_1 ─┐
summarize_chunk_2 ─┼── merge ── extract_actions ── final
summarize_chunk_3 ─┘
```

### Candidate generation and judging

```text
fast_candidate ───┐
deep_candidate ───┼── judge ── final
counterargument ──┘
```

### Code review

```text
bug_analysis ──────┐
security_review ───┼── root_cause ──┬── patch_plan ─┐
requirements ──────┘                └── test_plan ──┼── final
```

### Support diagnosis

```text
classify ──────────┐
extract_evidence ──┼── diagnose ──┬── resolution ───┐
known_attempts ────┘              └── safety_check ─┼── final_reply
```

---

## 25. Conditional and dynamic execution

Add deterministic conditions:

```yaml
- id: escalation
  kind: llm
  when:
    field: nodes.classify.output.severity
    operator: in
    value:
      - high
      - critical
```

The runtime, not an LLM, should evaluate the condition.

Support bounded dynamic map/reduce:

```yaml
- id: summarize_chunks
  kind: map
  over: nodes.split.output.chunks
  max_items: 50
  concurrency: 4
  body:
    task: summarize_chunk
```

Enforce:

- Maximum item count
- Maximum aggregate tokens
- Maximum concurrency
- Maximum cost
- Maximum expansion depth

Mid-execution LLM replanning should not be part of the first implementation.

---

## 26. Retry and fallback behavior

Use node-specific error policies.

```text
Provider timeout
    → retry with backoff

Provider unavailable
    → retry, then fallback

Invalid structured output
    → repair once, then fallback

Context too large
    → deterministic compression or fail

Unknown model alias
    → non-retryable configuration failure

Policy violation
    → non-retryable

Worker crash
    → recover from persisted node state
```

Fallbacks must be explicit in the compiled plan.

Example:

```yaml
fallback:
  - model_alias: qwen_reasoner_ollama
    on:
      - provider_unavailable
      - timeout

  - model_alias: writer
    on:
      - schema_validation_failed
```

Use idempotency keys for node attempts.

---

## 27. Plan and run persistence

### Plans

Store:

- Plan ID
- Logical plan
- Compiled plan
- Plan hash
- Planner model and version
- Planner prompt version
- Objective
- Constraints
- Validation result
- Repair attempts
- Approval status
- Creation timestamp

### Runs

Store:

- Run ID
- Plan ID
- Status
- Input artifact references
- Start and finish times
- Final output artifact
- Error classification
- Cancellation status

### Node attempts

Store:

- Node ID
- Attempt number
- Model alias
- Physical model revision
- Resource queue
- Input hash
- Output artifact
- Queue duration
- Resource wait duration
- Execution duration
- Token counts
- Validation result
- Retry or fallback decision

---

## 28. Artifact storage

Do not keep large source documents and model outputs inline in run rows.

Use artifact references:

```json
{
  "artifact_id": "art_7c82",
  "sha256": "…",
  "content_type": "application/json",
  "size_bytes": 187420
}
```

Artifacts may include:

- Source documents
- Prompt payloads
- Structured intermediate outputs
- Final reports
- Retrieved evidence
- Logs
- Generated files
- Provenance metadata

Content hashing enables caching, integrity checks, duplicate detection, and incremental re-execution.

---

## 29. Caching

Use content-addressed caching based on:

```text
node definition
+ physical model revision
+ prompt-template version
+ normalized input hash
+ generation settings
+ output schema version
```

Cache suitable nodes such as:

- Extraction
- Classification
- Deterministic transformations
- Low-temperature summarization
- Retrieval results with a defined TTL

Do not cache side-effecting tools unless explicitly designed for idempotent replay.

---

## 30. Human approval

Support approval nodes for sensitive or expensive operations.

```yaml
- id: approve_plan
  kind: human_approval
  message: Review the proposed remediation plan.
  timeout: 24h
  on_timeout: fail
```

Approval may be required before:

- Sending external messages
- Modifying a production system
- Running an expensive graph
- Publishing generated content
- Executing sensitive tools
- Using an external model
- Processing regulated data

---

## 31. Security requirements

- Use `yaml.safe_load`
- Reject unknown schema fields
- Never allow arbitrary model IDs
- Never execute planner-generated shell commands
- Never expose secrets to planner prompts
- Keep provider configuration server-controlled
- Restrict input size
- Restrict prompt size
- Restrict token budgets
- Restrict graph expansion
- Allowlist tools
- Validate every tool argument
- Enforce tenant and role permissions
- Redact sensitive prompt and response logging
- Store audit records
- Add authentication and rate limiting
- Apply privacy policies before routing to any external provider

Example policy:

```yaml
privacy:
  external_models: forbidden
  prompt_logging: redacted
  artifact_retention_days: 30
```

---

## 32. Observability

Create one distributed trace per workflow run.

```text
run trace
├── planning
├── compilation
├── extraction node
│   └── Ollama inference
├── analysis node
│   ├── resource wait
│   └── AirLLM inference
└── final node
    └── Ollama inference
```

Record:

- Run ID
- Plan ID
- Node ID
- Tenant ID
- Logical capability
- Model alias
- Physical model and revision
- Queue duration
- Resource wait duration
- Time to first token
- Inference duration
- Input and output tokens
- Retry count
- Fallback count
- Cache status
- Validation status
- AirLLM disk throughput
- Model load time
- Error classification

Do not log full sensitive prompts or responses by default.

---

## 33. Evaluation

Maintain golden test sets for:

- Planner quality
- Graph validity
- Final answer quality
- Structured-output compliance
- Latency
- Cost
- AirLLM usage frequency
- Verification effectiveness
- Failure recovery
- Fallback behavior
- Cache correctness

Any new planner, prompt, compiler, workflow pattern, or model version should run against these evaluations before promotion.

---

## 34. API outline

```text
GET  /health
GET  /v1/models
GET  /v1/capabilities
GET  /v1/workflows

POST /v1/dags/plan
GET  /v1/dags/{plan_id}
POST /v1/dags/{plan_id}/approve
POST /v1/dags/{plan_id}/execute

POST /v1/runs
GET  /v1/runs/{run_id}
GET  /v1/runs/{run_id}/events
POST /v1/runs/{run_id}/cancel
POST /v1/runs/{run_id}/retry
POST /v1/runs/{run_id}/resume

GET  /v1/runs/{run_id}/nodes
GET  /v1/runs/{run_id}/artifacts
```

---

## 35. Features by priority

### Highest priority

- YAML-defined DAGs
- Ollama and AirLLM provider adapters
- Graph validation
- Shared resource scheduling
- Persistent run state
- Separate planning and execution
- Structured node outputs
- SSE progress events
- Cancellation
- Node-specific retry and fallback
- Dedicated AirLLM worker
- Model capability registry
- Typed node bindings
- Artifact storage
- Authentication and rate limiting

### Medium priority

- Conditional branches
- Bounded map/reduce
- Content-addressed caching
- Human approval
- Dry-run and cost estimation
- DAG visualization
- Restart-from-node
- Run cloning
- Workflow pattern catalog
- Cloud fallback policies

### Later priority

- Mid-execution replanning
- Multi-tenant fairness
- Priority scheduling
- Learned model routing
- Workflow marketplace
- Organization-wide governance dashboards
- Cross-region execution
- Advanced compensation for side-effecting workflows

---

## 36. What to avoid

Avoid making these permanent architectural assumptions:

```text
✗ AirLLM owned by the main FastAPI process
✗ Entire workflow executed in one HTTP request
✗ Process-local locks used as global GPU coordination
✗ Physical model IDs generated by the planner
✗ Arbitrary Jinja used as the main dataflow definition
✗ Every operation implemented as an LLM node
✗ Large outputs stored inline in database rows
✗ One generic retry policy for every failure
✗ Workflow state existing only in worker memory
✗ Arbitrary tool or network access for generated plans
✗ Automatic execution of unvalidated planner output
```

---

## 37. Implementation stages

### Stage 1: Single-host workflow runner

**Goal:** Prove mixed Ollama and AirLLM DAG execution.

Build:

- FastAPI application
- `uv` project setup
- One fixed AirLLM model loaded at startup
- Multiple approved Ollama aliases
- YAML DAG schema
- Pydantic validation
- Cycle and dependency validation
- Restricted templates
- Basic `asyncio` DAG scheduler
- Process-wide resource semaphores
- One predefined pipeline endpoint
- Health endpoint
- Basic node timing and error reporting
- Unit tests

Exit criteria:

- A YAML DAG mixing Ollama and AirLLM executes
- Fan-out and fan-in work
- Invalid cycles are rejected
- AirLLM is loaded only once
- Shared-GPU calls are serialized
- Multiple simultaneous requests respect the same local resource limits

### Stage 2: Durable orchestration service

**Goal:** Make runs reliable and operationally usable.

Build:

- PostgreSQL plan and run store
- Persistent workers or queue
- Asynchronous run submission
- Run status API
- SSE events
- Cancellation
- Persistent node state
- Retry and fallback policies
- Artifact storage
- Restart recovery
- Dedicated AirLLM worker
- Dedicated Ollama adapter or worker
- Structured logs and basic metrics

Exit criteria:

- A process restart does not lose run state
- Failed nodes can be retried
- Long workflows do not require an open request
- AirLLM can be restarted independently from FastAPI
- Run history and artifacts are inspectable

### Stage 3: AI workflow compiler

**Goal:** Separate intent from infrastructure.

Build:

- Logical DAG schema
- Physical compiled-plan schema
- Model capability registry
- Deterministic plan compiler
- Typed input bindings
- Typed output schemas
- Versioned prompt templates
- Cost and latency estimation
- Dry-run mode
- Content-addressed caching
- Explicit plan hashing and reproducibility

Exit criteria:

- Workflow definitions use capabilities rather than physical models
- Every run records an immutable compiled plan
- Nodes exchange validated structured data
- The compiler can route tasks deterministically
- Plans can be reproduced after model-registry changes

### Stage 4: Controlled agent platform

**Goal:** Let LLMs adapt workflows safely.

Build:

- LLM DAG planner
- Structured planner output
- Pattern catalog
- Planner policy engine
- Bounded repair loop
- Conditional nodes
- Bounded dynamic map/reduce
- Human approval
- Retrieval and allowlisted tools
- Plan risk classification
- Verification requirements
- Approval before sensitive execution

Exit criteria:

- An LLM can create a valid logical plan
- The planner cannot control physical infrastructure
- Invalid plans never execute
- Sensitive actions require approval
- Dynamic behavior remains bounded and auditable

### Stage 5: Organization-wide AI control plane

**Goal:** Operate as shared enterprise infrastructure.

Build:

- Multi-tenancy
- Team and role permissions
- Quotas and token budgets
- Priority and fair scheduling
- Model deployment registry
- Workflow versioning
- Evaluation dashboards
- Cost accounting
- Retention policies
- Audit exports
- Tenant-specific privacy policies
- Optional cloud-provider integrations
- High availability
- Durable multi-host execution

Exit criteria:

- Multiple teams safely share the platform
- Resource usage is attributable and controlled
- Models and workflows can be promoted through environments
- Every execution is reproducible and auditable
- Policies govern where and how data is processed

### Stage 6: Workflow ecosystem

**Goal:** Turn workflows into reusable products.

Build:

- Versioned workflow packages
- Workflow marketplace or internal catalog
- Input and output contracts
- Evaluation suites bundled with workflows
- Compatibility declarations
- Security and privacy metadata
- Performance profiles
- Installation and upgrade mechanisms

A workflow package could contain:

```text
contract-risk-review:v4
├── logical DAG
├── prompt templates
├── schemas
├── capability requirements
├── policy requirements
├── evaluation dataset
├── expected latency
└── supported compiler versions
```

---

## 38. Initial acceptance criteria

The first serious implementation should satisfy all of the following:

- A DAG can mix Ollama and AirLLM nodes
- One fixed AirLLM model is loaded once per worker
- Several approved Ollama models can be selected by alias
- Independent nodes can run concurrently when resources permit
- Shared-GPU inference is serialized
- Concurrent pipeline requests respect global resource limits
- Cyclic graphs are rejected before execution
- Unknown dependencies are rejected
- Hidden template dependencies are rejected
- Unknown model aliases are rejected
- A failed node identifies the node and error category
- Generated plans are structured and validated
- The planner cannot change physical model IDs or GPU assignments
- A validated plan can be stored and executed by plan ID
- Node outputs can be schema-validated
- Run state survives API restarts by Stage 2
- Logs include run, plan, node, model, and timing metadata
- Tests cover validation, scheduling, locking, routing, planning, retries, and policy enforcement

---

## 39. Long-term outcome

This can evolve through the following identity changes:

```text
FastAPI model gateway
        ↓
Mixed-model DAG runner
        ↓
Durable AI workflow service
        ↓
AI workflow compiler
        ↓
Controlled private agent platform
        ↓
Organization-wide AI control plane
        ↓
Workflow ecosystem or marketplace
```

The most defensible long-term focus is:

- Local-first deployment
- Resource-aware scheduling
- Capability-based routing
- Typed and validated DAGs
- Controlled LLM planning
- AirLLM as a batch reasoning tier
- Full provenance and auditability
- Safe integration of tools and human approvals
- Reliable execution on limited private infrastructure
