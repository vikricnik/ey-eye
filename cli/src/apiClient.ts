import type { AskRequest, AskResponse, ConversationTurn, HealthResponse } from "./types.js";

export class PipelineApiError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "PipelineApiError";
  }
}

export class PipelineClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async checkHealth(): Promise<HealthResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/health`);
    } catch (err) {
      throw new PipelineApiError(
        `Could not reach pipeline server at ${this.baseUrl}. Is it running?`
      );
    }

    if (!response.ok) {
      throw new PipelineApiError(
        `Health check failed with status ${response.status}`,
        response.status
      );
    }

    return (await response.json()) as HealthResponse;
  }

  async ask(prompt: string, history: ConversationTurn[] = []): Promise<AskResponse> {
    const body: AskRequest = { prompt, history };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new PipelineApiError(
        `Could not reach pipeline server at ${this.baseUrl}. Is it running?`
      );
    }

    if (!response.ok) {
      let detail = `Request failed with status ${response.status}`;
      try {
        const errorBody = (await response.json()) as { detail?: string };
        if (errorBody.detail) {
          detail = errorBody.detail;
        }
      } catch {
        // response body wasn't JSON, keep the generic message
      }
      throw new PipelineApiError(detail, response.status);
    }

    return (await response.json()) as AskResponse;
  }
}
