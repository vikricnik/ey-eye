import type {
  ApiErrorBody,
  AskRequest,
  AskResponse,
  AskStreamEvent,
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
    public readonly validations?: ValidationIssue[],
    // Structured extra context — for a pipeline execution failure, this is
    // where node_id/loop_id live (see api_schemas.py's ErrorResponse.details
    // and specs/001-visual-dag-graph/contracts/pipeline-detail-api.md),
    // letting a live-status client mark the SPECIFIC node/loop a failure
    // is attributable to instead of only knowing the run as a whole failed.
    public readonly details?: Record<string, unknown>
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
    return new PipelineApiError(
      message,
      response.status,
      body.exceptionUID,
      body.validations,
      body.details
    );
  } catch {
    // response body wasn't JSON (or didn't match the expected shape) —
    // fall back to a generic message rather than throwing while handling
    // an error.
    return new PipelineApiError(fallbackMessage, response.status);
  }
}

/**
 * Parses one raw SSE event block (everything between two "\n\n" separators)
 * into its `event:` type and `data:` payload. Returns null for a block with
 * no data line (SSE allows comment-only or keep-alive blocks, which carry
 * no `data:` line — safe to ignore rather than treat as malformed).
 */
function parseSseEvent(raw: string): { event: string; data: string } | null {
  let event = "message"; // SSE spec default when no explicit `event:` line is present
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
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

  /**
   * Streaming variant of ask() — yields one event per graph node as it
   * completes (node-level streaming, not token-level; see the server's
   * routers/ask.py docstring for why). Browser's native EventSource only
   * supports GET requests, so this parses Server-Sent Events manually from
   * fetch()'s streaming response body instead — works identically in
   * Node.js (CLI) and browsers (web client).
   *
   * Throws PipelineApiError for both pre-stream failures (auth, rate
   * limit, pipeline not found — same as ask()) AND mid-stream execution
   * failures (the server sends an `error` SSE event in that case, which
   * this method converts into a thrown error rather than yielding it as a
   * normal event — see AskStreamEvent's doc comment for why).
   */
  async *askStream(
    prompt: string,
    pipelineName: string,
    history: ConversationTurn[] = []
  ): AsyncGenerator<AskStreamEvent, void, undefined> {
    const body: AskRequest = { prompt, pipeline_name: pipelineName, history };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ask/stream`, {
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
      // Pre-stream errors (400/401/404/422/429) arrive as a normal JSON
      // error body, not an SSE stream — same shape buildApiError already
      // handles for ask().
      throw await buildApiError(response);
    }

    if (!response.body) {
      throw new PipelineApiError("Streaming response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseEvent(rawEvent);
          if (!parsed) continue;

          if (parsed.event === "error") {
            const errBody = JSON.parse(parsed.data) as Partial<ApiErrorBody>;
            throw new PipelineApiError(
              errBody.message ?? "Pipeline execution failed",
              errBody.status,
              errBody.exceptionUID,
              errBody.validations,
              errBody.details
            );
          }
          if (
            parsed.event === "node_complete" ||
            parsed.event === "loop_iteration" ||
            parsed.event === "done"
          ) {
            yield { type: parsed.event, data: JSON.parse(parsed.data) } as AskStreamEvent;
          }
          // Any other event type is ignored rather than treated as an
          // error — forward-compatible if the server adds a new event
          // type this client doesn't know about yet.
        }
      }
    } catch (err) {
      // Re-throw a PipelineApiError (from the `error` event branch above)
      // unchanged; wrap anything else (a genuine network/parse failure
      // mid-stream) so every failure mode from this method is consistently
      // a PipelineApiError, matching ask()'s contract.
      if (err instanceof PipelineApiError) throw err;
      throw new PipelineApiError(
        `Stream reading failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      reader.releaseLock();
    }
  }
}
