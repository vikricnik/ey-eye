import "./style.css";
import { PipelineClient, PipelineApiError } from "@llm-pipeline/client";
import { RelayAnimator } from "./relayAnimator";
import { renderTurn, renderError, beginStreamingTurn } from "./render";
import type { ConversationTurn } from "@llm-pipeline/client";

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
const relayContainer = requireElement<HTMLElement>("relay");
const pipelineSelect = requireElement<HTMLSelectElement>("pipeline-select");

const client = new PipelineClient(BASE_URL, API_KEY);
const relay = new RelayAnimator(relayContainer);

let isLoading = false;
let activePipelineName = "";
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
    relay.setStages(detail.nodes.map((n) => n.id));
  } catch {
    relay.setStages([]);
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

async function handleSendBuffered(prompt: string, startedAt: number): Promise<void> {
  relay.start();
  try {
    const response = await client.ask(prompt, activePipelineName, history);
    const elapsedMs = performance.now() - startedAt;
    relay.finish();
    renderTurn(transcript, prompt, response, verboseToggle.checked, elapsedMs);
    // Only the final answer is kept as context for the next turn —
    // intermediate node outputs aren't carried forward.
    history.push({ prompt, final_answer: response.final_answer });
  } catch (err) {
    relay.finish();
    renderCaughtError(prompt, err);
  }
}

/**
 * Streaming variant: drives the relay track from REAL node_complete events
 * (relay.markComplete()) instead of a simulated timer, AND renders each
 * node's output card the moment it arrives (via beginStreamingTurn) rather
 * than waiting for the whole pipeline to finish — the DOM equivalent of the
 * CLI's line-by-line streaming output.
 */
async function handleSendStreaming(prompt: string, startedAt: number): Promise<void> {
  relay.startReal();
  const turnHandle = beginStreamingTurn(transcript, prompt, verboseToggle.checked);

  try {
    for await (const event of client.askStream(prompt, activePipelineName, history)) {
      if (event.type === "node_complete") {
        relay.markComplete(event.data.node.node_id);
        turnHandle.addNodeOutput(event.data.node.node_id, event.data.node);
      } else if (event.type === "done") {
        const elapsedMs = performance.now() - startedAt;
        relay.finish();
        turnHandle.finish(event.data, elapsedMs);
        history.push({ prompt, final_answer: event.data.final_answer });
      }
      // loop_iteration events don't have a corresponding relay stage (loops
      // aren't part of the static node list the relay track is built from)
      // — nothing to update for those here.
    }
  } catch (err) {
    relay.finish();
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
