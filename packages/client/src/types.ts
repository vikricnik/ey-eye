export interface ConversationTurn {
  prompt: string;
  final_answer: string;
}

export interface AskRequest {
  prompt: string;
  pipeline_name: string;
  history: ConversationTurn[];
}

export interface NodeOutput {
  node_id: string;
  model_name: string;
  output: string;
  duration_ms: number;
}

export interface AskResponse {
  pipeline_name: string;
  output_node: string; // whichever output_node candidate actually resolved
  final_answer: string;
  node_outputs: Record<string, NodeOutput>;
  loop_iterations: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Streaming (POST /ask/stream) — Server-Sent Events. Node-level streaming,
// not token-level: one event per graph node completion, not per LLM token.
// See PipelineClient.askStream() for how these are consumed.
// ---------------------------------------------------------------------------

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
}

// A discriminated union over every event askStream() yields — consumers
// switch on `.type` to narrow to the right payload shape. Note there's no
// "error" variant here: askStream() throws a PipelineApiError when the
// server sends an error event mid-stream, matching ask()'s existing
// Promise-rejection ergonomics rather than requiring consumers to
// remember to check `.type === "error"` on every iteration.
export type AskStreamEvent =
  | { type: "node_complete"; data: NodeCompleteEvent }
  | { type: "loop_iteration"; data: LoopIterationEvent }
  | { type: "done"; data: StreamDoneEvent };

export interface PipelineSummary {
  name: string;
  description: string;
  filename: string;
}

export interface PipelineNodeInfo {
  id: string;
  type: string;
  depends_on: string[];
  model: string;
}

export interface PipelineBranchRouteInfo {
  to: string;
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

export interface HealthResponse {
  status: string;
  pipelines_dir: string;
  default_pipeline_name: string;
  available_pipelines: PipelineSummary[];
}

export interface PipelinesListResponse {
  pipelines: PipelineSummary[];
}

export interface ValidationIssue {
  field: string;
  message: string;
  type: string;
}

// Matches the server's ErrorResponse model exactly (api_schemas.py) —
// every error response, regardless of status code or where it was raised,
// takes this shape.
export interface ApiErrorBody {
  timestamp: string;
  status: number;
  error: string;
  message: string;
  request: string;
  exceptionUID: string;
  details: Record<string, unknown>;
  validations: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Graph model — the shared, structural representation of a pipeline's DAG
// shape, built once from PipelineDetail by graphModel.ts's buildGraphModel()
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
  takenTo: string | null;
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
}
