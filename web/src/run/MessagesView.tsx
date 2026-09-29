import { useEffect, useRef } from "react";
import { MessageEntry } from "./MessageEntry";
import { RunErrorView } from "./RunErrorView";
import type { Turn } from "./Chat";

/**
 * The Trace tab — every run's message log: for every run in this session, each node in
 * the order it started — what it received and what it replied, streaming
 * live. Clicking a node name opens its settings.
 */
export function MessagesView(props: {
  turns: Turn[];
  outputNodeIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
  /** Nodes the latest run can be re-run from (empty while running). */
  rerunnable: Set<string>;
  onRerun: (nodeId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [props.turns]);

  return (
    <div
      className="messages-view"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Follow new messages only while the user is at the bottom.
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {props.turns.length === 0 ? (
        <div className="empty-state">
          No runs yet. Send a message below — what every node received and replied appears here as the
          pipeline runs.
        </div>
      ) : (
        props.turns.map((turn, i) => (
          <section className="messages-run" key={turn.id}>
            <header className="messages-run-head">
              <span className="marker">{turn.rerunFrom ? "↻" : "›"}</span>
              <span className="messages-run-prompt">{turn.prompt}</span>
              {turn.rerunFrom && <span className="tag-mini">re-run from {turn.rerunFrom}</span>}
              <span className="dim">
                run {i + 1}
                {turn.elapsedMs !== undefined ? ` · ${(turn.elapsedMs / 1000).toFixed(1)}s` : ""}
                {turn.status === "running"
                  ? " · running"
                  : turn.status === "error"
                    ? " · failed"
                    : turn.status === "stopped"
                      ? " · stopped"
                      : ""}
              </span>
            </header>
            {turn.log.length === 0 && turn.status === "running" && <p className="dim">starting…</p>}
            {turn.log.map((entry) => (
              <MessageEntry
                key={entry.key}
                entry={entry}
                isOutput={props.outputNodeIds.has(entry.nodeId)}
                onSelectNode={props.onSelectNode}
                {...(i === props.turns.length - 1 && props.rerunnable.has(entry.nodeId)
                  ? { onRerun: () => props.onRerun(entry.nodeId) }
                  : {})}
              />
            ))}
            {turn.error && <RunErrorView error={turn.error} />}
          </section>
        ))
      )}
    </div>
  );
}
