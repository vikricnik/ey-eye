import type { LastExchange } from "./lastExchange";

/** Folded Chat's preview: the latest message and the start of its answer,
 * live while it streams. Clicking it opens Chat. */
export function ChatPreview({ exchange, onOpen }: { exchange: LastExchange | null; onOpen: () => void }) {
  if (!exchange) return null;
  const answer = exchange.answer || (exchange.state === "running" ? "waiting for the answer…" : "");
  return (
    <button type="button" className="chat-preview" title="Open Chat" onClick={onOpen}>
      <span className="chat-preview-q">
        <span className="marker" aria-hidden="true">
          ›
        </span>{" "}
        {exchange.prompt}
      </span>
      {answer && <span className={`chat-preview-a ${exchange.state}`}>{answer}</span>}
    </button>
  );
}
