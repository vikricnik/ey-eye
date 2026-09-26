import type { AskStreamEvent, NodeUsage } from "./types.js";

export type RunLogStatus = "running" | "complete" | "failed" | "stopped";

/**
 * One execution of one node within a run: the messages it received and the
 * reply it produced. A node re-run by a loop gets one entry per run; a
 * retry after a failed model call updates the same entry (attempt 2+).
 */
export interface RunLogEntry {
  /** Unique within a run: `${nodeId}#${iteration}`. */
  key: string;
  nodeId: string;
  /** 1 for the node's first execution in this run, 2+ for loop re-runs. */
  iteration: number;
  attempt: number;
  modelName: string;
  system: string | null;
  prompt: string | null;
  /** The reply so far while running; the full reply once complete. */
  output: string;
  status: RunLogStatus;
  durationMs: number | null;
  /** Tokens and context, once complete — null when not reported. */
  usage: NodeUsage | null;
  /** A re-run reused this node's previous output instead of calling it. */
  replayed: boolean;
}

function latestIndex(log: RunLogEntry[], nodeId: string): number {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.nodeId === nodeId) return i;
  }
  return -1;
}

function replaceAt(log: RunLogEntry[], index: number, entry: RunLogEntry): RunLogEntry[] {
  const next = log.slice();
  next[index] = entry;
  return next;
}

/**
 * Folds one stream event into a run's message log, in start order. Pure:
 * returns a new array when something changed, the same one otherwise.
 * `node_start` opens an entry (or, for a retry, resets the node's current
 * one), `node_token` appends to the running entry's reply, `node_complete`
 * settles it with the authoritative output and duration.
 */
export function appendRunLog(log: RunLogEntry[], event: AskStreamEvent): RunLogEntry[] {
  if (event.type === "node_start") {
    const { node_id, model_name, attempt = 1, prompt = null, system = null } = event.data;
    const index = latestIndex(log, node_id);
    if (attempt > 1 && index >= 0 && log[index]!.status === "running") {
      return replaceAt(log, index, { ...log[index]!, attempt, output: "", prompt, system });
    }
    const iteration = log.filter((e) => e.nodeId === node_id).length + 1;
    return [
      ...log,
      {
        key: `${node_id}#${iteration}`,
        nodeId: node_id,
        iteration,
        attempt,
        modelName: model_name,
        system,
        prompt,
        output: "",
        status: "running",
        durationMs: null,
        usage: null,
        replayed: event.data.replayed === true,
      },
    ];
  }

  if (event.type === "node_token") {
    const index = latestIndex(log, event.data.node_id);
    if (index < 0 || log[index]!.status !== "running") return log;
    const entry = log[index]!;
    return replaceAt(log, index, { ...entry, output: entry.output + event.data.text });
  }

  if (event.type === "node_complete") {
    const { node_id, output, duration_ms, model_name } = event.data.node;
    const usage = event.data.node.usage ?? null;
    const index = latestIndex(log, node_id);
    if (index < 0 || log[index]!.status !== "running") {
      // No node_start seen (e.g. an older server): still record the reply.
      const iteration = log.filter((e) => e.nodeId === node_id).length + 1;
      return [
        ...log,
        {
          key: `${node_id}#${iteration}`,
          nodeId: node_id,
          iteration,
          attempt: 1,
          modelName: model_name,
          system: null,
          prompt: null,
          output,
          status: "complete",
          durationMs: duration_ms,
          usage,
          replayed: event.data.node.replayed === true,
        },
      ];
    }
    return replaceAt(log, index, {
      ...log[index]!,
      output,
      status: "complete",
      durationMs: duration_ms,
      usage,
      replayed: log[index]!.replayed || event.data.node.replayed === true,
    });
  }

  return log;
}

/**
 * Closes a run that ended with an error: the node the error names (if any)
 * is marked failed, anything else still running is marked stopped.
 */
export function endRunLog(log: RunLogEntry[], failedNodeId?: string): RunLogEntry[] {
  if (!log.some((e) => e.status === "running")) return log;
  return log.map((e) =>
    e.status !== "running" ? e : { ...e, status: e.nodeId === failedNodeId ? "failed" : "stopped" }
  );
}

/** The text each node is generating right now, from the latest entries. */
export function liveTextOf(log: RunLogEntry[]): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const entry of log) {
    if (entry.status === "running") texts[entry.nodeId] = entry.output;
  }
  return texts;
}
