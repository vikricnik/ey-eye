import type {
  ApiErrorBody,
  AskRequest,
  AskResponse,
  ConversationTurn,
  HealthResponse,
  PipelineDetail,
  PipelinesListResponse,
  ValidationIssue,
} from "./types.js";

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
    // response body wasn't JSON (or didn't match the expected shape) —
    // fall back to a generic message rather than throwing while handling
    // an error.
    return new PipelineApiError(fallbackMessage, response.status);
  }
}

/**
 * Typed client for the pipeline server's HTTP API. Shared between the CLI
 * and web clients so the request/response contract only has one source of
 * truth — see each consumer's own README for how it specifically supplies
 * `apiKey` (CLI: `PIPELINE_API_KEY` env var; web: `window.PIPELINE_API_KEY`,
 * with the important caveat that anything set there is visible to anyone
 * with browser devtools open).
 */
export class PipelineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private authHeaders(): Record<string, string> {
    // Only sent if an API key is actually configured — /health doesn't
    // need it (the server never requires auth on that endpoint), and if
    // the server has no API_KEYS configured either, this header is simply
    // ignored server-side.
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
      // A 401 here almost always means the server has API_KEYS configured
      // but the client's apiKey wasn't set (or is wrong).
      throw await buildApiError(response);
    }

    return (await response.json()) as AskResponse;
  }
}
