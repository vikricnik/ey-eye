import "./style.css";
import {
  PipelineClient,
  PipelineApiError,
  buildGraphModel,
  createGraphViewState,
  applyStreamEvent,
  applyStreamError,
} from "@llm-pipeline/client";
import { renderTurn, renderError, beginStreamingTurn } from "./render";
import {
  renderGraphSvg,
  renderGraphErrorMarker,
  applyGraphViewState,
  enableDragPan,
} from "./graphView";
import type { ConversationTurn, GraphModel, GraphViewState } from "@llm-pipeline/client";

declare global {
  interface Window {
    PIPELINE_BASE_URL?: string;
    PIPELINE_API_KEY?: string;
  }
}

const BASE_URL: string = window.PIPELINE_BASE_URL ?? "http://localhost:8000";
const API_KEY: string | undefined = window.PIPELINE_API_KEY; // only needed if the server has API_KEYS configured

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Required element #${id} not found in DOM`);
  }
  return el as T;
}

const transcript = requireElement<HTMLElement>("transcript");
const emptyState = requireElement<HTMLElement>("empty-state");
const input = requireElement<HTMLTextAreaElement>("prompt-input");
const sendBtn = requireElement<HTMLButtonElement>("send-btn");
const verboseToggle = requireElement<HTMLInputElement>("verbose-toggle");
const streamToggle = requireElement<HTMLInputElement>("stream-toggle");
const resetBtn = requireElement<HTMLButtonElement>("reset-btn");
const statusDot = requireElement<HTMLElement>("status-dot");
const statusText = requireElement<HTMLElement>("status-text");
const serverUrlLabel = requireElement<HTMLElement>("server-url");
const pipelineSelect = requireElement<HTMLSelectElement>("pipeline-select");
const graphContainer = requireElement<HTMLElement>("graph-container");

const client = new PipelineClient(BASE_URL, API_KEY);
enableDragPan(graphContainer);

let isLoading = false;
let activePipelineName = "";
let activeGraph: GraphModel | undefined;
let graphViewState: GraphViewState | undefined;
// Conversation memory for this session — only the final answer from each
// turn is kept as context for the next request; cleared whenever the
// active pipeline changes, since a different DAG likely has different
// context semantics.
const history: ConversationTurn[] = [];

serverUrlLabel.textContent = BASE_URL;

// ---------- pipeline discovery ----------
async function loadPipelineOptions(): Promise<void> {
  try {
    const { pipelines } = await client.listPipelines();
    pipelineSelect.innerHTML = "";

    if (pipelines.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "no pipelines found";
      pipelineSelect.appendChild(opt);
      return;
    }

    for (const p of pipelines) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      opt.title = p.description;
      pipelineSelect.appendChild(opt);
    }

    const health = await client.checkHealth();
    const defaultName = pipelines.some((p) => p.name === health.default_pipeline_name)
      ? health.default_pipeline_name
      : pipelines[0]!.name;

    pipelineSelect.value = defaultName;
    await switchToPipeline(defaultName, { clearHistory: false });
  } catch {
    pipelineSelect.innerHTML = '<option value="">server unreachable</option>';
  }
}

async function switchToPipeline(name: string, opts: { clearHistory: boolean }): Promise<void> {
  activePipelineName = name;
  if (opts.clearHistory) {
    history.length = 0;
  }

  try {
    const detail = await client.getPipelineDetail(name);
    activeGraph = buildGraphModel(detail);
    // FR-013: a fresh, all-not-started view state every time the pipeline
    // changes — no in-flight or completed run's status leaks onto it.
    graphViewState = createGraphViewState(activeGraph);
    graphContainer.innerHTML = "";
    graphContainer.appendChild(renderGraphSvg(activeGraph));
  } catch (err) {
    activeGraph = undefined;
    graphViewState = undefined;
    const message =
      err instanceof PipelineApiError || err instanceof Error ? err.message : String(err);
    graphContainer.innerHTML = "";
    graphContainer.appendChild(renderGraphErrorMarker(`couldn't load pipeline structure: ${message}`));
  }
}

pipelineSelect.addEventListener("change", () => {
  void switchToPipeline(pipelineSelect.value, { clearHistory: true });
});

void loadPipelineOptions();

// ---------- health check ----------
// A self-scheduling async loop instead of setInterval: if a health check is
// slow (e.g. the server is under load), setInterval would let requests pile
// up concurrently. Awaiting delay() after each check guarantees the next
// check only starts once the previous one has fully finished.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function checkHealth(): Promise<void> {
  try {
    const health = await client.checkHealth();
    statusDot.className = "status-dot online";
    statusText.textContent = `online · ${health.available_pipelines.length} pipeline(s) available`;
  } catch {
    statusDot.className = "status-dot offline";
    statusText.textContent = "offline — is the server running?";
  }
}

async function pollHealthForever(): Promise<void> {
  while (true) {
    await checkHealth();
    await delay(15000);
  }
}

void pollHealthForever();

// ---------- textarea auto-grow ----------
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

// Note: DOM event listeners can't be awaited by their caller (the browser
// fires them and moves on regardless), so declaring the listener itself
// `async` and letting it run to completion internally is the idiomatic
// async/await equivalent of a synchronous handler here.
input.addEventListener("keydown", async (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    await handleSend();
  }
});

sendBtn.addEventListener("click", async () => {
  await handleSend();
});

// ---------- reset conversation ----------
resetBtn.addEventListener("click", () => {
  history.length = 0;
  transcript.innerHTML = "";
  transcript.appendChild(emptyState);
  emptyState.style.display = "block";
});

// ---------- send flow ----------
async function handleSend(): Promise<void> {
  const prompt = input.value.trim();
  if (!prompt || isLoading || !activePipelineName) return;

  input.value = "";
  input.style.height = "auto";
  isLoading = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("loading");
  emptyState.style.display = "none";

  const startedAt = performance.now();

  try {
    if (streamToggle.checked) {
      await handleSendStreaming(prompt, startedAt);
    } else {
      await handleSendBuffered(prompt, startedAt);
    }
  } finally {
    isLoading = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove("loading");
    input.focus();
  }
}

/** Wraps any caught value into a PipelineApiError so applyStreamError()
 * always has a `.message`/`.details` to read, regardless of what the
 * underlying failure actually was. */
function toApiError(err: unknown): PipelineApiError {
  if (err instanceof PipelineApiError) return err;
  return new PipelineApiError(err instanceof Error ? err.message : String(err));
}

/** Starts a fresh, "running" live view state for the active graph — every
 * root node immediately eligible, since it starts executing the instant
 * the request is sent (FR-013's per-run reset). No-op if the pipeline's
 * structure never loaded. */
function beginRun(): void {
  if (!activeGraph) return;
  graphViewState = createGraphViewState(activeGraph, { running: true });
  applyGraphViewState(graphContainer, graphViewState);
}

async function handleSendBuffered(prompt: string, startedAt: number): Promise<void> {
  beginRun();
  try {
    const response = await client.ask(prompt, activePipelineName, history);
    const elapsedMs = performance.now() - startedAt;
    // /ask has no per-node events to stream live — but once the response
    // arrives, folding each node's completion (and every loop's final
    // iteration count) through the same applyStreamEvent() used by
    // streaming gets the graph to the correct FINAL state (route taken,
    // loop counts, every node complete) rather than leaving it stuck
    // showing "running" forever.
    if (graphViewState) {
      for (const node of Object.values(response.node_outputs)) {
        graphViewState = applyStreamEvent(graphViewState, { type: "node_complete", data: { node } });
      }
      for (const [loopId, iteration] of Object.entries(response.loop_iterations)) {
        graphViewState = applyStreamEvent(graphViewState, {
          type: "loop_iteration",
          data: { loop_id: loopId, iteration },
        });
      }
      applyGraphViewState(graphContainer, graphViewState);
    }
    renderTurn(transcript, prompt, response, verboseToggle.checked, elapsedMs);
    // Only the final answer is kept as context for the next turn —
    // intermediate node outputs aren't carried forward.
    history.push({ prompt, final_answer: response.final_answer });
  } catch (err) {
    if (graphViewState) {
      graphViewState = applyStreamError(graphViewState, toApiError(err));
      applyGraphViewState(graphContainer, graphViewState);
    }
    renderCaughtError(prompt, err);
  }
}

/**
 * Streaming variant: renders each node's output card the moment it
 * arrives (via beginStreamingTurn) rather than waiting for the whole
 * pipeline to finish — the DOM equivalent of the CLI's line-by-line
 * streaming output. Also drives the live graph view (FR-009–FR-012):
 * every event is folded through applyStreamEvent() and immediately
 * re-applied to the diagram.
 */
async function handleSendStreaming(prompt: string, startedAt: number): Promise<void> {
  const turnHandle = beginStreamingTurn(transcript, prompt, verboseToggle.checked);
  beginRun();

  try {
    for await (const event of client.askStream(prompt, activePipelineName, history)) {
      if (graphViewState) {
        graphViewState = applyStreamEvent(graphViewState, event);
        applyGraphViewState(graphContainer, graphViewState);
      }
      if (event.type === "node_complete") {
        turnHandle.addNodeOutput(event.data.node.node_id, event.data.node);
      } else if (event.type === "done") {
        const elapsedMs = performance.now() - startedAt;
        turnHandle.finish(event.data, elapsedMs);
        history.push({ prompt, final_answer: event.data.final_answer });
      }
    }
  } catch (err) {
    if (graphViewState) {
      graphViewState = applyStreamError(graphViewState, toApiError(err));
      applyGraphViewState(graphContainer, graphViewState);
    }
    renderCaughtError(prompt, err);
  }
}

function renderCaughtError(prompt: string, err: unknown): void {
  const message =
    err instanceof PipelineApiError || err instanceof Error ? err.message : String(err);
  const exceptionUID = err instanceof PipelineApiError ? err.exceptionUID : undefined;
  renderError(transcript, prompt, message, exceptionUID);
}

input.focus();
