import type {
  AskRequest,
  AskResponse,
  ConversationTurn,
  HealthResponse,
  PipelineDetail,
  PipelinesListResponse,
} from "./types";

export interface ValidationIssue {
  field: string;
  message: string;
  type: string;
}

// Matches the server's ErrorResponse model exactly (models.py) — every
// error response, regardless of status code or where it was raised, takes
// this shape.
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

export class PipelineApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly exceptionUID?: string,
    public readonly validations?: ValidationIssue[]
  ) {
    super(message);
    this.name = "PipelineApiError";
  }
}

async function buildApiError(response: Response): Promise<PipelineApiError> {
  const fallbackMessage = `Request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    let message = body.message ?? fallbackMessage;
    if (body.validations && body.validations.length > 0) {
      const fieldDetails = body.validations.map((v) => `${v.field}: ${v.message}`).join("; ");
      message = `${message} (${fieldDetails})`;
    }
    return new PipelineApiError(message, response.status, body.exceptionUID, body.validations);
  } catch {
    return new PipelineApiError(fallbackMessage, response.status);
  }
}

export class PipelineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private authHeaders(): Record<string, string> {
    // NOTE: any key set here is visible to anyone with browser devtools —
    // this is a "shared team secret" pattern suitable for an internal tool
    // behind its own access control, not a real security boundary for a
    // public-facing deployment. See README for details.
    return this.apiKey ? { "X-API-Key": this.apiKey } : {};
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { headers: this.authHeaders() });
    } catch {
      throw new PipelineApiError(
        `Could not reach pipeline server at ${this.baseUrl}. Is it running?`
      );
    }

    if (!response.ok) {
      throw await buildApiError(response);
    }

    return (await response.json()) as T;
  }

  async checkHealth(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  async listPipelines(): Promise<PipelinesListResponse> {
    return this.get<PipelinesListResponse>("/pipelines");
  }

  async getPipelineDetail(name: string): Promise<PipelineDetail> {
    return this.get<PipelineDetail>(`/pipelines/${encodeURIComponent(name)}`);
  }

  async ask(
    prompt: string,
    pipelineName: string,
    history: ConversationTurn[] = []
  ): Promise<AskResponse> {
    const body: AskRequest = { prompt, pipeline_name: pipelineName, history };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(body),
      });
    } catch {
      throw new PipelineApiError(
        `Could not reach pipeline server at ${this.baseUrl}. Is it running?`
      );
    }

    if (!response.ok) {
      throw await buildApiError(response);
    }

    return (await response.json()) as AskResponse;
  }
}
