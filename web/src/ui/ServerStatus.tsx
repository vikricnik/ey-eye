import { useState } from "react";
import type { ProviderModels } from "@llm-pipeline/client";

type Health = "ok" | "down" | "unknown";

/** One health light. Beside its name, "offline" is spelled out, so the
 * state doesn't rest on the dot's color alone; compact (in the panel
 * header), it's just the dot — the name and state are its tooltip and
 * read by screen readers. */
function Indicator({ label, health, detail, compact }: { label: string; health: Health; detail: string; compact: boolean }) {
  const state = health === "ok" ? "online" : health === "down" ? "offline" : "checking";
  return (
    <span className={`indicator ${health}`} title={compact ? `${label} · ${detail}` : detail}>
      <span className={`status-dot ${health === "ok" ? "online" : health === "down" ? "offline" : ""}`} aria-hidden="true" />
      {compact ? (
        <span className="visually-hidden">{`${label} ${state}`}</span>
      ) : (
        <>
          {label}
          {health === "down" ? " offline" : <span className="visually-hidden">{` ${state}`}</span>}
        </>
      )}
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
  /** Dots only (the panel header). */
  compact?: boolean;
}) {
  const { baseUrl, online, ollama } = props;
  const compact = props.compact ?? false;
  return (
    <div className="status" role="group" aria-label="Server status">
      <Indicator
        compact={compact}
        label="API"
        health={online === null ? "unknown" : online ? "ok" : "down"}
        detail={online === null ? `checking ${baseUrl}…` : online ? `${baseUrl} is reachable` : `can't reach ${baseUrl}`}
      />
      {ollama && (
        <Indicator
        compact={compact}
          label="Ollama"
          health={ollama.reachable ? "ok" : "down"}
          detail={ollama.reachable ? "Ollama is reachable" : (ollama.error ?? "Ollama isn't reachable")}
        />
      )}
      {props.readOnly && !compact && <span className="chip-status">read-only</span>}
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
