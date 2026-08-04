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

export interface PipelineBranchInfo {
  id: string;
  from: string;
  routes: string[];
}

export interface PipelineLoopInfo {
  id: string;
  from: string;
  back_to: string;
  exit_to: string;
  max_iterations: number;
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
