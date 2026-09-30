import { modelIdentity } from "@llm-pipeline/client";
import type { ExecutionConfig, HistoryConfig, NodeDefaults } from "@llm-pipeline/client";

// One line per pipeline settings section, shown while it's folded (see
// Section and PipelineInspector): what's inside, without opening it.

/** "1 retry", "2 retries". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Which node answers — several are candidates in priority order. */
export function outputSummary(outputNodes: readonly string[]): string {
  return outputNodes.length === 1 ? `answer from ${outputNodes[0]}` : `${outputNodes.join(", ")} — first that ran`;
}

/** Only what's set, in the order the fields appear; nothing set means the
 * server's own defaults apply. */
export function executionSummary(execution: ExecutionConfig | undefined): string {
  const e = execution ?? {};
  const parts = [
    e.model_timeout_seconds !== undefined ? `timeout ${e.model_timeout_seconds} s` : null,
    e.run_timeout_seconds !== undefined ? `run limit ${e.run_timeout_seconds} s` : null,
    e.max_concurrency !== undefined ? `${e.max_concurrency} parallel` : null,
    e.max_retries !== undefined ? count(e.max_retries, "retry", "retries") : null,
    e.retry_backoff_seconds !== undefined ? `backoff ${e.retry_backoff_seconds} s` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "server defaults";
}

/** How many turns are kept (the server keeps 6 unless told otherwise; 0 is
 * off), and what else shapes the history. */
export function historySummary(history: HistoryConfig | undefined): string {
  const h = history ?? {};
  const turns = h.max_turns ?? 6;
  if (turns === 0) return "off";
  return [
    count(turns, "turn", "turns"),
    h.max_chars !== undefined ? `${h.max_chars} chars` : null,
    h.remember?.length ? `remembers ${h.remember.join(", ")}` : null,
    h.summarize ? `summarized by ${h.summarize.model.name}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(" · ");
}

/** What nodes without their own settings inherit. */
export function defaultsSummary(defaults: NodeDefaults | undefined): string {
  const d = defaults ?? {};
  const parts = [
    d.model ? modelIdentity(d.model) : null,
    d.model?.temperature !== undefined ? `T ${d.model.temperature}` : null,
    d.system_prompt ? "system prompt" : null,
    d.strip_reasoning ? "strips reasoning" : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "none — every node sets its own";
}

/** "1 branch · 1 loop" — only shown when there's at least one of either. */
export function routingSummary(branches: number, loops: number): string {
  return [branches > 0 ? count(branches, "branch", "branches") : null, loops > 0 ? count(loops, "loop", "loops") : null]
    .filter((p): p is string => p !== null)
    .join(" · ");
}
