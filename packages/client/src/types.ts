export interface ConversationTurn {
  prompt: string;
  final_answer: string;
  /** Node outputs the pipeline asked to remember with this turn — send back
   * what the run's `remembered` returned. */
  outputs?: Record<string, string>;
}

/** Run again from one node: it and every node after it call their models;
 * every other node reuses its output from `outputs` (the previous run's).
 * Send the same prompt and history as that run. */
export interface RerunRequest {
  from_node: string;
  outputs: Record<string, string>;
}

/** POST /pipelines/{name}/runs — the pipeline is named in the path. */
export interface RunRequest {
  prompt: string;
  history: ConversationTurn[];
  rerun?: RerunRequest;
}

/** What ask() and askStream() run: a pipeline, and the message for it. */
export interface AskInput {
  /** The pipeline to run — sent in the path, not the body. */
  pipeline: string;
  prompt: string;
  /** The conversation so far, oldest turn first. Default: none. */
  history?: ConversationTurn[];
  /** Re-run the run these outputs came from, starting at one node. */
  rerun?: RerunRequest;
}

export interface RequestOptions {
  /** Stops the request: the call then throws RequestCancelledError, and
   * the server stops the run (and its model calls) once it notices. */
  signal?: AbortSignal;
}

/** What the model's backend reported for a node's call (its last one, for
 * a node a loop re-ran). Any field may be null when not reported. */
export interface NodeUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Time spent generating the reply — excludes loading the model and
   * reading the prompt. */
  generation_ms: number | null;
  /** Tokens the model could see: the node's num_ctx, else what the loaded
   * Ollama model runs with. Null when unknown (e.g. cloud providers). */
  context_window: number | null;
  /** Characters sent (prompt + system prompt). prompt_tokens is counted
   * after Ollama cuts a prompt that doesn't fit, so both matter. */
  prompt_chars?: number | null;
}

export interface NodeOutput {
  node_id: string;
  model_name: string;
  output: string;
  duration_ms: number;
  /** Absent/null when the backend reported nothing (or an older server). */
  usage?: NodeUsage | null;
  /** Reused from the previous run by a re-run, not generated now. */
  replayed?: boolean;
}

export interface RunResponse {
  pipeline_name: string;
  output_node: string; // whichever output_node candidate actually resolved
  final_answer: string;
  node_outputs: Record<string, NodeOutput>;
  loop_iterations: Record<string, number>;
  /** Outputs of the pipeline's `history.remember` nodes: keep them with this
   * turn (as its `outputs`) when sending history next time. */
  remembered?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Streaming (POST /pipelines/{name}/runs with Accept: text/event-stream) —
// Server-Sent Events: node_start, node_token as models generate text,
// node_complete, loop_iteration, then done. See PipelineClient.askStream()
// for how these are consumed.
// ---------------------------------------------------------------------------

/** A node just started calling its model — sent by the server itself, so
 * clients never have to guess what is running. Always followed by that
 * node's node_complete, or by an error naming it. A node re-run by a loop
 * sends one per iteration. */
export interface NodeStartEvent {
  node_id: string;
  model_name: string;
  /** 1 for the first try, 2+ when retrying after a failed model call —
   * any text streamed for an earlier attempt should be discarded. */
  attempt?: number;
  /** What the model receives: the rendered prompt (the run's input and its
   * dependencies' outputs filled in) and the node's system prompt. */
  prompt?: string | null;
  system?: string | null;
  /** A re-run is reusing this node's previous output — no model call. */
  replayed?: boolean;
}

/** A piece of text a node's model just generated (token-level streaming).
 * A node's tokens since its latest node_start concatenate to its output
 * so far; node_complete then carries the authoritative full output. */
export interface NodeTokenEvent {
  node_id: string;
  text: string;
}

export interface NodeCompleteEvent {
  node: NodeOutput;
}

export interface LoopIterationEvent {
  loop_id: string;
  iteration: number;
}

export interface StreamDoneEvent {
  pipeline_name: string;
  output_node: string;
  final_answer: string;
  node_outputs: Record<string, NodeOutput>;
  loop_iterations: Record<string, number>;
  /** Outputs of the pipeline's `history.remember` nodes: keep them with this
   * turn (as its `outputs`) when sending history next time. */
  remembered?: Record<string, string>;
}

// A discriminated union over every event askStream() yields — consumers
// switch on `.type` to narrow to the right payload shape. Note there's no
// "error" variant here: askStream() throws a PipelineApiError when the
// server sends an error event mid-stream, matching ask()'s existing
// Promise-rejection ergonomics rather than requiring consumers to
// remember to check `.type === "error"` on every iteration.
export type AskStreamEvent =
  | { type: "node_start"; data: NodeStartEvent }
  | { type: "node_token"; data: NodeTokenEvent }
  | { type: "node_complete"; data: NodeCompleteEvent }
  | { type: "loop_iteration"; data: LoopIterationEvent }
  | { type: "done"; data: StreamDoneEvent };

export interface PipelineSummary {
  name: string;
  description: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Pipeline structure — what a client draws, derived from a definition by
// graphModel.ts's detailFromDefinition(). Not sent by the server: GET
// /pipelines/{name} returns the definition itself (PipelineDefinitionResponse).
// ---------------------------------------------------------------------------

export interface PipelineNodeInfo {
  id: string;
  type: string;
  depends_on: string[];
  /** A display label, not an identity: "provider:model", plus " (default)"
   * when the node inherits the pipeline's default model (displayModel()). */
  model: string;
}

export interface PipelineBranchRouteInfo {
  /** One node, or several that all start when this route is taken. */
  to: string | string[];
  when: string | null;
  default: boolean;
}

export interface PipelineBranchInfo {
  id: string;
  from: string;
  routes: PipelineBranchRouteInfo[];
}

export interface PipelineLoopInfo {
  id: string;
  from: string;
  back_to: string;
  exit_to: string;
  max_iterations: number;
  on_max_iterations: "proceed" | "fail";
}

export interface PipelineDetail {
  name: string;
  description: string;
  // One or more candidates — only ONE actually resolves per request once
  // branches mean mutually exclusive terminal nodes.
  output_node_candidates: string[];
  nodes: PipelineNodeInfo[];
  branches: PipelineBranchInfo[];
  loops: PipelineLoopInfo[];
}

/** GET /health — open, for load balancers: only whether the server is up. */
export interface HealthResponse {
  status: "ok";
}

/** GET /server-info — what a client needs to start. The pipelines
 * themselves are GET /pipelines. */
export interface ServerInfoResponse {
  /** The pipeline to open first; it can't be deleted. */
  default_pipeline_name: string;
  /** Whether saving pipelines/presets is enabled on this server. */
  editing_enabled: boolean;
  /** Why editing is off even though the server was asked to enable it. */
  editing_disabled_reason: string | null;
}

export interface PipelinesListResponse {
  pipelines: PipelineSummary[];
}

// ---------------------------------------------------------------------------
// Full pipeline definitions — the exact shape of a pipeline YAML file, as
// the editing endpoints send and accept it. Optional fields are omitted
// when unset (never null). See llm_pipeline/README.md for what each does.
// ---------------------------------------------------------------------------

export type ProviderType = "ollama" | "openai" | "anthropic" | "gemini" | "copilot";

export const PROVIDERS: readonly ProviderType[] = [
  "ollama",
  "openai",
  "anthropic",
  "gemini",
  "copilot",
];

/** Ollama-only generation options. Unset = the model's own default. */
export interface OllamaOptions {
  top_p?: number;
  top_k?: number;
  tfs_z?: number;
  repeat_penalty?: number;
  repeat_last_n?: number;
  seed?: number;
  stop?: string[];
  mirostat?: 0 | 1 | 2;
  mirostat_eta?: number;
  mirostat_tau?: number;
  num_ctx?: number;
  num_predict?: number;
  num_gpu?: number;
  num_thread?: number;
  keep_alive?: number | string;
  format?: "json";
}

export interface NodeModelConfig {
  provider: ProviderType;
  model: string;
  /** Unset: the pipeline default's temperature, else 0.2. */
  temperature?: number;
  /** Only valid when provider is "ollama" — the server rejects it otherwise. */
  options?: OllamaOptions;
}

export interface NodeLayout {
  x: number;
  y: number;
}

export interface NodeConfig {
  id: string;
  type?: "llm_call";
  depends_on?: string[];
  model?: NodeModelConfig;
  /** Sent as a real system message; plain text, not a template. Unset:
   * the pipeline's default system prompt. */
  system_prompt?: string;
  prompt_template: string;
  /** false: the node doesn't see the conversation ({{ input }} is just the
   * new message, {{ history }} empty). Default true. */
  include_history?: boolean;
  /** Remove <think>…</think> reasoning from the output. Unset: pipeline default. */
  strip_reasoning?: boolean;
  /** Makes the node a classifier: its output becomes exactly one of these
   * labels, and the run fails if the answer names none of them. */
  labels?: string[];
  /** Where the visual editor draws the node. The engine ignores it. */
  layout?: NodeLayout;
}

/** Settings every node inherits unless it sets its own. */
export interface NodeDefaults {
  /** Used by nodes without a model; also supplies the temperature and (when
   * both are Ollama) Ollama options that a node's own model leaves unset. */
  model?: NodeModelConfig;
  system_prompt?: string;
  strip_reasoning?: boolean;
}

export interface HistorySummaryConfig {
  model: NodeModelConfig;
  /** Template; must include {{ history }}. */
  prompt?: string;
}

/** How earlier turns reach the nodes (how many: execution.max_history_turns). */
export interface HistoryConfig {
  /** First line of the history inside {{ input }}. */
  intro?: string;
  /** Template for one earlier turn; variables: prompt, answer, outputs. */
  turn_template?: string;
  /** Character budget for verbatim turns; oldest dropped (or summarized) first. */
  max_chars?: number;
  /** Condense turns that don't fit with this model instead of dropping them. */
  summarize?: HistorySummaryConfig;
  /** Nodes whose outputs are remembered with each turn. */
  remember?: string[];
}

export interface ExecutionConfig {
  model_timeout_seconds?: number;
  max_history_turns?: number;
  max_retries?: number;
  retry_backoff_seconds?: number;
  /** At most this many nodes call models at once (unset: no limit). */
  max_concurrency?: number;
}

export interface BranchRoute {
  when?: string;
  default?: boolean;
  /** One node, or several that all start (in parallel) when this route is taken. */
  to: string | string[];
}

/** A route's targets as a list, whichever form `to` was written in. */
export function routeTargets(route: { to: string | string[] }): string[] {
  return typeof route.to === "string" ? [route.to] : route.to;
}

export interface BranchConfig {
  id: string;
  from: string;
  routes: BranchRoute[];
}

export interface LoopConfig {
  id: string;
  from: string;
  back_to: string;
  /** A node id, or "END" to finish the run when the loop exits. */
  exit_to: string;
  exit_when: string;
  max_iterations?: number;
  on_max_iterations?: "proceed" | "fail";
}

export interface PipelineDefinition {
  version?: number;
  name: string;
  description?: string;
  execution?: ExecutionConfig;
  defaults?: NodeDefaults;
  history?: HistoryConfig;
  nodes: NodeConfig[];
  branches?: BranchConfig[];
  loops?: LoopConfig[];
  output_node: string | string[];
  /** Test cases — the engine ignores them; see runTests(). */
  tests?: TestsConfig;
}

/** One thing a test case's answer must satisfy — exactly one of these. */
export interface EvalExpectation {
  /** Case-insensitive substring. */
  contains?: string;
  not_contains?: string;
  /** A condition on `output`, the language branch conditions use. */
  check?: string;
  /** A requirement the judge model grades PASS or FAIL. */
  judge?: string;
}

export type ExpectationKind = keyof EvalExpectation;

/** A message to run the pipeline with (no conversation before it) and what
 * its answer must satisfy — nothing, to just see the answer. */
export interface EvalCase {
  name: string;
  input: string;
  expect?: EvalExpectation[];
}

export interface EvalJudge {
  model: NodeModelConfig;
  /** Variables: question, answer, criterion. Unset: the server's default. */
  prompt?: string;
}

export interface TestsConfig {
  judge?: EvalJudge;
  cases?: EvalCase[];
}

/** A saved node (stored as a preset): one node's whole configuration,
 * reusable in any pipeline. Adding or applying it COPIES the values into
 * the node — pipelines never reference saved nodes by name. */
export interface NodePreset {
  name: string;
  description?: string;
  model: NodeModelConfig;
  system_prompt?: string;
  /** Unset in older presets that saved only model settings. */
  prompt_template?: string;
  /** false: nodes made from it don't see the conversation. */
  include_history?: boolean;
  strip_reasoning?: boolean;
}

export interface ModelInfo {
  name: string;
  size_bytes?: number | null;
  parameter_size?: string | null;
  quantization?: string | null;
  family?: string | null;
}

export interface ProviderModels {
  provider: string;
  reachable: boolean;
  error?: string | null;
  models: ModelInfo[];
}

/** Limits of one installed Ollama model (GET /models/ollama/{name}). */
export interface ModelLimitsResponse {
  name: string;
  context_length?: number | null;
  parameter_size?: string | null;
  quantization?: string | null;
  family?: string | null;
}

export interface ModelsResponse {
  providers: ProviderModels[];
}

export interface PipelineDefinitionResponse {
  definition: PipelineDefinition;
  /** Also sent as the ETag. Pass it to updatePipeline() as `baseRevision`
   * (sent as If-Match) so the save refuses to overwrite a newer version. */
  revision: string;
  /** The file has YAML comments (kept when saving). */
  has_comments: boolean;
}

export interface DefinitionIssue {
  node_id: string | null;
  message: string;
}

/** POST /drafts/validation — exactly one of `definition` or `yaml`. */
export interface ValidatePipelineRequest {
  definition?: PipelineDefinition;
  yaml?: string;
}

export interface ValidatePipelineResponse {
  definition: PipelineDefinition;
  /** Canonical file text — what a save would write, and what to export. */
  yaml: string;
  /** Models a save would currently reject — shown as warnings. */
  model_issues: DefinitionIssue[];
  /** Settings beyond what a model supports (e.g. num_ctx above its max
   * context). Advisory only; saving isn't blocked. */
  warnings?: DefinitionIssue[];
}

/** PUT /pipelines/{name}. Whether it creates or updates is said by a
 * header — see createPipeline() and updatePipeline(). */
export interface SavePipelineRequest {
  definition: PipelineDefinition;
}

export interface SavePipelineResponse {
  definition: PipelineDefinition;
  revision: string;
  /** Saving keeps an existing file's comments and layout; false only when
   * the server had to rewrite it in canonical form. */
  comments_preserved?: boolean;
}

/** PUT /presets/{name}. */
export interface SavePresetRequest {
  preset: NodePreset;
}

export interface PresetResponse {
  preset: NodePreset;
  /** Also sent as the ETag — pass it to savePreset()/deletePreset() to
   * refuse overwriting a newer version (preset writes are otherwise
   * last-write-wins). */
  revision: string;
}

export interface PresetsListResponse {
  presets: NodePreset[];
}

/** Deletions are recoverable: the file was moved to `recoverable_as`
 * (a `.deleted/` folder inside the pipelines or presets directory). */
export interface DeletedResponse {
  name: string;
  recoverable_as: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  type: string;
}

/** What went wrong — the server's ErrorCode (api_schemas.py), for code
 * that must act differently per failure. `status` alone can't tell apart
 * failures that share one (412: changed since loaded, or name taken);
 * each code always comes with the same status. The server may add codes; treat one you don't know by its status. */
export type ErrorCode =
  | "REQUEST_INVALID"
  | "UNAUTHENTICATED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "NAME_INVALID"
  | "PIPELINE_NOT_FOUND"
  | "PRESET_NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "DEFINITION_INVALID"
  | "MODEL_NOT_ALLOWED"
  | "EDITING_DISABLED"
  | "ALREADY_EXISTS"
  | "REVISION_CONFLICT"
  | "PIPELINE_PROTECTED"
  | "PRECONDITION_REQUIRED"
  | "INPUT_INVALID"
  | "INPUT_TOO_LARGE"
  | "NODE_NOT_FOUND"
  | "TEST_CASE_NOT_FOUND"
  | "TEMPLATE_RENDER_FAILED"
  | "PIPELINE_RUN_FAILED"
  | "REQUEST_CANCELLED";

// Matches the server's ErrorResponse model exactly (api_schemas.py) —
// every error response, regardless of status code or where it was raised,
// takes this shape.
export interface ErrorResponse {
  timestamp: string;
  status: number;
  error: string;
  code: ErrorCode;
  message: string;
  request: string;
  exceptionUID: string;
  details: Record<string, unknown>;
  validations: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Graph model — the shared, structural representation of a pipeline's DAG
// shape, built from a PipelineDetail by graphModel.ts's buildGraphModel()
// and rendered by both cli (as text) and web (as SVG). See
// specs/001-visual-dag-graph/data-model.md for the full field-by-field
// rationale; kept here rather than duplicated per-consumer for the same
// reason PipelineDetail itself lives in this shared package.
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  model: string;
  /** Layout depth: 0 for a root, otherwise 1 + max(level of structural predecessors). */
  level: number;
  isOutputCandidate: boolean;
}

export type GraphEdgeKind = "plain" | "branch" | "loop-continue" | "loop-exit";

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** Branch: the route's `when` expression, or "default". Loop: id + target/max-iterations. Null for plain edges. */
  label: string | null;
  branchId: string | null;
  /** Which of the branch's routes this edge belongs to — a route with
   * several targets draws one edge per target. Null for non-branch edges. */
  routeIndex: number | null;
  isDefaultRoute: boolean;
  loopId: string | null;
  /** The loop's configured max_iterations, structured (not just baked into
   * `label`'s text) so live-status folding can initialize/compare
   * LoopProgress.maxIterations numerically. Null for non-loop edges. */
  loopMaxIterations: number | null;
}

export interface GraphModel {
  pipelineName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Live, per-run view state — folded from AskStreamEvents/errors on top of a
// GraphModel. Transient: reset whenever the pipeline changes or a new
// prompt starts (FR-013).
// ---------------------------------------------------------------------------

export type NodeExecutionStatus = "not-started" | "running" | "complete" | "failed";

export interface BranchRouteOutcome {
  branchId: string;
  /** Every target of the route that was taken. */
  takenTargets: string[];
}

export interface LoopProgress {
  loopId: string;
  iteration: number;
  maxIterations: number;
  exhausted: boolean;
}

export interface GraphViewState {
  graph: GraphModel;
  nodeStatus: Record<string, NodeExecutionStatus>;
  branchOutcomes: Record<string, BranchRouteOutcome>;
  loopProgress: Record<string, LoopProgress>;
  connectionError: string | null;
  /** Set once the server has sent a node_start event. From then on,
   * `running` comes only from those events rather than being inferred
   * from the graph shape (inference remains the fallback for buffered
   * answered (not streamed) runs and for servers that don't send
   * node_start). */
  serverReportsStarts: boolean;
}

/** POST /drafts/prompt-preview — what a node of `definition` (saved or not)
 * would receive, given a message, the conversation so far and other
 * nodes' outputs (e.g. the last run's). Needs editing enabled. */
export interface PreviewPromptRequest {
  definition: PipelineDefinition;
  node_id: string;
  /** Empty: a placeholder stands in for the message. */
  prompt?: string;
  history?: ConversationTurn[];
  outputs?: Record<string, string>;
}

export interface PreviewPromptResponse {
  prompt: string;
  system: string | null;
  /** The node's inputs with no output given — placeholders in `prompt`. */
  missing: string[];
}

/** The pipeline with other models for some nodes: node id -> model block. */
export interface VariantRequest {
  label: string;
  models: Record<string, NodeModelConfig>;
}

/** POST /drafts/test-runs. `cases` picks some by name (default: all);
 * `inputs` adds one-off messages; each variant runs every case too, next
 * to the definition as it is ("current"). Needs editing enabled. */
export interface RunTestsRequest {
  definition: PipelineDefinition;
  cases?: string[];
  inputs?: string[];
  variants?: VariantRequest[];
}

export interface ExpectationResult {
  kind: ExpectationKind;
  expected: string;
  passed: boolean;
  /** The judge's reply, or why a check couldn't be evaluated. */
  detail?: string | null;
}

export interface CaseResult {
  case: string;
  variant: string;
  /** Null when the case has no expectations — it only shows the answer. */
  passed: boolean | null;
  answer?: string | null;
  output_node?: string | null;
  /** Set when the run itself failed. */
  error?: string | null;
  expectations: ExpectationResult[];
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface VariantSummary {
  variant: string;
  passed: number;
  failed: number;
  errors: number;
  unchecked: number;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** A case has started running, for one variant. */
export interface CaseStartEvent {
  case: string;
  variant: string;
}

/** Every case has run: the totals per variant. */
export interface TestsDoneEvent {
  summaries: VariantSummary[];
}

export type TestRunEvent =
  | { type: "case_start"; data: CaseStartEvent }
  | { type: "case_result"; data: CaseResult }
  | { type: "tests_done"; data: TestsDoneEvent };
