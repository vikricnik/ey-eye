import { MessageEntry } from "./MessageEntry";
import type { Turn } from "./Chat";

/**
 * One run's trace, inside its chat turn: each node in the order it started
 * — what it received and what it replied, streaming live. Clicking a node
 * name opens its settings; the latest run's nodes offer a re-run.
 */
export function RunTrace(props: {
  turn: Turn;
  outputNodeIds: ReadonlySet<string>;
  onSelectNode: (nodeId: string) => void;
  /** Set on the latest run only: the nodes it can be re-run from. */
  rerunnable?: ReadonlySet<string> | undefined;
  onRerun: (nodeId: string) => void;
}) {
  const { turn, rerunnable } = props;
  if (turn.log.length === 0) {
    return <p className="dim">{turn.status === "running" ? "starting…" : "no node ran"}</p>;
  }
  return (
    <div className="run-trace">
      {turn.log.map((entry) => (
        <MessageEntry
          key={entry.key}
          entry={entry}
          isOutput={props.outputNodeIds.has(entry.nodeId)}
          onSelectNode={props.onSelectNode}
          {...(rerunnable?.has(entry.nodeId) ? { onRerun: () => props.onRerun(entry.nodeId) } : {})}
        />
      ))}
    </div>
  );
}
