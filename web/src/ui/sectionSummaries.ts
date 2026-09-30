import { effectiveModel, modelIdentity } from "@llm-pipeline/client";
import type { PipelineDefinition } from "@llm-pipeline/client";
import type { Selection, ValidationState } from "../editor/editorState";
import { settingsSubject } from "../editor/selection";
import { outputSummary } from "../editor/pipelineSummaries";
import { formatDuration } from "../format";
import type { Turn } from "../run/Chat";
import { resultKey } from "../tests/resultKey";
import type { TestRunState } from "../tests/TestsView";

// The one-line headers of the left panel's sections (ui/LeftPanel.tsx):
// what each holds, readable while it's folded.

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Node section's title — "Node", or "Dependency" — and what's selected. */
export function selectionHeading(
  definition: PipelineDefinition,
  selection: Selection | null
): { title: string; detail?: string } {
  const subject = settingsSubject(definition, selection);
  if (subject === "node" && selection?.kind === "node") return { title: "Node", detail: selection.id };
  if (subject === "dependency" && selection?.kind === "edge") {
    return { title: "Dependency", detail: `${selection.from} → ${selection.to}` };
  }
  return { title: "Node" };
}

/** A node's model and temperature (as its Model section says), what a
 * dependency means, or that nothing is selected. */
export function selectionSummary(definition: PipelineDefinition, selection: Selection | null): string {
  const subject = settingsSubject(definition, selection);
  if (subject === "node" && selection?.kind === "node") {
    const node = definition.nodes.find((n) => n.id === selection.id)!;
    const temperature = effectiveModel(definition, node)?.temperature ?? 0.2;
    return `${node.model ? modelIdentity(node.model) : "pipeline default"} · T ${temperature}`;
  }
  if (subject === "dependency" && selection?.kind === "edge") return `${selection.to} waits for ${selection.from}`;
  return "nothing selected";
}

/** How many runs the conversation has, and how long the last one took. */
export function chatSummary(turns: readonly Turn[], running: boolean): string {
  if (running) return "running…";
  if (turns.length === 0) return "no messages yet";
  const runs = count(turns.length, "run");
  const last = turns.at(-1)!;
  return last.elapsedMs !== undefined ? `${runs} · last ${formatDuration(last.elapsedMs)}` : runs;
}

/** Which node answers, and how much history the nodes see (6 turns unless set). */
export function pipelineSectionSummary(definition: PipelineDefinition): string {
  const turns = definition.history?.max_turns ?? 6;
  return `${outputSummary(definition.output_nodes)} · history ${turns === 0 ? "off" : count(turns, "turn")}`;
}

/** The test cases, and how the draft did in the latest test run. */
export function testsSummary(caseCount: number, run: TestRunState | null): string {
  if (caseCount === 0) return "no test cases";
  const cases = count(caseCount, "case");
  if (!run) return cases;
  const results = run.cases.map((c) => run.results[resultKey(c, "current")]).filter((r) => r !== undefined);
  if (run.status === "running") return `running ${results.length}/${run.cases.length}`;
  if (run.status === "error") return `${cases} · test run failed`;
  if (run.status === "stopped") return `${cases} · stopped`;
  const judged = results.filter((r) => r.passed !== null);
  if (judged.length === 0) return cases;
  return `${cases} · ${judged.filter((r) => r.passed).length}/${judged.length} passed`;
}

/** What the Add node section offers. */
export function paletteSummary(presetCount: number): string {
  return `LLM node · ${presetCount === 0 ? "no presets" : count(presetCount, "preset")}`;
}

export type StateTone = "ok" | "warn" | "error";

/** The pipeline's state as a tone and a line — the status chip's words;
 * the rail's dot, and the header's dot when the panel is too narrow for
 * the chip. */
export function pipelineState(
  doc: { dirty: boolean } | null,
  validation: ValidationState
): { tone: StateTone; label: string } {
  if (!doc) return { tone: "warn", label: "no pipeline loaded" };
  if (!doc.dirty) return { tone: "ok", label: "saved" };
  switch (validation.status) {
    case "checking":
      return { tone: "warn", label: "checking…" };
    case "valid": {
      const issues = validation.modelIssues.length + validation.warnings.length;
      return { tone: "warn", label: issues > 0 ? `valid · ${count(issues, "warning")}` : "valid · unsaved" };
    }
    case "invalid":
      return { tone: "error", label: validation.nodeId ? `invalid · ${validation.nodeId}` : "invalid" };
    case "unavailable":
      return { tone: "warn", label: "can't validate" };
    default:
      return { tone: "warn", label: "unsaved" };
  }
}
