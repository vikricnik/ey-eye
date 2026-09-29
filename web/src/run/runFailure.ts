import type { ErrorCode } from "@llm-pipeline/client";
import { providerLabel } from "../providerStatus";

/** A failed run, as a Turn keeps it (and saves it with the conversation). */
export interface RunError {
  /** The server's message, as it sent it. */
  message: string;
  requestId?: string | undefined;
  /** Unset on runs saved before errors kept their code, and for failures
   * that never reached the server. */
  code?: ErrorCode | undefined;
}

/** What went wrong in plain words, and what to do about it. `hint` may
 * quote a command in backticks. */
export interface FailureExplanation {
  summary: string;
  hint: string;
}

// "Node 'x' failed: <provider>:<model> failed: <cause>" — a model call
// that failed (providers/base.py ProviderError, dag_builder/node_types.py).
const NODE_FAILED = /^Node '([^']+)' failed: ([\w-]+):(\S+) failed: ?([\s\S]*)$/;
const UNREACHABLE = /all connection attempts failed|failed to connect|connection refused|connecterror|name or service not known|nodename nor servname/i;
const MODEL_MISSING = /model "?([^"\s]+)"? not found/i;
const CIRCUIT_OPEN = /circuit open.*cooldown ([\d.]+)s/i;
const RUN_LIMIT = /limit of ([\d.]+)s/;

const seconds = (text: string) => `${Number(text)} s`;

/**
 * Explains the failures people can do something about — a model provider
 * out of reach, a missing Ollama model, a timeout, a limit — or null, and
 * the raw message is shown as it is.
 */
export function explainRunFailure(error: RunError): FailureExplanation | null {
  const { code, message } = error;

  const node = NODE_FAILED.exec(message);
  if (node) {
    const [nodeId, provider, model, cause] = [node[1]!, node[2]!, node[3]!, node[4]!];
    const label = providerLabel(provider);
    if (UNREACHABLE.test(cause)) {
      return {
        summary: `Node "${nodeId}" couldn't reach ${label}.`,
        hint:
          provider === "ollama"
            ? "Is Ollama running? Start it with `ollama serve`, then retry."
            : `Check that the pipeline server can reach ${label}, then retry.`,
      };
    }
    const missing = MODEL_MISSING.exec(cause);
    if (missing && provider === "ollama") {
      return {
        summary: `Ollama doesn't have the model "${missing[1]}" that node "${nodeId}" uses.`,
        hint: `Install it with \`ollama pull ${missing[1]}\`, or pick another model in the node's settings.`,
      };
    }
    // asyncio's TimeoutError has no message of its own.
    if (cause.trim() === "") {
      return {
        summary: `Node "${nodeId}" got no answer from ${provider}:${model} in time.`,
        hint: "Raise the per-call timeout under Execution in the pipeline's settings (click empty canvas), or retry.",
      };
    }
    const circuit = CIRCUIT_OPEN.exec(cause);
    if (circuit) {
      return {
        summary: `The server is pausing calls to ${provider}:${model} after several failures in a row (node "${nodeId}").`,
        hint: `Fix what made it fail, then retry after the ${seconds(circuit[1]!)} cooldown.`,
      };
    }
    return null;
  }

  if (message.includes("none of its output_nodes")) {
    return {
      summary: "The run finished, but none of its output nodes ran.",
      hint: "Every route a branch can take must end at an output node: tick “output node” in that node's settings.",
    };
  }

  switch (code) {
    case "RUN_TIMED_OUT": {
      const limit = RUN_LIMIT.exec(message);
      return {
        summary: limit ? `The run took longer than its ${seconds(limit[1]!)} limit.` : "The run took longer than its time limit.",
        hint: "Raise the run time limit under Execution in the pipeline's settings (click empty canvas), or retry.",
      };
    }
    case "RATE_LIMITED":
      return { summary: "The server is limiting requests right now.", hint: "Wait a moment, then retry." };
    case "UNAUTHENTICATED":
      return {
        summary: "The server didn't accept this client's API key.",
        hint: "Set `PIPELINE_API_KEY` in runtime-config.js to a key the server allows (see the web README).",
      };
    case "INPUT_TOO_LARGE":
      return {
        summary: "The message, with the conversation before it, is more than the server accepts.",
        hint: "Start a new conversation (+ new), or send a shorter message.",
      };
    case "INTERNAL_ERROR":
      return {
        summary: "The server ran into an unexpected error.",
        hint: "Retry. If it keeps happening, report it with the reference id below.",
      };
    default:
      return null;
  }
}
