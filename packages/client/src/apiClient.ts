import type {
  ErrorResponse,
  DeletedResponse,
  ErrorCode,
  AskInput,
  RequestOptions,
  AskStreamEvent,
  HealthResponse,
  ServerInfoResponse,
  ModelLimitsResponse,
  ModelsResponse,
  NodePreset,
  PipelineDefinition,
  PipelineDefinitionResponse,
  PipelinesListResponse,
  PresetResponse,
  PreviewPromptRequest,
  PreviewPromptResponse,
  RunRequest,
  RunResponse,
  RunTestsRequest,
  SavePipelineRequest,
  SavePresetRequest,
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


/** What the server reported about a failure — see ErrorResponse. */
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

/** The server couldn't be reached at all — not running, a wrong URL, the
 * network down — so there's no response, status or code. A PipelineApiError,
 * so code that handles every failure still catches it. */
export class ServerUnreachableError extends PipelineApiError {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    super(`Could not reach pipeline server at ${baseUrl}. Is it running?`);
    this.name = "ServerUnreachableError";
    this.baseUrl = baseUrl;
  }
}

/** The error an ErrorResponse body describes — a failed request's, or a
 * stream's `error` event, so both carry the same fields. */
function errorFromBody(
  body: Partial<ErrorResponse>,
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
    const body = (await response.json()) as Partial<ErrorResponse>;
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

/** A write that goes ahead only if the resource is still at `revision` —
 * the server's revisions are its ETags. */
function ifMatch(revision: string): Record<string, string> {
  return { "If-Match": `"${revision}"` };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface SendOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

function pipelinePath(name: string): string {
  return `/pipelines/${encodeURIComponent(name)}`;
}

/** Where a pipeline's runs are started (answered or streamed, by Accept). */
function runsPath(pipelineName: string): string {
  return `${pipelinePath(pipelineName)}/runs`;
}

/** The run's request body, field by field — the pipeline goes in the path,
 * and nothing else a caller's object carries is sent. */
function runRequest(input: AskInput): RunRequest {
  return {
    prompt: input.prompt,
    history: input.history ?? [],
    ...(input.rerun ? { rerun: input.rerun } : {}),
  };
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

  /** fetch() against the server, with the API key. A network failure is
   * thrown as ServerUnreachableError (RequestCancelledError if `signal`
   * fired), an error response as the PipelineApiError it describes. */
  private async send(method: Method, path: string, options: SendOptions = {}): Promise<Response> {
    const { body, headers = {}, signal } = options;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
          ...this.authHeaders(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new RequestCancelledError();
      throw new ServerUnreachableError(this.baseUrl);
    }
    // A 401 almost always means the server has API_KEYS configured but this
    // client's apiKey wasn't set (or is wrong).
    if (!response.ok) throw await buildApiError(response);
    return response;
  }

  private async request<T>(method: Method, path: string, options: SendOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    try {
      return (await response.json()) as T;
    } catch (err) {
      if (options.signal?.aborted) throw new RequestCancelledError();
      throw err;
    }
  }

  /** Whether the server is up — the open endpoint load balancers probe. */
  async checkHealth(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  /** What a client needs to start: the default pipeline, and whether this
   * server allows editing (and if not, why). */
  async getServerInfo(): Promise<ServerInfoResponse> {
    return this.get<ServerInfoResponse>("/server-info");
  }

  async listPipelines(): Promise<PipelinesListResponse> {
    return this.get<PipelinesListResponse>("/pipelines");
  }

  /** A pipeline as stored: its complete definition (prompts, options,
   * layout) and the revision to pass back to updatePipeline() — the same
   * representation a save takes. To draw it, derive the structure with
   * detailFromDefinition(). */
  async getPipeline(name: string): Promise<PipelineDefinitionResponse> {
    return this.get<PipelineDefinitionResponse>(`/pipelines/${encodeURIComponent(name)}`);
  }

  // ---- editing ---------------------------------------------------------

  /** Models this server lets an editor select (installed Ollama models +
   * the cloud allowlist). `refresh` bypasses the server's short cache. */
  async listModels(options: { refresh?: boolean } = {}): Promise<ModelsResponse> {
    return this.get<ModelsResponse>(options.refresh ? "/models?refresh=true" : "/models");
  }

  /** Max context, size and quantization of an installed Ollama model.
   * Throws (404) when it isn't installed or Ollama can't be reached. */
  async getModelLimits(ollamaModel: string): Promise<ModelLimitsResponse> {
    const path = ollamaModel.split("/").map(encodeURIComponent).join("/");
    return this.get<ModelLimitsResponse>(`/models/ollama/${path}`);
  }

  /** Validates without saving. Pass a definition (live validation, export
   * — the result's `yaml` is the canonical file text) or YAML text
   * (import — the result's `definition` is the parsed pipeline). Throws a
   * PipelineApiError (status 422, `details.node_id` when a node is at
   * fault) if it's invalid. */
  async validatePipeline(
    input: { definition: PipelineDefinition } | { yaml: string }
  ): Promise<ValidatePipelineResponse> {
    return this.request<ValidatePipelineResponse>("POST", "/drafts/validation", { body: input });
  }

  /** What a node would receive — see PreviewPromptRequest. */
  async previewPrompt(req: PreviewPromptRequest): Promise<PreviewPromptResponse> {
    return this.request<PreviewPromptResponse>("POST", "/drafts/prompt-preview", { body: req });
  }

  /** Saves a new pipeline (If-None-Match: *). Throws ALREADY_EXISTS (412)
   * if the name is taken, EDITING_DISABLED (403) if writes are off. */
  async createPipeline(definition: PipelineDefinition): Promise<SavePipelineResponse> {
    const body: SavePipelineRequest = { definition };
    return this.request<SavePipelineResponse>("PUT", pipelinePath(definition.name), {
      body,
      headers: { "If-None-Match": "*" },
    });
  }

  /** Saves over the pipeline loaded at `baseRevision` (If-Match). Throws
   * REVISION_CONFLICT (412) if it changed since, EDITING_DISABLED (403) if
   * writes are off. */
  async updatePipeline(
    definition: PipelineDefinition,
    options: { baseRevision: string }
  ): Promise<SavePipelineResponse> {
    const body: SavePipelineRequest = { definition };
    return this.request<SavePipelineResponse>("PUT", pipelinePath(definition.name), {
      body,
      headers: ifMatch(options.baseRevision),
    });
  }

  async listPresets(): Promise<PresetsListResponse> {
    return this.get<PresetsListResponse>("/presets");
  }

  async getPreset(name: string): Promise<PresetResponse> {
    return this.get<PresetResponse>(`/presets/${encodeURIComponent(name)}`);
  }

  /** Soft-deletes a pipeline (moved to pipelines/.deleted/). With
   * `baseRevision`, refused (REVISION_CONFLICT) if it changed since it was
   * loaded; the server's default pipeline can't be deleted
   * (PIPELINE_PROTECTED). */
  async deletePipeline(name: string, baseRevision?: string): Promise<DeletedResponse> {
    return this.request<DeletedResponse>("DELETE", pipelinePath(name), {
      headers: baseRevision === undefined ? {} : ifMatch(baseRevision),
    });
  }

  /** Soft-deletes a preset (moved to presets/.deleted/). With
   * `baseRevision`, refused (REVISION_CONFLICT) if it changed since. */
  async deletePreset(name: string, baseRevision?: string): Promise<DeletedResponse> {
    return this.request<DeletedResponse>("DELETE", `/presets/${encodeURIComponent(name)}`, {
      headers: baseRevision === undefined ? {} : ifMatch(baseRevision),
    });
  }

  /** Creates or replaces a preset — last write wins, unless you pass the
   * `baseRevision` you loaded (REVISION_CONFLICT if it changed since). */
  async savePreset(preset: NodePreset, baseRevision?: string): Promise<PresetResponse> {
    const body: SavePresetRequest = { preset };
    return this.request<PresetResponse>("PUT", `/presets/${encodeURIComponent(preset.name)}`, {
      body,
      headers: baseRevision === undefined ? {} : ifMatch(baseRevision),
    });
  }

  /** Runs a pipeline and resolves with the finished run. */
  async ask(input: AskInput, options: RequestOptions = {}): Promise<RunResponse> {
    return this.request<RunResponse>("POST", runsPath(input.pipeline), {
      body: runRequest(input),
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  }

  /**
   * Streaming variant of ask() — the same run, requested with
   * `Accept: text/event-stream`: yields node_start as each node begins,
   * node_token as its model generates text, and node_complete as it
   * finishes (see the server's routers/runs.py). The browser's native
   * EventSource only supports GET requests, so this parses Server-Sent
   * Events manually from fetch()'s streaming response body instead — works
   * identically in Node.js (CLI) and browsers (web client).
   *
   * Throws PipelineApiError for both pre-stream failures (auth, rate
   * limit, pipeline not found — same as ask()) AND mid-stream execution
   * failures (the server sends an `error` SSE event in that case, which
   * this method converts into a thrown error rather than yielding it as a
   * normal event — see AskStreamEvent's doc comment for why).
   */
  async *askStream(
    input: AskInput,
    options: RequestOptions = {}
  ): AsyncGenerator<AskStreamEvent, void, undefined> {
    const stream = this.postStream(runsPath(input.pipeline), runRequest(input), ASK_EVENTS, options.signal);
    for await (const { event, data } of stream) {
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
    for await (const { event, data } of this.postStream("/drafts/test-runs", req, TEST_EVENTS, options.signal)) {
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
    // Pre-stream errors (400/401/404/422/429) arrive as a normal JSON error
    // body, not an SSE stream — send() throws them.
    const response = await this.send("POST", path, {
      body,
      headers: { Accept: "text/event-stream" },
      signal,
    });

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
            const errBody = JSON.parse(parsed.data) as Partial<ErrorResponse>;
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
