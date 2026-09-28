import type {
  ApiErrorBody,
  DeletedResponse,
  ErrorCode,
  AskOptions,
  AskRequest,
  RequestOptions,
  AskResponse,
  AskStreamEvent,
  ConversationTurn,
  HealthResponse,
  ModelLimits,
  ModelsResponse,
  NodePreset,
  PipelineDefinition,
  PipelineDefinitionResponse,
  PipelineDetail,
  PipelinesListResponse,
  PresetResponse,
  PreviewPromptRequest,
  PreviewPromptResponse,
  RunTestsRequest,
  PresetsListResponse,
  SavePipelineResponse,
  TestRunEvent,
  ValidatePipelineResponse,
  ValidationIssue,
} from "./types.js";

/** The caller stopped the request (its AbortSignal fired) — not a failure. */
export class RequestCancelledError extends Error {
  constructor() {
    super("stopped");
    this.name = "RequestCancelledError";
  }
}

/** What the server reported about a failure — see ApiErrorBody. */
export interface PipelineApiErrorInfo {
  statusCode?: number | undefined;
  code?: ErrorCode | undefined;
  exceptionUID?: string | undefined;
  validations?: ValidationIssue[] | undefined;
  details?: Record<string, unknown> | undefined;
  serverMessage?: string | undefined;
}

export class PipelineApiError extends Error {
  readonly statusCode: number | undefined;
  /** Which failure this is — branch on this, not on `statusCode`. Unset
   * when the server was never reached. */
  readonly code: ErrorCode | undefined;
  readonly exceptionUID: string | undefined;
  readonly validations: ValidationIssue[] | undefined;
  /** Structured extra context — for a pipeline execution failure, this is
   * where node_id/loop_id live (see api_schemas.py's ErrorResponse.details
   * and specs/001-visual-dag-graph/contracts/pipeline-detail-api.md),
   * letting a live-status client mark the SPECIFIC node/loop a failure
   * is attributable to instead of only knowing the run as a whole failed. */
  readonly details: Record<string, unknown> | undefined;
  /** The server's own `message`, without the per-field validation details
   * appended to `.message` — for UIs that show those separately. */
  readonly serverMessage: string | undefined;

  constructor(message: string, info: PipelineApiErrorInfo = {}) {
    super(message);
    this.name = "PipelineApiError";
    this.statusCode = info.statusCode;
    this.code = info.code;
    this.exceptionUID = info.exceptionUID;
    this.validations = info.validations;
    this.details = info.details;
    this.serverMessage = info.serverMessage;
  }
}

/** The error an ErrorResponse body describes — a failed request's, or a
 * stream's `error` event, so both carry the same fields. */
function errorFromBody(
  body: Partial<ApiErrorBody>,
  statusCode: number | undefined,
  fallbackMessage: string
): PipelineApiError {
  let message = body.message ?? fallbackMessage;
  if (body.validations && body.validations.length > 0) {
    const fieldDetails = body.validations.map((v) => `${v.field}: ${v.message}`).join("; ");
    message = `${message} (${fieldDetails})`;
  }
  return new PipelineApiError(message, {
    statusCode,
    code: body.code,
    exceptionUID: body.exceptionUID,
    validations: body.validations,
    details: body.details,
    serverMessage: body.message,
  });
}

async function buildApiError(response: Response): Promise<PipelineApiError> {
  const fallbackMessage = `Request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    return errorFromBody(body, response.status, fallbackMessage);
  } catch {
    // response body wasn't JSON (or didn't match the expected shape) —
    // fall back to a generic message rather than throwing while handling
    // an error.
    return new PipelineApiError(fallbackMessage, { statusCode: response.status });
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

const ASK_EVENTS: ReadonlySet<string> = new Set(["node_start", "node_token", "node_complete", "loop_iteration", "done"]);
const TEST_EVENTS: ReadonlySet<string> = new Set(["case_start", "case_result", "tests_done"]);

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
    return this.request<T>("GET", path);
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? this.authHeaders()
            : { "Content-Type": "application/json", ...this.authHeaders() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
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

  // ---- editing ---------------------------------------------------------

  /** Models this server lets an editor select (installed Ollama models +
   * the cloud allowlist). `refresh` bypasses the server's short cache. */
  async listModels(refresh = false): Promise<ModelsResponse> {
    return this.get<ModelsResponse>(refresh ? "/models?refresh=true" : "/models");
  }

  /** Max context, size and quantization of an installed Ollama model.
   * Throws (404) when it isn't installed or Ollama can't be reached. */
  async getModelLimits(ollamaModel: string): Promise<ModelLimits> {
    const path = ollamaModel.split("/").map(encodeURIComponent).join("/");
    return this.get<ModelLimits>(`/models/ollama/${path}`);
  }

  /** The complete definition (prompts, options, layout) plus the revision
   * to pass back to savePipeline(). */
  async getPipelineDefinition(name: string): Promise<PipelineDefinitionResponse> {
    return this.get<PipelineDefinitionResponse>(
      `/pipelines/${encodeURIComponent(name)}/definition`
    );
  }

  /** Validates without saving. Pass a definition (live validation, export
   * — the result's `yaml` is the canonical file text) or YAML text
   * (import — the result's `definition` is the parsed pipeline). Throws a
   * PipelineApiError (status 422, `details.node_id` when a node is at
   * fault) if it's invalid. */
  async validatePipeline(
    input: { definition: PipelineDefinition } | { yaml: string }
  ): Promise<ValidatePipelineResponse> {
    return this.request<ValidatePipelineResponse>("POST", "/pipelines/validate", input);
  }

  /** What a node would receive — see PreviewPromptRequest. */
  async previewPrompt(req: PreviewPromptRequest): Promise<PreviewPromptResponse> {
    return this.request<PreviewPromptResponse>("POST", "/pipelines/preview", req);
  }

  /** Creates (`baseRevision` null) or updates a pipeline. Throws with
   * status 409 if it already exists (create) or changed since
   * `baseRevision` was loaded, 403 if editing is disabled server-side. */
  async savePipeline(
    definition: PipelineDefinition,
    baseRevision: string | null
  ): Promise<SavePipelineResponse> {
    return this.request<SavePipelineResponse>(
      "PUT",
      `/pipelines/${encodeURIComponent(definition.name)}`,
      { definition, base_revision: baseRevision }
    );
  }

  async listPresets(): Promise<PresetsListResponse> {
    return this.get<PresetsListResponse>("/presets");
  }

  async getPreset(name: string): Promise<PresetResponse> {
    return this.get<PresetResponse>(`/presets/${encodeURIComponent(name)}`);
  }

  /** Soft-deletes a pipeline (moved to pipelines/.deleted/). With
   * `revision`, refused (409) if it changed since it was loaded; the
   * server's default pipeline can't be deleted (409). */
  async deletePipeline(name: string, revision?: string): Promise<DeletedResponse> {
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
    return this.request<DeletedResponse>("DELETE", `/pipelines/${encodeURIComponent(name)}${query}`);
  }

  /** Soft-deletes a preset (moved to presets/.deleted/). */
  async deletePreset(name: string): Promise<DeletedResponse> {
    return this.request<DeletedResponse>("DELETE", `/presets/${encodeURIComponent(name)}`);
  }

  /** Creates or replaces a preset. */
  async savePreset(preset: NodePreset): Promise<PresetResponse> {
    return this.request<PresetResponse>("PUT", `/presets/${encodeURIComponent(preset.name)}`, {
      preset,
    });
  }

  async ask(
    prompt: string,
    pipelineName: string,
    history: ConversationTurn[] = [],
    options: AskOptions & RequestOptions = {}
  ): Promise<AskResponse> {
    const { signal, ...request } = options;
    const body: AskRequest = { prompt, pipeline_name: pipelineName, history, ...request };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new RequestCancelledError();
      throw new PipelineApiError(
        `Could not reach pipeline server at ${this.baseUrl}. Is it running?`
      );
    }

    if (!response.ok) {
      // A 401 here almost always means the server has API_KEYS configured
      // but the client's apiKey wasn't set (or is wrong).
      throw await buildApiError(response);
    }

    try {
      return (await response.json()) as AskResponse;
    } catch (err) {
      if (signal?.aborted) throw new RequestCancelledError();
      throw err;
    }
  }

  /**
   * Streaming variant of ask() — yields a node_start event as each graph
   * node begins and a node_complete as it finishes (node-level streaming,
   * not token-level; see the server's
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
    history: ConversationTurn[] = [],
    options: AskOptions & RequestOptions = {}
  ): AsyncGenerator<AskStreamEvent, void, undefined> {
    const { signal, ...request } = options;
    const body: AskRequest = { prompt, pipeline_name: pipelineName, history, ...request };
    for await (const { event, data } of this.postStream("/ask/stream", body, ASK_EVENTS, signal)) {
      yield { type: event, data } as AskStreamEvent;
    }
  }

  /** Runs a definition's test cases (and each variant's) — case_start /
   * case_result per case and variant, then tests_done. Needs editing
   * enabled on the server. */
  async *runTests(
    req: RunTestsRequest,
    options: RequestOptions = {}
  ): AsyncGenerator<TestRunEvent, void, undefined> {
    for await (const { event, data } of this.postStream("/pipelines/test", req, TEST_EVENTS, options.signal)) {
      yield { type: event, data } as TestRunEvent;
    }
  }

  /**
   * POSTs `body` and yields the reply's Server-Sent Events, parsed by hand
   * (the browser's EventSource only does GET) — works the same in Node.js
   * and browsers. Pre-stream failures and an `error` event are thrown as a
   * PipelineApiError; events not in `known` are skipped, so a server that
   * adds an event type doesn't break older clients.
   */
  private async *postStream(
    path: string,
    body: unknown,
    known: ReadonlySet<string>,
    signal?: AbortSignal
  ): AsyncGenerator<{ event: string; data: unknown }, void, undefined> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new RequestCancelledError();
      throw new PipelineApiError(
        `Could not reach pipeline server at ${this.baseUrl}. Is it running?`
      );
    }

    if (!response.ok) {
      // Pre-stream errors (400/401/404/422/429) arrive as a normal JSON
      // error body, not an SSE stream.
      throw await buildApiError(response);
    }

    if (!response.body) {
      throw new PipelineApiError("Streaming response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
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
            throw errorFromBody(errBody, errBody.status, "Pipeline execution failed");
          }
          if (known.has(parsed.event)) {
            yield { event: parsed.event, data: JSON.parse(parsed.data) as unknown };
          }
        }
      }
    } catch (err) {
      // Re-throw a PipelineApiError (from the `error` event branch above)
      // unchanged; wrap anything else (a genuine network/parse failure
      // mid-stream) so every failure is consistently a PipelineApiError.
      if (err instanceof PipelineApiError) throw err;
      if (signal?.aborted) throw new RequestCancelledError();
      throw new PipelineApiError(
        `Stream reading failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      // A caller that stops reading early (breaks out of its loop) drops the
      // connection, so the server stops the run instead of finishing it.
      if (!finished) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
