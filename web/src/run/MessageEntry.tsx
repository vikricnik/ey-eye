import { useEffect, useRef } from "react";
import { describeUsage } from "@llm-pipeline/client";
import type { RunLogEntry } from "@llm-pipeline/client";
import { formatDuration } from "../format";

const STATUS_LABEL: Record<RunLogEntry["status"], string> = {
  running: "running",
  complete: "done",
  failed: "failed",
  stopped: "stopped",
};

/** A message block that stays scrolled to the newest text while it grows. */
function Block({ text, live }: { text: string; live?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [text, live]);
  return (
    <pre className={`message-text${live ? " live" : ""}`} ref={ref}>
      {text}
      {live && <span className="cursor" aria-hidden="true" />}
    </pre>
  );
}

/** What one node received (system prompt + rendered prompt) and what it
 * replied, for one execution in one run. */
export function MessageEntry(props: {
  entry: RunLogEntry;
  isOutput?: boolean;
  /** Shows the node id as a link (whole-run view) instead of plain text. */
  onSelectNode?: (nodeId: string) => void;
  showNodeId?: boolean;
  /** Offered on the latest run's entries: run it again from this node. */
  onRerun?: () => void;
}) {
  const { entry, onSelectNode } = props;
  const running = entry.status === "running";
  const usage = describeUsage(entry.usage);
  return (
    <article className={`message-entry status-${entry.status}`}>
      <header className="message-head">
        {props.showNodeId !== false &&
          (onSelectNode ? (
            <button type="button" className="link message-node" onClick={() => onSelectNode(entry.nodeId)}>
              {entry.nodeId}
            </button>
          ) : (
            <span className="message-node">{entry.nodeId}</span>
          ))}
        {props.isOutput && <span className="llm-node-output" title="output node">★</span>}
        <span className="dim">{entry.modelName}</span>
        {entry.iteration > 1 && (
          <span className="tag-mini" title="this node ran again because of a loop">
            iteration {entry.iteration}
          </span>
        )}
        {entry.attempt > 1 && <span className="tag-mini warn">retry {entry.attempt}</span>}
        {entry.replayed && (
          <span className="tag-mini" title="a re-run reused this output from the run before — no model call">
            reused
          </span>
        )}
        {props.onRerun && (
          <button type="button" className="link" onClick={props.onRerun} title="run the latest message again from this node">
            ↻ re-run from here
          </button>
        )}
        <span className={`status-pill status-${entry.status === "complete" ? "complete" : entry.status === "running" ? "running" : "failed"}`}>
          {running && <span className="pulse-dot" aria-hidden="true" />}
          {STATUS_LABEL[entry.status]}
          {entry.durationMs !== null ? ` · ${formatDuration(entry.durationMs)}` : ""}
        </span>
      </header>
      {usage?.summary && (
        <p className={`message-usage level-${usage.level ?? "ok"}`} title={usage.level === "near" ? (usage.warning ?? "") : undefined}>
          {usage.summary}
        </p>
      )}
      {usage?.level === "full" && <p className="problem error">{usage.warning}</p>}
      {entry.system && (
        <section className="message-part">
          <h4>system</h4>
          <Block text={entry.system} />
        </section>
      )}
      <section className="message-part">
        <h4>received</h4>
        {entry.prompt !== null ? (
          <Block text={entry.prompt} />
        ) : (
          <p className="dim">not reported by the server</p>
        )}
      </section>
      <section className="message-part">
        <h4>replied</h4>
        {running && !entry.output ? (
          <p className="dim">waiting for the first tokens…</p>
        ) : entry.status !== "complete" && !entry.output ? (
          <p className="dim">no reply</p>
        ) : (
          <Block text={entry.output} live={running} />
        )}
      </section>
    </article>
  );
}
