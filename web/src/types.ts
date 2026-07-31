export interface ConversationTurn {
  prompt: string;
  final_answer: string;
}

export interface AskRequest {
  prompt: string;
  history: ConversationTurn[];
}

export interface ValidatorVote {
  validator_name: string;
  is_valid: boolean;
  feedback: string | null;
}

export interface Candidate {
  model_name: string;
  answer: string;
  is_valid: boolean;
  feedback: string | null;
  votes: ValidatorVote[];
}

export interface AskResponse {
  category: string;
  final_answer: string;
  winning_model: string;
  router_model: string;
  judge_model: string;
  candidates: Candidate[];
}

export interface HealthResponse {
  status: string;
  execution_mode: string;
  generation_collaboration: string;
  validation_mode: string;
  validation_quorum: number;
  validation_concurrency: string;
  max_history_turns: number;
  router_model: string;
  judge_model: string;
  generators_by_category: Record<string, string[]>;
  validators_by_category: Record<string, string[]>;
}
