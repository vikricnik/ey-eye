import type { Turn } from "./Chat";

/** The folded Chat section's preview: the latest message and its answer. */
export interface LastExchange {
  prompt: string;
  /** The answer so far — or, for a stopped or failed run, what happened. */
  answer: string;
  state: "running" | "done" | "stopped" | "failed";
}

/** The latest exchange in the conversation, live while it streams
 * (`pendingAnswer` is the output node's text so far); null before any. */
export function lastExchange(turns: readonly Turn[], pendingAnswer: string | undefined): LastExchange | null {
  const last = turns.at(-1);
  if (!last) return null;
  switch (last.status) {
    case "running":
      return { prompt: last.prompt, answer: pendingAnswer ?? "", state: "running" };
    case "done":
      return { prompt: last.prompt, answer: last.result?.final_answer ?? "", state: "done" };
    case "stopped":
      return { prompt: last.prompt, answer: "stopped — nothing from this run was added", state: "stopped" };
    case "error":
      return { prompt: last.prompt, answer: `failed — ${last.error?.message ?? "the run failed"}`, state: "failed" };
  }
}
