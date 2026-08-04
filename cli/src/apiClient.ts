import type {
  AskRequest,
  AskResponse,
  ConversationTurn,
  HealthResponse,
  PipelineDetail,
  PipelinesListResponse,
} from "./types.js";

export class PipelineApiError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "PipelineApiError";
  }
}

async function parseErrorDetail(response: Response): Promise<string> {
  let detail = `Request failed with status ${response.status}`;
  try {
    const errorBody = (await response.json()) as { detail?: string };
    if (errorBody.detail) {
      detail = errorBody.detail;
    }
  } catch {
    // response body wasn't JSON, keep the generic message
  }
  return detail;
}

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
      throw new PipelineApiError(await parseErrorDetail(response), response.status);
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
      // but PIPELINE_API_KEY wasn't set (or is wrong) on this client — the
      // generic parseErrorDetail message already surfaces the server's
      // detail text, so no special-casing needed beyond that.
      throw new PipelineApiError(await parseErrorDetail(response), response.status);
    }

    return (await response.json()) as AskResponse;
  }
}
