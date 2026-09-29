import { MessageEntry } from "../run/MessageEntry";
import type { Turn } from "../run/Chat";

/** What this node received and replied in each run of the session, newest
 * first — including loop re-runs, and live while it runs. The Trace
 * section of the node's settings. */
export function NodeTrace({ nodeId, turns, isOutput }: { nodeId: string; turns: Turn[]; isOutput: boolean }) {
  const runs = turns
    .map((turn, index) => ({ turn, index, entries: turn.log.filter((e) => e.nodeId === nodeId) }))
    .filter((r) => r.entries.length > 0)
    .reverse();
  if (runs.length === 0) {
    return (
      <p className="dim">
        <b>{nodeId}</b> hasn&apos;t run in this session yet. Send a message in Chat — what it receives and replies
        shows up here, live.
      </p>
    );
  }
  return (
    <div className="node-messages">
      {runs.map(({ turn, index, entries }) => (
        <section key={turn.id} className="node-messages-run">
          <h3>
            run {index + 1} <span className="dim">› {turn.prompt}</span>
          </h3>
          {entries
            .slice()
            .reverse()
            .map((entry) => (
              <MessageEntry key={entry.key} entry={entry} isOutput={isOutput} showNodeId={false} />
            ))}
        </section>
      ))}
    </div>
  );
}
