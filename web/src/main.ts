import "./style.css";
import { PipelineClient, PipelineApiError } from "./apiClient";
import { RelayAnimator } from "./relayAnimator";
import { renderTurn, renderError } from "./render";
import type { ConversationTurn } from "./types";

declare global {
  interface Window {
    PIPELINE_BASE_URL?: string;
  }
}

const BASE_URL: string = window.PIPELINE_BASE_URL ?? "http://localhost:8000";

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
const resetBtn = requireElement<HTMLButtonElement>("reset-btn");
const statusDot = requireElement<HTMLElement>("status-dot");
const statusText = requireElement<HTMLElement>("status-text");
const serverUrlLabel = requireElement<HTMLElement>("server-url");
const relayContainer = requireElement<HTMLElement>("relay");

const client = new PipelineClient(BASE_URL);
const relay = new RelayAnimator(relayContainer);

let isLoading = false;
// Conversation memory for this session — only the winning answer from each
// turn is kept as context for the next request (losing candidates are dropped).
const history: ConversationTurn[] = [];

serverUrlLabel.textContent = BASE_URL;

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
    statusText.textContent = `online · ${health.execution_mode} / ${health.validation_mode}`;
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
// async/await equivalent of a synchronous handler here — there's no `void`
// trick needed since we're not calling out to a separate async function.
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
// No async work here (just DOM/array mutation), so this stays a plain
// synchronous handler — forcing async/await where there's nothing to await
// would be noise, not clarity.
resetBtn.addEventListener("click", () => {
  history.length = 0;
  transcript.innerHTML = "";
  transcript.appendChild(emptyState);
  emptyState.style.display = "block";
});

// ---------- send flow ----------
async function handleSend(): Promise<void> {
  const prompt = input.value.trim();
  if (!prompt || isLoading) return;

  input.value = "";
  input.style.height = "auto";
  isLoading = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("loading");
  emptyState.style.display = "none";
  relay.start();

  try {
    const response = await client.ask(prompt, history);
    relay.finish();
    renderTurn(transcript, prompt, response, verboseToggle.checked);
    // Only the winning answer is kept as context for the next turn.
    history.push({ prompt, final_answer: response.final_answer });
  } catch (err) {
    relay.finish();
    const message = err instanceof PipelineApiError || err instanceof Error
      ? err.message
      : String(err);
    renderError(transcript, prompt, message);
  } finally {
    isLoading = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove("loading");
    input.focus();
  }
}

input.focus();
