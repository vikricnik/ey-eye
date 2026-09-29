import type { RunLogEntry } from "@llm-pipeline/client";
import { formatDuration } from "../format";

type TraceEntry = Pick<RunLogEntry, "nodeId" | "status" | "durationMs">;

/** The folded Trace section's line for one node: its latest run in this
 * session — "run 3 · 1.8s", "run 3 · live" while it runs — or that it
 * hasn't run. `turns` are the session's runs, oldest first; within a run
 * the node's last execution (a loop's final pass) is the one described. */
export function nodeTraceSummary(nodeId: string, turns: readonly { log: readonly TraceEntry[] }[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const last = turns[i]!.log.filter((entry) => entry.nodeId === nodeId).at(-1);
    if (!last) continue;
    const run = `run ${i + 1}`;
    if (last.status === "running") return `${run} · live`;
    if (last.status === "failed" || last.status === "stopped") return `${run} · ${last.status}`;
    return last.durationMs !== null ? `${run} · ${formatDuration(last.durationMs)}` : run;
  }
  return "hasn't run yet";
}
