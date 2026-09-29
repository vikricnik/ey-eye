import { useState } from "react";
import type { ProviderModels } from "@llm-pipeline/client";

type Health = "ok" | "down" | "unknown";

/** One health light with its name beside it — "offline" is spelled out,
 * so the state doesn't rest on the dot's color alone. */
function Indicator({ label, health, detail }: { label: string; health: Health; detail: string }) {
  return (
    <span className={`indicator ${health}`} title={detail}>
      <span className={`status-dot ${health === "ok" ? "online" : health === "down" ? "offline" : ""}`} aria-hidden="true" />
      {label}
      {health === "down" ? " offline" : <span className="visually-hidden">{health === "ok" ? " online" : " checking"}</span>}
    </span>
  );
}

/**
 * The header's health lights: the pipeline API, and Ollama — the one
 * model provider the server actually checks (cloud models come from an
 * allowlist). Both are re-checked every 15 s.
 */
export function ServerStatus(props: {
  baseUrl: string;
  online: boolean | null;
  /** Ollama as GET /v1/models last reported it; undefined until known. */
  ollama: ProviderModels | undefined;
  readOnly: boolean;
}) {
  const { baseUrl, online, ollama } = props;
  return (
    <div className="status" role="group" aria-label="Server status">
      <Indicator
        label="API"
        health={online === null ? "unknown" : online ? "ok" : "down"}
        detail={online === null ? `checking ${baseUrl}…` : online ? `${baseUrl} is reachable` : `can't reach ${baseUrl}`}
      />
      {ollama && (
        <Indicator
          label="Ollama"
          health={ollama.reachable ? "ok" : "down"}
          detail={ollama.reachable ? "Ollama is reachable" : (ollama.error ?? "Ollama isn't reachable")}
        />
      )}
      {props.readOnly && <span className="chip-status">read-only</span>}
    </div>
  );
}

/** A provider the open pipeline needs is down: says what that means for
 * it, with a way to check again right away instead of waiting for the
 * next poll. Goes away by itself once the provider is back. */
export function OutageNotice({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="notice warn" role="alert">
      <span>{message}</span>
      <button
        type="button"
        className="link"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          try {
            await onRetry();
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? "checking…" : "Retry"}
      </button>
    </div>
  );
}
