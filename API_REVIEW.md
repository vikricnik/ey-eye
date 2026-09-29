# API Design Review — `feature/yaml_based_pipelines`

- **Reviewed commit**: `268cd78` (branch compared with `main`)
- **Date**: 2026-09-27
- **Review type**: API design (arxitect `api-design-review`)

**Scope:** all public surfaces changed on this branch compared with `main`:

- the REST API (`llm_pipeline/llm_pipeline/routers/*`, `api_schemas.py`, `error_handling.py`)
- the YAML pipeline schema and its template variables
- the `@llm-pipeline/client` TypeScript package (`packages/client`)
- the CLI command surface (`cli/src`)
- Python functions used across modules

Spec 003's `/v1/workflows` contract isn't built yet, so the code was reviewed
as it stands. The spec was used only to check whether today's choices will
clash with it.

---

## VERDICT: CHANGES_REQUESTED

## Summary

Most of the API is carefully designed: every error uses one shape, the
streaming contract is typed, and the YAML schema rejects unknown fields. The
problems are where the parts meet:

- `/v1/` currently means "OpenAI-compatible", not "version 1".
- Errors can't be told apart by code.
- The same pipeline resource has two representations that don't round-trip.
- The TypeScript types are a hand-copied mirror of an untyped server schema.

## Metrics

| Severity   | Count |
|------------|-------|
| Critical   | 1     |
| Warnings   | 11    |
| Suggestions| 6     |

## Findings at a glance

| ID | Severity | Title |
|----|----------|-------|
| [API-001](#api-001-v1-means-openai-compatible-not-api-version-1) | CRITICAL | `/v1/` means "OpenAI-compatible", not "API version 1" — ✅ fixed |
| [API-002](#api-002-errors-have-no-machine-readable-code) | WARNING | Errors have no machine-readable code — ✅ fixed |
| [API-003](#api-003-status-codes-disagree-for-the-same-kind-of-failure) | WARNING | Status codes disagree for the same kind of failure — ✅ fixed |
| [API-004](#api-004-get-pipelinesname-doesnt-return-what-put-accepts) | WARNING | `GET /pipelines/{name}` doesn't return what `PUT` accepts — ✅ fixed |
| [API-005](#api-005-optimistic-concurrency-is-spelled-three-different-ways) | WARNING | Optimistic concurrency is spelled three different ways — ✅ fixed |
| [API-006](#api-006-rpc-style-endpoints-with-the-pipeline-named-in-the-body) | WARNING | RPC-style endpoints, with the pipeline named in the body — ✅ fixed |
| [API-007](#api-007-the-contract-documentation-contradicts-actual-behaviour) | WARNING | The contract documentation contradicts actual behaviour — ✅ fixed |
| [API-008](#api-008-pipelineclient-method-signatures-make-incorrect-calls-easy) | WARNING | `PipelineClient` method signatures make incorrect calls easy — ✅ fixed |
| [API-009](#api-009-the-draftops-field-setters-use-string-paths-with-unknown-values) | WARNING | The `draftOps` field setters use string paths with `unknown` values — ✅ fixed |
| [API-010](#api-010-wire-types-are-untyped-on-the-server-and-hand-copied-under-different-names-in-typescript) | WARNING | Wire types are untyped on the server and hand-copied under different names in TypeScript — ✅ fixed |
| [API-011](#api-011-health-is-public-but-returns-what-pipelines-requires-a-key-for) | WARNING | `/health` is public but returns what `/pipelines` requires a key for — ✅ fixed |
| [API-012](#api-012-the-template-variable--input--quietly-includes-the-conversation) | WARNING | The template variable `{{ input }}` quietly includes the conversation — ✅ fixed |
| [API-013](#api-013-python-signatures-rely-on-positional-tuples-and-long-parameter-lists) | SUGGESTION | Python signatures rely on positional tuples and long parameter lists — ✅ fixed |
| [API-014](#api-014-one-concept-has-three-names-and-several-cli-commands-differ-by-one-keystroke) | SUGGESTION | One concept has three names, and several CLI commands differ by one keystroke — ✅ fixed |
| [API-015](#api-015-yaml-schema-naming) | SUGGESTION | YAML schema naming — ✅ fixed |
| [API-016](#api-016-validate-takes-two-mutually-exclusive-fields-and-checks-at-runtime) | SUGGESTION | `validate` takes two mutually exclusive fields and checks at runtime — ✅ fixed |
| [API-017](#api-017-graphedge-expresses-its-variant-through-nullable-fields) | SUGGESTION | `GraphEdge` expresses its variant through nullable fields — ✅ fixed |
| [API-018](#api-018-smaller-naming-items) | SUGGESTION | Smaller naming items |

**Suggested order:** start with API-001. Moving the compat router to
`/openai/v1` is cheap now and prevents a real break once spec 003 lands.
API-002 and API-005 come next, since the web and CLI clients are already
working around them.

---

## Findings

### API-001: `/v1/` means "OpenAI-compatible", not "API version 1"

- **Severity**: CRITICAL
- **Status**: ✅ Fixed (2026-09-28). The compat router is mounted at
  `/openai/v1`. It answers its own errors in OpenAI's shape through
  `OpenAIErrorRoute`, and the app-wide handlers no longer look at the path.
  Guarded by `test_v1_is_left_to_this_apis_own_versioning` and
  `test_the_error_shape_does_not_depend_on_the_path`.
- **Principle**: Names should reveal intent; principle of least surprise (URL structure)
- **File(s)**:
  - [openai_compat.py:54](llm_pipeline/llm_pipeline/routers/openai_compat.py#L54)
  - [openai_compat.py:201](llm_pipeline/llm_pipeline/routers/openai_compat.py#L201)
  - [editing.py:76](llm_pipeline/llm_pipeline/routers/editing.py#L76)
  - [error_handling.py:59-89](llm_pipeline/llm_pipeline/error_handling.py#L59-L89)
  - [http-api.md:45-92](specs/003-validated-dag-orchestration/contracts/http-api.md#L45-L92)
- **Description**: The two "models" endpoints return unrelated things:
  - `GET /models` returns LLM models (installed Ollama models plus the cloud allowlist).
  - `GET /v1/models` returns pipelines.

  Anyone reading the paths will assume the second is the versioned form of
  the first.

  It gets worse: `_content()` picks the error body format with
  `path.startswith("/v1/")`. Every future `/v1/...` route will therefore return
  OpenAI-style errors (`{"error": {...}}`). Spec 003 plans `/v1/workflows` and
  `/v1/workflows/{name}/run`. `buildApiError` reads `body.message` and
  `body.details`, and neither exists in the OpenAI format. Clients would get
  only "Request failed with status N" and lose `details.node_id`.
- **Recommendation**:
  - Mount the OpenAI-compatible router at `/openai/v1`. OpenAI SDKs take a
    `base_url`, so their users only change one config value.
  - Choose the error format per router (the compat router's own handling or a
    custom `route_class`), not by path prefix.
  - That leaves `/v1/` free for real versioning.

### API-002: Errors have no machine-readable code

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28). `ErrorResponse.code` is set to an
  `ErrorCode` value (21 codes) on every error, streamed `error` events
  included. The server raises `ApiError`, and a test fails if anything
  raises a bare `HTTPException`. `PipelineApiError.code` exposes it. The
  CLI and web app now branch on `PIPELINE_EXISTS`, `REVISION_CONFLICT` and
  `DEFINITION_INVALID` instead of the status. Spec 003 now carries its
  failure category in `code`.
- **Principle**: Consistent error response structure
- **File(s)**:
  - [api_schemas.py:440-454](llm_pipeline/llm_pipeline/api_schemas.py#L440-L454)
  - [error_handling.py:163-187](llm_pipeline/llm_pipeline/error_handling.py#L163-L187)
  - [editCommands.ts:397](cli/src/editCommands.ts#L397)
- **Description**: Several different failures share one status code:
  - **409** covers "changed since loaded", "already exists" and "protected
    default pipeline".
  - **422** covers request-schema failures, invalid definitions, models not on
    the allowlist and preview templates that can't be rendered.

  `ErrorResponse.error` holds only the HTTP reason phrase. Clients already
  rebuild the meaning from context: the CLI decides a 409 means "already
  exists" because it sent `baseRevision === null`. On
  `DELETE /pipelines/{name}`, only the message text separates a conflict from
  a protected pipeline.
- **Recommendation**:
  - Add a stable `code` field that each handler sets, e.g.
    `REVISION_CONFLICT`, `PIPELINE_PROTECTED`, `DEFINITION_INVALID`,
    `MODEL_NOT_ALLOWED`, `PIPELINE_NOT_FOUND`, `EDITING_DISABLED`.
  - Expose it as `PipelineApiError.code`.
  - Spec 003 already plans a `category` field, so build it once for both.

### API-003: Status codes disagree for the same kind of failure

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28), with one change from the recommendation
  below. Each `ErrorCode` now has exactly one status, in `STATUS_BY_CODE`
  (`api_error.py`), and `ApiError` takes its status from it, so a raise site
  can't pick a different one. Unknown references are **404**
  (`NODE_NOT_FOUND`, `TEST_CASE_NOT_FOUND`), not the 422 recommended below:
  `/ask` already returns 404 for an unknown `pipeline_name` in its body, and
  the OpenAI-compatible endpoint must return 404 for an unknown `model`, as
  OpenAI does. With `code` (API-002), a 404 can no longer be mistaken for a
  missing endpoint. The other changes:
  - `PIPELINE_RUN_FAILED` is 502.
  - Unexpected failures are 500 `INTERNAL_ERROR` with a generic message,
    and no longer echo exception text.
  - `REQUEST_INVALID` is always 422.
  - A node whose template the sandbox refuses now fails as that node
    (`PIPELINE_RUN_FAILED`, `details.node_id`), not as an unexpected error.
  - `/ask` now includes `details.node_id` / `loop_id` like the stream does.
- **Principle**: HTTP conventions; least surprise
- **File(s)**:
  - [editing.py:198-201](llm_pipeline/llm_pipeline/routers/editing.py#L198-L201)
  - [editing.py:244-246](llm_pipeline/llm_pipeline/routers/editing.py#L244-L246)
  - [editing.py:216](llm_pipeline/llm_pipeline/routers/editing.py#L216)
  - [ask.py:164-171](llm_pipeline/llm_pipeline/routers/ask.py#L164-L171)
  - [ask.py:232-237](llm_pipeline/llm_pipeline/routers/ask.py#L232-L237)
- **Description**: When a request body names something that doesn't exist,
  the status depends on the endpoint:

  | What the body names | Endpoint | Status |
  |---|---|---|
  | Unknown preview `node_id` | `POST /pipelines/preview` | 404 |
  | Unknown test case | `POST /pipelines/test` | 404 |
  | Unknown node in a variant | `POST /pipelines/test` | 422 |
  | Unknown `rerun.from_node` | `POST /ask` | 400 |

  A 404 on `POST /pipelines/preview` reads as "endpoint not found".

  Separately, during a run:
  - An unexpected exception returns **502** "Pipeline error: {e}", which also
    echoes the raw exception text.
  - `PipelineExecutionError` (the upstream models failed) returns **503**.

  That's backwards: an upstream model failure is the 502 (bad gateway) case,
  and a bug is a 500.
- **Recommendation**:
  - Use one rule: a body that references an unknown id returns 422 with the
    field named in `details`.
  - Map `PipelineExecutionError` to 502 (or 504 for timeouts).
  - Let unexpected exceptions fall through to the existing
    `unhandled_exception_handler`, which returns a generic 500.

### API-004: `GET /pipelines/{name}` doesn't return what `PUT` accepts

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28), taking the "drop it" option below.
  `GET /pipelines/{name}` returns `{definition, revision, has_comments}`,
  what `PUT` takes back. `/pipelines/{name}/definition` is gone, and so is
  the server-side derived view (`PipelineDetailResponse`, and `_model_label`,
  which duplicated the client's `displayModel`). The client has one
  `getPipeline()` in place of `getPipelineDetail()` and
  `getPipelineDefinition()`. The CLI now derives the structure with
  `detailFromDefinition()`, as the web app already did, so stored pipelines
  and unsaved drafts are drawn by the same code.
- **Principle**: Uniform resource representation; names reveal intent
- **File(s)**:
  - [health.py:65-127](llm_pipeline/llm_pipeline/routers/health.py#L65-L127)
  - [editing.py:134-152](llm_pipeline/llm_pipeline/routers/editing.py#L134-L152)
  - [editing.py:283-300](llm_pipeline/llm_pipeline/routers/editing.py#L283-L300)
  - [apiClient.ts:171-196](packages/client/src/apiClient.ts#L171-L196)
- **Description**: The pipeline's main URL doesn't round-trip:
  - `GET /pipelines/{name}` returns a display-oriented view: topology, model
    shown as a label, no prompts.
  - What `PUT /pipelines/{name}` accepts lives at
    `GET /pipelines/{name}/definition`.

  So the "definition" sub-resource is really the resource itself. The client
  copies the ambiguity: `getPipelineDetail()` and `getPipelineDefinition()`
  don't say which one is editable.
  [`detailFromDefinition()`](packages/client/src/graphModel.ts#L31) already
  derives the display view on the client.
- **Recommendation**:
  - Make `GET /pipelines/{name}` return `{definition, revision, has_comments}`.
  - Move the derived view to `GET /pipelines/{name}/topology`, or drop it in
    favour of `detailFromDefinition`.
  - Rename the client methods to `getPipeline()` and `getPipelineTopology()`.

### API-005: Optimistic concurrency is spelled three different ways

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28) with HTTP conditional requests. Reads
  and writes of pipelines and presets send `ETag` (the revision; CORS
  exposes it to browsers). Writes take `If-Match` (412 `REVISION_CONFLICT`)
  and `If-None-Match: *` (412 `ALREADY_EXISTS`, renamed from
  `PIPELINE_EXISTS` now that presets can hit it). A pipeline `PUT` with
  neither is 428 `PRECONDITION_REQUIRED`, so a blind overwrite stays
  impossible. `base_revision` and `?revision=` are gone from the wire; the
  old query is refused (422) rather than silently ignored. Presets honour
  the same headers, still last-write-wins without them, so their
  `revision` now means something. All four operations share one store
  `Precondition`. On the client, `deletePipeline(name, baseRevision)` now
  uses the same parameter name as `savePipeline`, and `savePreset` /
  `deletePreset` take an optional `baseRevision`. `savePipeline`'s `null`
  still means "create"; splitting it is left to API-008.
- **Principle**: Consistency; HTTP conventions
- **File(s)**:
  - [api_schemas.py:391-394](llm_pipeline/llm_pipeline/api_schemas.py#L391-L394)
  - [editing.py:309-318](llm_pipeline/llm_pipeline/routers/editing.py#L309-L318)
  - [api_schemas.py:409-415](llm_pipeline/llm_pipeline/api_schemas.py#L409-L415)
  - [pipeline_store.py:589-591](llm_pipeline/llm_pipeline/pipeline_store.py#L589-L591)
  - [apiClient.ts:217-242](packages/client/src/apiClient.ts#L217-L242)
- **Description**: One concept has a different name and transport per verb:
  - `PUT` takes `base_revision` in the body.
  - `DELETE` takes `?revision=` in the query.
  - Presets return a `revision` that no write accepts, which suggests preset
    saves are protected against conflicts when they aren't.

  HTTP already has a standard mechanism for this.
- **Recommendation**:
  - Return `ETag` on reads and writes.
  - Accept `If-Match` on PUT and DELETE (412 on mismatch), and
    `If-None-Match: *` for create-only.
  - That also removes the `null`-means-create parameter (see API-008).
  - If headers are too much churn right now: use one name in one place for
    both verbs, and drop `revision` from `PresetResponse` until preset saves
    honour it.

### API-006: RPC-style endpoints, with the pipeline named in the body

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - `POST /ask` and `POST /ask/stream` are now one `POST /pipelines/{name}/runs`
    (body `RunRequest`: `prompt`, `history`, `rerun`). It answers with
    `RunResponse`, or streams Server-Sent Events when the client prefers
    `text/event-stream` (by q-value; JSON wins a tie, and `*/*` never
    streams).
  - The draft operations moved to their own path space: `/drafts/validation`,
    `/drafts/prompt-preview` and `/drafts/test-runs`. So `validate`, `preview`
    and `test` are ordinary pipeline names again.
  - The wire types are renamed on both sides (`AskRequest`/`AskResponse` →
    `RunRequest`/`RunResponse`), the router module is `routers/runs.py`, and
    `pipeline_events` no longer takes the request body.
  - The client keeps its method names (`ask()`, `askStream()`); reshaping
    them is API-008.
- **Principle**: REST URL structure (nouns; the resource goes in the path)
- **File(s)**:
  - [ask.py:199-210](llm_pipeline/llm_pipeline/routers/ask.py#L199-L210)
  - [ask.py:487-525](llm_pipeline/llm_pipeline/routers/ask.py#L487-L525)
  - [api_schemas.py:28-36](llm_pipeline/llm_pipeline/api_schemas.py#L28-L36)
  - [editing.py:155-233](llm_pipeline/llm_pipeline/routers/editing.py#L155-L233)
- **Description**:
  - `POST /ask` puts `pipeline_name` in the body. Logs, rate limits and metrics
    keyed on the path can't tell runs of different pipelines apart.
  - `/ask/stream` makes the response format a separate endpoint instead of
    using content negotiation.
  - `POST /pipelines/validate`, `/preview` and `/test` share the `{name}` path
    segment. So `GET /pipelines/test` fetches a pipeline named "test", while
    `POST /pipelines/test` runs tests on whatever is in the body.
    `is_safe_name` allows those names.
- **Recommendation**:
  - Adopt the path form spec 003 already plans, now:
    `POST /pipelines/{name}/runs`, with `Accept: text/event-stream` choosing
    streaming.
  - Move the stateless draft operations under their own noun, e.g.
    `POST /drafts/validation`, `/drafts/preview`, `/drafts/test-runs`.
  - At minimum, reserve `validate`, `preview` and `test` as pipeline names.

### API-007: The contract documentation contradicts actual behaviour

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - Streaming: API-006 corrected `apiClient.ts` and `types.ts`. The last
    stale block, in `api_schemas.py`, now describes the real event sequence
    and how token streaming works with no provider-adapter code. It had also
    pointed at a `dag_builder` doc that never said what it claimed.
  - `PipelineNodeInfo.model` went away with API-004.
  - A repo-wide search finds no other "node-level, not token-level" claim.
  - Also fixed: the README's security list still called the server
    "read-only… no upload endpoint". It now describes the editing endpoints
    and their `PIPELINE_EDITING_ENABLED` / CORS gates.
- **Principle**: Self-documenting interfaces; misleading documentation
- **File(s)**:
  - [api_schemas.py:85-90](llm_pipeline/llm_pipeline/api_schemas.py#L85-L90)
    (compare [api_schemas.py:119-126](llm_pipeline/llm_pipeline/api_schemas.py#L119-L126))
  - [types.ts:74-76](packages/client/src/types.ts#L74-L76)
  - [apiClient.ts:294-302](packages/client/src/apiClient.ts#L294-L302)
  - [api_schemas.py:193](llm_pipeline/llm_pipeline/api_schemas.py#L193)
    (compare [health.py:26-30](llm_pipeline/llm_pipeline/routers/health.py#L26-L30))
- **Description**:
  - **Streaming:** *(partly resolved by API-006: `apiClient.ts`'s and
    `types.ts`'s docs were rewritten; `api_schemas.py` still has it)* three
    docs say streaming is "node-level, not token-level".
    But `node_token` events exist, and `NodeTokenEvent` describes itself as
    token-level streaming. Someone following the `askStream()` doc would never
    handle `node_token`.
  - **`PipelineNodeInfo.model`:** *(resolved by API-004: the server no
    longer sends it, and the client type now documents it as a display
    label)* documented as a "provider:model identity
    string", but for nodes that inherit the default model, `_model_label`
    appends ` (default)`. Code that splits on `:` or matches against `/models`
    fails for exactly those nodes.
- **Recommendation**:
  - Fix the three streaming docs.
  - Return `model` as the plain `provider:model` identity plus an
    `inherits_model: bool` flag, and let clients format the label (they
    already have `displayModel`).

### API-008: `PipelineClient` method signatures make incorrect calls easy

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - `ask({pipeline, prompt, history?, rerun?}, {signal})`, and the same for
    `askStream`. The body is built field by field, so nothing else a
    caller's object carries is sent.
  - `createPipeline(def)` and `updatePipeline(def, {baseRevision})` replace
    `savePipeline(def, null | rev)`.
  - `listModels({refresh: true})`.
  - `ServerUnreachableError` (a `PipelineApiError` subclass, so existing
    catches keep working) replaces "no `statusCode` means unreachable".
  - The three copies of the fetch/error code in `request`, `ask` and
    `postStream` are now one `send()`.
  - The error's constructor and the stream's `serverMessage` were already
    fixed by API-002. Its field names (`statusCode`, `exceptionUID`) are
    unchanged; `exceptionUID` is API-018.
- **Principle**: Parameter objects; no boolean or `null` mode flags; consistency
- **File(s)**:
  - [apiClient.ts:37-56](packages/client/src/apiClient.ts#L37-L56)
  - [apiClient.ts:150-153](packages/client/src/apiClient.ts#L150-L153)
  - [apiClient.ts:179](packages/client/src/apiClient.ts#L179)
  - [apiClient.ts:217-226](packages/client/src/apiClient.ts#L217-L226)
  - [apiClient.ts:256-263](packages/client/src/apiClient.ts#L256-L263)
  - [apiClient.ts:396-402](packages/client/src/apiClient.ts#L396-L402)
- **Description**:
  - `PipelineApiError` takes six optional positional arguments. The mid-stream
    error path already leaves out `serverMessage`, so
    `err.serverMessage ?? err.message` gives different text before and during
    a stream.
  - "Server unreachable" is also a `PipelineApiError`, told apart only by
    `statusCode` being undefined.
  - In `savePipeline(def, null)`, `null` switches the call to "create" mode.
  - `ask(prompt, pipelineName, history, options)` takes positional arguments,
    while `previewPrompt(req)` and `runTests(req)` take request objects.
  - `listModels(true)` passes a bare boolean.
  - The `options` object mixes the transport `signal` with body fields, and
    `...request` spreads any extra key straight into the JSON body.
- **Recommendation**:
  - `new PipelineApiError(message, { status, code, exceptionId, details, validations, serverMessage })`.
  - A separate `ServerUnreachableError`.
  - `createPipeline(def)` and `updatePipeline(def, { baseRevision })`.
  - `ask({ pipeline, prompt, history, rerun }, { signal })`, with the same
    shape for `askStream`.
  - `listModels({ refresh: true })`.

### API-009: The `draftOps` field setters use string paths with `unknown` values

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - `setNodeField` / `setPipelineField` (string paths, `unknown` values) are
    replaced by typed operations:
    - `setNodeProperty(def, id, key, value)`: `key` excludes `id` (that's
      `renameNode`) and `model`, and a required field like `prompt_template`
      can't be cleared.
    - `setNodeModel(def, id, model | undefined)`, where `undefined` means
      inherit the default, and `updateNodeModel(def, id, change)`, which
      refuses a node with no model of its own.
    - `setPipelineSetting(def, section, key, value)`.
    - `setTestJudge(def, model | undefined)`, no longer `""`.
    - Pure helpers `modelWithIdentity` and `modelWithOption`.
  - A test pins five kinds of misuse as compile errors via
    `@ts-expect-error`.
  - The aliases, `coerceFieldValue`, the `unset`/`default` words and the path
    interpreter moved to a new `cli/src/fieldPaths.ts`. It now also refuses
    fields nodes don't have, instead of writing them.
  - The web Inspector calls the typed operations directly, and the Ollama
    options form's `onChange` is typed per option. Checked in the browser:
    node temperature/history/reasoning/option edits and pipeline
    history/defaults edits all update the draft, and the server validates
    each one.
- **Principle**: Make invalid states unrepresentable; avoid magic strings
- **File(s)**:
  - [draftOps.ts:366-374](packages/client/src/draftOps.ts#L366-L374)
  - [draftOps.ts:388-421](packages/client/src/draftOps.ts#L388-L421)
  - [draftOps.ts:454-472](packages/client/src/draftOps.ts#L454-L472)
  - [draftOps.ts:507-549](packages/client/src/draftOps.ts#L507-L549)
  - [Inspector.tsx:156](web/src/editor/Inspector.tsx#L156)
  - [Inspector.tsx:916](web/src/editor/Inspector.tsx#L916)
- **Description**: `setNodeField(def, id, path: string, value: unknown)`
  accepts the CLI's shorthands inside the shared library, with several
  surprises:
  - At node level, `history` means the boolean `include_history`. In
    `setPipelineField`, `history` is the whole `HistoryConfig` object.
  - Setting path `"id"` renames the node everywhere, as a side effect.
  - Path `"model"` takes a string instead of a `NodeModelConfig`.
  - `setNodeModel` treats `""`, `"default"`, `"inherit"` and `"unset"` as
    "clear".

  The web Inspector goes through the same untyped paths, so a typo there is a
  runtime `DraftError` rather than a compile error.
- **Recommendation**:
  - Give the shared library typed operations, e.g.
    `setNodeProperty<K extends keyof NodeConfig>(def, id, key: K, value: NodeConfig[K])`
    and `setNodeModel(def, id, model?: NodeModelConfig)`.
  - Move the alias table, `coerceFieldValue` and the sentinel strings into
    `cli/src/editCommands.ts`, as input parsing that calls the typed
    operations.

### API-010: Wire types are untyped on the server and hand-copied under different names in TypeScript

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - **Documented payloads:** definition, preset and variant-model fields are
    still validated by the server itself, but are now documented as
    `PipelineDefinition` / `NodePreset` / `NodeModelConfig` (pydantic's
    `PlainValidator(json_schema_input_type=…)`). OpenAPI publishes those
    schemas as components, and `separate_input_output_schemas=False` keeps
    responses referencing them too.
  - **Contract file:** `contracts/wire-types.json` records every wire model's
    field names and every enum's values. This covers the SSE event payloads,
    which OpenAPI never includes.
    - `tests/test_wire_contract.py` fails when `api_schemas.py` drifts from
      the file.
    - `packages/client/test/wireContract.test.ts` parses `types.ts` with the
      TypeScript compiler API and fails when the client drifts.
    - Field types and optionality aren't compared.
  - **Names aligned:**
    - `NodeOutputDTO`/`UsageDTO` → `NodeOutput`/`NodeUsage`.
    - `ApiErrorBody` → `ErrorResponse`, `ModelLimits` →
      `ModelLimitsResponse`, `ProviderName` → `ProviderType`.
    - `ModelIssue` → `DefinitionIssue` (it also carries warnings).
    - `CaseStart`/`RunTestsDone` → `CaseStartEvent`/`TestsDoneEvent`.
    - The client gained named `ValidatePipelineRequest`,
      `SavePipelineRequest` and `SavePresetRequest`.
  - **Convention**, written down in `api_schemas.py`: `…Request`,
    `…Response`, `…Event`, plain nouns for records.
- **Principle**: Type safety; consistent naming across one contract
- **File(s)**:
  - [api_schemas.py:233-239](llm_pipeline/llm_pipeline/api_schemas.py#L233-L239)
  - [api_schemas.py:273-276](llm_pipeline/llm_pipeline/api_schemas.py#L273-L276)
  - [api_schemas.py:365-415](llm_pipeline/llm_pipeline/api_schemas.py#L365-L415)
  - [types.ts](packages/client/src/types.ts)
- **Description**: Definitions and presets travel as `dict[str, Any]`. This is
  deliberate, so validation failures return `ErrorResponse` instead of
  FastAPI's default 422. The side effect is that OpenAPI describes nothing
  about the largest payloads, and the 645 lines of `types.ts` are maintained
  by hand with no check that they match.

  Names differ between the two sides of the same contract:

  | Server (Python) | Client (TypeScript) |
  |---|---|
  | `NodeOutputDTO` | `NodeOutput` |
  | `UsageDTO` | `NodeUsage` |
  | `PipelineDetailResponse` | `PipelineDetail` |
  | `ModelLimitsResponse` | `ModelLimits` |
  | `ErrorResponse` | `ApiErrorBody` |

  On the server, suffixes also mix `DTO`, `Info`, `Response`, `Summary` and
  none (`CaseStart`, `RunTestsDone`). `ModelIssue` is also reused for
  `warnings` that have nothing to do with the model allowlist.
- **Recommendation**:
  - Keep the manual validation, but attach `PipelineDefinition`'s JSON schema
    to those fields (e.g. pydantic's `WithJsonSchema`).
  - Generate `types.ts` from `/openapi.json` in CI, or add a contract test that
    compares them.
  - Drop `DTO` and pick one suffix convention.

### API-011: `/health` is public but returns what `/pipelines` requires a key for

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - `GET /health` returns `{"status": "ok"}` and nothing else.
  - The authenticated `GET /server-info` returns `default_pipeline_name`,
    `editing_enabled` and `editing_disabled_reason`.
  - The pipeline list comes only from `GET /pipelines`, and `pipelines_dir`
    is no longer sent anywhere.
  - The web app starts from and polls `/server-info`. Its online indicator
    uses API-008's `ServerUnreachableError`, so a refused API key no longer
    reads as "server offline". The CLI's startup and `/health` command show
    `/server-info` plus the pipeline list.
- **Principle**: Consistent access contract; keep public surfaces minimal
- **File(s)**:
  - [health.py:41-62](llm_pipeline/llm_pipeline/routers/health.py#L41-L62)
  - [api_schemas.py:172-182](llm_pipeline/llm_pipeline/api_schemas.py#L172-L182)
- **Description**: `GET /pipelines` requires an API key. `GET /health` needs
  no key and returns the same `available_pipelines`, plus the server's
  filesystem `pipelines_dir`. So the auth on the listing endpoint protects
  nothing. The health probe's contract also grows every time a client wants
  more server information.
- **Recommendation**:
  - Keep `/health` minimal: `status`, and possibly `editing_enabled`.
  - Move server info to an authenticated `GET /server-info`.
  - Stop sending `pipelines_dir` over the wire.

### API-012: The template variable `{{ input }}` quietly includes the conversation

- **Severity**: WARNING
- **Status**: ✅ Fixed (2026-09-28).
  - `{{ message }}` (the new message alone) and `{{ conversation }}` (earlier
    turns, then the new message; just the message for a node with
    `include_history: false`) are the documented names. `{{ question }}` and
    `{{ input }}` keep working as their older names, and all five are
    reserved node ids.
  - `message` also works wherever `question` did: in branch/loop/test
    conditions (the classifier-route check treats both alike) and in judge
    prompts.
  - New nodes start from `{{ conversation }}`, so behaviour is unchanged
    under an explicit name. The editor's insert buttons and hints and the
    READMEs use the new names.
  - The shipped YAML files still say `{{ input }}` and work unchanged.
    Whether `support-router`'s classifier should switch to `{{ message }}`
    is a content decision left open.
- **Principle**: Names should reveal intent (public template language)
- **File(s)**:
  - [templating.py:24-38](llm_pipeline/llm_pipeline/dag_builder/templating.py#L24-L38)
  - [history.py:35-54](llm_pipeline/llm_pipeline/history.py#L35-L54)
  - [schema.py:51](llm_pipeline/llm_pipeline/pipeline_config/schema.py#L51)
  - [draftOps.ts:198](packages/client/src/draftOps.ts#L198)
- **Description**: Once there's history, `{{ input }}` becomes "Conversation so
  far: … New request: &lt;message&gt;". `{{ question }}` is the bare message.
  Most authors would expect it the other way round.
  - Single-turn tests can't show the difference (`tests.cases` always run
    without history).
  - The classifier in `support-router.yaml` ("Request: {{ input }}") will start
    classifying the whole transcript from turn two.
  - Every node the editor creates starts with `{{ input }}`.
- **Recommendation**:
  - Add unambiguous names: `{{ message }}` for the new message and
    `{{ conversation }}` for the message plus history.
  - Keep `input` and `question` as documented aliases.
  - Have the editor's default template pick one of the new names explicitly.

### API-013: Python signatures rely on positional tuples and long parameter lists

- **Severity**: SUGGESTION
- **Status**: ✅ Fixed (2026-09-28).
  - `generate_with_retry(provider, prompt, spec, policy, *, circuit_breaker,
    system, on_retry)` takes a `RetryPolicy`. It had grown to 9 parameters.
    Callers build it with `RetryPolicy.from_execution(definition.execution)`,
    which lives in `providers/base.py` and reads the execution block through
    a structural protocol, so the provider layer still doesn't import the
    definition model.
  - `prepare_run()` returns a `PreparedRun`, and `pipeline_events(request,
    run)` takes it whole.
  - A route's body parameter is `body` and the internal `RunRequest` is
    `run_request`, so nothing takes both a `req` and a `request`.
  - Named tuples replace bare ones: `PipelineCache.get()` →
    `LoadedPipeline(definition, graph)`, `DefinitionInvalidError.issues` →
    `ValidationProblem(location, message, type)` (its docstring's "pairs" was
    wrong), `limit_warnings()` → `LimitWarning(node_id, message)`.
  - `LLMProvider.generate()` always returns a `Generation`. Every real
    adapter already did; `as_generation` is gone, and the 29 test fakes were
    rewritten to match.
- **Principle**: Parameter objects; return named types
- **File(s)**:
  - [resilience.py:122](llm_pipeline/llm_pipeline/providers/resilience.py#L122)
  - [ask.py:126](llm_pipeline/llm_pipeline/routers/ask.py#L126)
  - [ask.py:213](llm_pipeline/llm_pipeline/routers/ask.py#L213)
  - [ask.py:317](llm_pipeline/llm_pipeline/routers/ask.py#L317)
  - [pipeline_loader.py:68](llm_pipeline/llm_pipeline/pipeline_loader.py#L68)
  - [errors.py:34-48](llm_pipeline/llm_pipeline/errors.py#L34-L48)
  - [base.py:146](llm_pipeline/llm_pipeline/providers/base.py#L146)
- **Description**:
  - `generate_with_retry` takes 8 parameters. Its three callers (ask,
    evaluation, node_types) each rebuild the same four from
    `definition.execution`.
  - `prepare_ask` returns a 3-tuple that is passed straight into
    `pipeline_events(request, req, definition, graph, initial_state)`.
  - `req` and `request` appear in a different order in `ask`, `run_ask` and
    `pipeline_events`.
  - `DefinitionInvalidError.issues` holds 3-tuples, but its docstring says
    "(location, message)" pairs.
  - `LLMProvider.generate` returns `str | Generation`, so every caller needs
    `as_generation`.
- **Recommendation**:
  - `RetryPolicy.from_execution(execution)`, passed as one argument.
  - A `PreparedRun` dataclass.
  - Rename `req` to `ask_request`.
  - `LoadedPipeline(definition, graph)` for the cache's return value.
  - A `ValidationProblem` NamedTuple for `issues`.
  - `generate` always returns a `Generation`.

### API-014: One concept has three names, and several CLI commands differ by one keystroke

- **Severity**: SUGGESTION
- **Status**: ✅ Fixed (2026-09-28).
  - "Preset", the server's name, is now the only name. The web UI says
    **Presets** and **Save as preset**. The CLI command is `/preset`. The
    client doc comments and all READMEs use the same word. The REST API
    was already consistent and is unchanged.
  - CLI commands are grouped under one word each:

    | Old | New |
    |---|---|
    | `/pipelines` | `/pipeline list` |
    | `/delete <name>` | `/pipeline rm <name>` |
    | `/tests` | `/test` |
    | `/test [case]` | `/test run [case]` |
    | `/pset <setting> <value>` | `/settings set <setting> <value>` |
    | `/library …` | `/preset …` |
    | `/nodes` | `/node` |

  - `rm` is the only verb for removing things.
  - The old names print where the command moved (`cli/src/renamedCommands.ts`)
    instead of "unknown command".
- **Principle**: Consistent domain vocabulary
- **File(s)**:
  - [api_schemas.py:405-423](llm_pipeline/llm_pipeline/api_schemas.py#L405-L423)
  - [types.ts:385-387](packages/client/src/types.ts#L385-L387)
  - [editCommands.ts:84-125](cli/src/editCommands.ts#L84-L125)
- **Description**:
  - The same concept is a **preset** in the server, files and REST API, a
    **saved node** in the client and UI, and the **library** in the CLI.
  - `/pipeline` and `/pipelines`, `/test` and `/tests`, and `/set`, `/pset`
    and `/settings` do different things.
  - Deleting a pipeline is `/delete`, but removing a node is `/node rm` and
    removing a preset is `/library rm`.
- **Recommendation**:
  - Use one noun everywhere.
  - Group related CLI commands under one word, e.g.
    `/pipeline show|list|delete` and `/test run|list|add|rm`.

### API-015: YAML schema naming

- **Severity**: SUGGESTION
- **Status**: ✅ Fixed (2026-09-28).
  - The schema is now `version: 2`:

    | Version 1 | Version 2 |
    |---|---|
    | `model: { provider, model }` | `model: { provider, name }` |
    | `output_node: a` or `[a, b]` | `output_nodes: [a, b]` (always a list) |
    | `execution.max_history_turns` | `history.max_turns` |

  - Version-1 keys are still accepted, in files and in request bodies.
    `pipeline_config/upgrade.py` upgrades them before validation. Setting
    both a key and its old name is refused, and so is an unknown `version`.
  - Saving an old file upgrades it in place and keeps its comments, blank
    lines and key positions.
  - The shipped pipelines, presets and test fixtures are upgraded, and so
    is `contracts/topology-cases.json`.
  - The client uses the same names: `NodeModelConfig.name` and
    `PipelineDefinition.output_nodes`. `PipelineDetail.output_node_candidates`
    is now `output_nodes`, and `outputCandidates()` is gone.
  - Judge prompts use `{{ requirement }}`, matching the Python name and the
    default prompt's wording. `{{ criterion }}` still works.
  - Turn templates use `{{ final_answer }}`, the `ConversationTurn` field.
    `{{ answer }}` still works.
  - `RunResponse.output_node` is unchanged: it names the one node that
    answered.
- **Principle**: Naming clarity (configuration interface)
- **File(s)**:
  - [schema.py:81-89](llm_pipeline/llm_pipeline/pipeline_config/schema.py#L81-L89)
  - [schema.py:65-78](llm_pipeline/llm_pipeline/pipeline_config/schema.py#L65-L78)
  - [schema.py:179-194](llm_pipeline/llm_pipeline/pipeline_config/schema.py#L179-L194)
  - [schema.py:346-355](llm_pipeline/llm_pipeline/pipeline_config/schema.py#L346-L355)
  - [evaluation.py:72-75](llm_pipeline/llm_pipeline/evaluation.py#L72-L75)
  - [history.py:41-45](llm_pipeline/llm_pipeline/history.py#L41-L45)
- **Description**:
  - `model: { model: … }` repeats itself (`node.model.model` in code).
  - `output_node` is singular but can hold a priority list; the API already
    calls it `output_node_candidates`.
  - `execution.max_history_turns` sits outside `history:`.
  - One concept is `judge:` in YAML, `requirement` in Python and `criterion`
    in the judge prompt.
  - The turn template says `answer`, but `ConversationTurn` says
    `final_answer`.
- **Recommendation**:
  - At the next schema `version`, use `model: {provider, name}`,
    `output_nodes` and `history.max_turns`, accepting the old keys as aliases
    until then.
  - Pick one word for requirement/criterion.

### API-016: `validate` takes two mutually exclusive fields and checks at runtime

- **Severity**: SUGGESTION
- **Status**: ✅ Fixed (2026-09-28).
  - `POST /drafts/validation` takes a tagged body: either
    `{"format": "json", "definition": {...}}` or `{"format": "yaml", "text": "..."}`.
  - `ValidatePipelineRequest` is the union of `ValidateDefinitionRequest` and
    `ValidateYamlRequest`. The route names `format` as the discriminator.
  - Each side forbids extra fields, so a body with both, neither, a
    mismatched pair or an unknown format is a 422 from request validation.
    The runtime check is gone.
  - OpenAPI documents the body as `oneOf` with a `format` discriminator.
  - In TypeScript, `ValidatePipelineRequest` is the same tagged union and
    `validatePipeline(req)` takes it. `{format: "json", definition, text}`
    and a body without `format` no longer compile; `@ts-expect-error`
    tests pin this.
  - The CLI (`/validate`, `/import`, `/export`) and the web app
    (live validation, import, export) send the new body.
- **Principle**: Make invalid states unrepresentable
- **File(s)**:
  - [api_schemas.py:365-369](llm_pipeline/llm_pipeline/api_schemas.py#L365-L369)
  - [editing.py:167](llm_pipeline/llm_pipeline/routers/editing.py#L167)
  - [apiClient.ts:203-207](packages/client/src/apiClient.ts#L203-L207)
- **Description**: The server enforces "exactly one of `definition` or `yaml`"
  at runtime. The TS type `{definition} | {yaml}` doesn't enforce it either,
  because `{definition, yaml}` still type-checks.
- **Recommendation**:
  - On the server, use either a discriminated body
    (`{format: "yaml", text} | {format: "json", definition}`) or choose by
    `Content-Type`.
  - In TS, add `yaml?: never` and `definition?: never` to the two sides of the
    union.

### API-017: `GraphEdge` expresses its variant through nullable fields

- **Severity**: SUGGESTION
- **Status**: ✅ Fixed (2026-09-28).
  - `GraphEdge` is now a union on `kind`, and each member has only its own
    fields, none nullable:
    - `PlainEdge {kind: "plain", from, to}`
    - `BranchEdge {kind: "branch", from, to, branchId, routeIndex, isDefaultRoute, label}`
    - `LoopEdge {kind: "loop-continue" | "loop-exit", from, to, loopId, maxIterations, label}`
  - `loopMaxIterations` is now `maxIterations`, since the type already says
    it's a loop's. `GraphEdgeKind` is now `GraphEdge["kind"]`.
  - `graphModel.ts` reads edges through two narrowing helpers
    (`branchEdges`, `loopEdge`), with no `!== null` checks or `!` assertions.
  - The CLI renderer and the web canvas conversion narrow on `kind` too. The
    CLI renderer no longer builds a fake `{ kind } as GraphEdge` to pick a
    glyph; it uses a small style table.
  - Tests check each kind's exact fields, and a `@ts-expect-error` shows
    that a plain edge has no `branchId`.
- **Principle**: Make invalid states unrepresentable
- **File(s)**:
  - [types.ts:513-531](packages/client/src/types.ts#L513-L531)
- **Description**: `branchId`, `routeIndex`, `isDefaultRoute`, `loopId` and
  `loopMaxIterations` only apply to some edge kinds. Every renderer has to
  null-check fields that `kind` already determines.
- **Recommendation**: Make `GraphEdge` a discriminated union on `kind`.

### API-018: Smaller naming items

- **Severity**: SUGGESTION
- **Principle**: Naming conventions
- **File(s)**:
  - [api_schemas.py:452](llm_pipeline/llm_pipeline/api_schemas.py#L452)
  - [model_catalog.py:78-80](llm_pipeline/llm_pipeline/model_catalog.py#L78-L80)
  - [model_catalog.py:223](llm_pipeline/llm_pipeline/model_catalog.py#L223)
  - [pipeline_store.py:580-587](llm_pipeline/llm_pipeline/pipeline_store.py#L580-L587)
  - [draftOps.ts:64-66](packages/client/src/draftOps.ts#L64-L66)
- **Description**:
  - `exceptionUID` is the only camelCase field in an otherwise snake_case API,
    and it actually holds the request id.
  - `ModelCatalog` has a method named after a noun (`ollama()`), a type alias
    called `OllamaShower`, and a `check()`/`issues()` pair that doesn't say
    which raises.
  - `read_preset` raises the built-in `FileNotFoundError`, while pipelines
    raise `PipelineNotFoundError`.
  - `modelIdentity(undefined)` returns the display label `"(no model)"`.
- **Recommendation**:
  - Rename `exceptionUID` to `request_id`. The reference guide prefers
    camelCase JSON, but stay with snake_case here: the definition JSON is the
    YAML shape, and the OpenAI-compatible surface is snake_case.
  - Rename to `list_ollama_models`, `OllamaModelDetailsFetcher`, and
    `ensure_allowed` / `find_disallowed`.
  - Add a `PresetNotFoundError`.
  - Keep display labels out of the identity helper.
