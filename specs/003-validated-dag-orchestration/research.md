# Phase 0 Research: Single-Host Resource-Aware DAG Runner

Resolved by codebase inspection, one empirical test (§3), and targeted
research on the two external interfaces this stage adds. No
`NEEDS CLARIFICATION` markers remain.

## 1. Replace LangGraph with a first-party scheduler

- **Decision**: Remove `langgraph`, `langchain-core`, and
  `langchain-ollama`. Write the scheduler as first-party asyncio code;
  use `graphlib.TopologicalSorter` for validation only.
- **Rationale**: The requirement LangGraph cannot express is FR-027/FR-028
  — capacity shared *across concurrent runs*. LangGraph schedules a single
  graph by topology; two simultaneous requests are two independent graph
  executions with no channel between them, so nothing stops both from
  entering their heavy-model node at once. Serialization has to live in a
  process-wide object the scheduler consults before dispatching a step,
  which means the dispatch loop is ours regardless. Once the loop is
  first-party, LangGraph's remaining contribution is state-merge reducers
  for a state shape we no longer have (branches and loops are gone), so
  it becomes a dependency that constrains without carrying weight.
- **Alternatives considered**:
  - *Keep LangGraph, wrap each node in a resource-acquiring closure.* Fails
    FR-022: LangGraph decides how many nodes are in flight, so a step
    blocked on a semaphore still counts against its own concurrency and
    can deadlock a superstep against a step that would release the
    resource. It also makes "queue duration" (FR-026) unmeasurable —
    waiting happens inside a node LangGraph already considers running.
  - *Keep LangGraph for topology, add an external broker.* Two schedulers
    disagreeing about what is runnable; the failure mode is a
    hard-to-reproduce stall.

## 2. Deadlock-free multi-resource acquisition

- **Decision**: One `asyncio.Semaphore` per named resource, held in a
  `ResourcePool`. A step needing several acquires them in **sorted order
  by resource name**, always, and releases in reverse. One
  `async with pool.lease(names)` context manager is the only acquisition
  path.
- **Rationale**: Deterministic global ordering is the standard prevention
  for the hold-and-wait cycle (step A holds `gpu0` wanting
  `ollama_server`, step B holds `ollama_server` wanting `gpu0`). Sorting
  by name is total, stable, and needs no coordination. Making the context
  manager the only path means the ordering cannot be bypassed by a caller
  who acquires "just one more thing" ad hoc.
- **Alternatives considered**:
  - *Acquire in declaration order.* The YAML author's ordering becomes a
    correctness property — two workflows listing the same resources
    differently deadlock each other. Silent and load-dependent.
  - *Global lock around all acquisition.* Correct but serializes every
    step's admission including non-competing ones, defeating SC-003.

## 3. Holding the heavy-model lease past cancellation

- **Decision**: Run AirLLM inference on a dedicated single-thread
  executor. Await it under `asyncio.shield`; on `CancelledError`, **wait
  for the underlying future to finish before releasing the lease**, then
  re-raise. Release happens in a `finally` that is only reachable after
  the thread is genuinely done.
- **Rationale**: This is the one place a plain `async with` is actively
  wrong, and it is demonstrable rather than theoretical. Measured
  directly:

  ```
  awaiter cancelled at 0.05s
  thread still ran to completion (0.3s) -> lease would have leaked
  ```

  `asyncio.to_thread` delegates to `run_in_executor`; a
  `concurrent.futures.Future` whose thread has already started cannot be
  cancelled. So a naive context manager releases the accelerator ~250ms
  before inference stops, letting an Ollama step load weights into memory
  the heavy model is still using. FR-031 and FR-038 exist precisely for
  this, and the shield-and-drain pattern is what satisfies them.
- **Alternatives considered**:
  - *Plain `async with sem: await asyncio.to_thread(...)`.* The measured
    failure above. Rejected.
  - *Make inference interruptible.* AirLLM exposes no cancellation hook,
    and a partially torn-down layer-streaming forward pass is not a state
    worth reaching. Draining is correct: the work is already paid for.
  - *Daemon thread, abandon on cancel.* Trades a lease leak for a memory
    leak plus a non-deterministic accelerator.

## 4. Restricted template validation

- **Decision**: Validate with Jinja2's parser, then walk the AST and
  reject any node type outside a small allowlist — permitting only
  `Output`, `TemplateData`, and `Getattr`/`Name` chains resolving to
  exactly `input.FIELD` or `nodes.STEP.output`. Render with
  `StrictUndefined`. Validation runs at load time (FR-018), never at step
  execution.
- **Rationale**: An allowlist over the parsed AST fails closed — a Jinja
  construct nobody anticipated is rejected because it is absent from the
  allowlist, not because someone remembered to ban it. The existing
  `_check_template_references` uses `jinja2.meta` for undeclared
  variables, which is the right library but the wrong strictness: it
  cannot see `{% for %}`, filters, or calls at all. Rejecting by node type
  closes that.
- **Alternatives considered**:
  - *Regex extraction, no Jinja.* Tempting given only two forms are legal,
    but regex cannot reliably distinguish `{{ nodes.a.output }}` from
    `{{ nodes.a.output|e }}` or nested/escaped delimiters, and a
    near-miss silently becomes literal text sent to a model.
  - *Blocklist of dangerous constructs.* Fails open on anything not
    enumerated. Wrong default for a surface that will later accept
    machine-generated templates.

## 5. Ollama adapter over httpx directly

- **Decision**: Call `POST /api/generate` with `httpx.AsyncClient`,
  `stream: false`, `options: {temperature, top_p, num_predict}`, and
  top-level `keep_alive`. One shared client created in lifespan. Drop
  `langchain-ollama`.
- **Rationale**: FR-032 requires per-alias control of `keep_alive` and a
  request timeout, and FR-025 requires distinguishing *unreachable* from
  *timed out*. `langchain-ollama` normalizes transport errors into its own
  exceptions, which is exactly the information FR-025 needs preserved —
  `httpx.ConnectError` vs `httpx.ReadTimeout` maps cleanly to two
  categories, and a LangChain wrapper flattens that distinction.
  `keep_alive: 0` also has to reach the wire unmodified for the
  shared-accelerator case. Going direct removes a dependency and gains
  fidelity. Confirmed parameter shape:
  [ollama/docs/api.md](https://github.com/ollama/ollama/blob/main/docs/api.md?plain=1).
- **Alternatives considered**:
  - *Keep `langchain-ollama`.* Retains a LangChain dependency after
    LangGraph is gone, for a single non-streaming POST, while obscuring
    the error taxonomy FR-025 depends on.

## 6. Failure categorization from the start

- **Decision**: A `FailureCategory` enum — `PROVIDER_TIMEOUT`,
  `PROVIDER_UNAVAILABLE`, `CONFIGURATION`, `VALIDATION`, `INPUT_TOO_LARGE`,
  `BACKEND_UNAVAILABLE`, `INTERNAL` — assigned at the raise site by a
  single `classify(exc)` function, carried on the error, and reported in
  both the response and structured logs.
- **Rationale**: Stage 2's whole retry/fallback design keys off failure
  category (brief §26: timeout → retry, unavailable → retry then fallback,
  unknown alias → non-retryable). Introducing the taxonomy after failures
  are already flowing means retrofitting classification into every raise
  site with no way to verify coverage. Adding it now costs one enum and
  one function, and makes FR-024/SC-005 checkable.
- **Alternatives considered**:
  - *Defer to Stage 2 with the category as free-text.* Free-text
    categories drift into unmatched strings; the retry table then silently
    fails to match and every failure becomes non-retryable.

## 7. AirLLM startup strictness and availability reporting

- **Decision**: `AIRLLM_REQUIRED` (bool). On load failure: strict → raise
  during lifespan so startup fails; permissive → log an error, mark the
  backend unavailable, serve everything else. Availability is reported by
  `/health` and any step routed to an unavailable backend fails with
  `BACKEND_UNAVAILABLE` at execution — never at validation.
- **Rationale**: Matches the clarified requirement (FR-040) and keeps the
  development machine viable: on macOS the CUDA/bitsandbytes path will not
  load, and everything except heavy-model execution — validation,
  scheduling, resource contention, the Ollama tier — must stay testable.
  Failing at execution rather than validation matters: a workflow's
  *shape* is valid regardless of which host loads it, so rejecting it at
  validation would make definitions non-portable between machines.
- **Alternatives considered**:
  - *Reject AirLLM workflows at validation when unavailable.* Makes
    validity host-dependent; the same file would validate on the server
    and fail on a laptop, undermining the determinism FR-009 promises.

## 8. Migrating the shipped workflows — two cannot be expressed

- **Decision**: Migrate the three pure-DAG workflows
  (`simple-local`, `consensus-qa`, `code-review-pipeline`). Move
  `support-router.yaml` and `iterative-refinement.yaml` to
  `pipelines/deferred/` with a header comment naming the construct they
  need and the stage that provides it. `deferred/` is not scanned by the
  registry.
- **Rationale**: `support-router` routes conditionally (`branches`);
  `iterative-refinement` iterates (`loops`) *and* uses a
  `{% if critique is defined %}` statement that FR-014 forbids outright.
  Stage 1 has no conditional or iterative construct, by design. Rewriting
  them as pure DAGs would destroy their purpose — the router's value *is*
  running exactly one of three branches, and forcing all three to run
  triples cost and returns nonsense. Deleting them discards working
  reference material. Parking is the honest option, and SC-010 was
  amended to require a documented target stage rather than silent
  removal.
- **Open roadmap question this surfaced**: the brief's node-type catalog
  (§13) includes `condition`, which restores `support-router` at Stage 4 —
  but defines **no loop or iterate construct at any stage**. As written,
  `iterative-refinement` has no return path. Either Stage 4 gains a
  bounded-iteration node type, or that workflow is permanently retired.
  Flagged in ROADMAP.md rather than silently decided here.
- **Alternatives considered**:
  - *Add conditional routing to Stage 1.* Pulls Stage 4 forward — the
    exact scoping error that already forced this spec to be cut back once.
  - *Leave them in place, failing validation.* Startup validation would
    log two permanent errors, training operators to ignore startup errors.

## 9. TypeScript client migration is a simplification, not a rewrite

- **Decision**: Keep the graph rendering; strip its branch/loop paths.
  `packages/client/src/types.ts` is regenerated against the new contract;
  `graphModel.ts` (360 lines, 91 branch/loop references) and
  `web/src/graphView.ts` (451 lines, 31 references) lose those code paths;
  `cli/src/formatter.ts` loses 4. Net deletion.
- **Rationale**: The spec's "clients must be migrated" understated this —
  removing branches and loops invalidates roughly 800 lines of
  already-implemented visualization built specifically to draw them. But
  the direction is subtractive: a pure DAG is the *easy* case those
  renderers already handle, plus edge-classification and route-labelling
  logic that becomes dead. Deleting the visualization outright was
  considered and rejected — it still works for the new schema once
  simplified, and the brief lists DAG visualization as a live
  medium-priority item (§35).
- **Note**: this code is the implemented remnant of removed spec 001. Its
  spec is gone; the code is not, and this stage inherits responsibility
  for it.

## 10. Capabilities deliberately dropped in migration

- **Decision**: Conversation history (`history.py`, `contextual_input`,
  `max_history_turns`) is removed as a server-side concept, along with
  `safe_eval.py` (which existed only to evaluate branch conditions) and
  `state.py` (LangGraph state shape).
- **Rationale**: The new contract takes typed input *fields* (FR-042,
  FR-043) rather than a prompt-plus-history pair. History is not lost as a
  capability — a workflow declares a `history` input field and templates
  it where it wants — it stops being a special server-side transformation
  applied invisibly to every prompt. That is strictly more explicit and
  removes a module. `safe_eval` has no remaining caller once branch `when`
  expressions are gone; keeping a sandboxed-expression evaluator with no
  callers is a liability, and Stage 4's `condition` nodes should
  re-derive their evaluator against that stage's typed data model rather
  than inherit one built for string outputs.
- **Alternatives considered**:
  - *Keep history as a built-in.* Preserves a bespoke concept the brief
    never mentions and the new input model supersedes.
  - *Keep `safe_eval.py` dormant for Stage 4.* Dead code that looks live;
    recoverable from git when Stage 4 needs it.

## External interface findings

- **Ollama** `/api/generate`: `stream: false` returns one JSON object;
  generation knobs live under `options` (`num_predict`, `temperature`,
  `top_p`); `keep_alive` is top-level and accepts `0` to release memory
  immediately. Source:
  [ollama/docs/api.md](https://github.com/ollama/ollama/blob/main/docs/api.md?plain=1).
- **AirLLM**: `AutoModel.from_pretrained(repo_id, compression=...)` loads
  a Hugging Face repo for layer-streamed low-memory inference; exposes a
  tokenizer and a **synchronous** `generate(...)`. No async API and no
  cancellation hook — the basis for §3. Source:
  [airllm · PyPI](https://pypi.org/project/airllm/),
  [lyogavin/airllm](https://github.com/lyogavin/airllm/blob/main/README.md).
