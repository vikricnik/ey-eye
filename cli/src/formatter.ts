import chalk from "chalk";
import { buildGraphModel, describeUsage } from "@llm-pipeline/client";
import type {
  RunResponse,
  HealthResponse,
  NodeOutput,
  PipelineDetail,
  PreviewPromptResponse,
  PipelineSummary,
} from "@llm-pipeline/client";
import { renderGraphText } from "./graphRenderer.js";

const DIVIDER = chalk.gray("─".repeat(60));

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatHealth(health: HealthResponse): string {
  const lines: string[] = [
    chalk.bold.cyan("Pipeline server"),
    `${chalk.gray("pipelines dir:")}        ${chalk.yellow(health.pipelines_dir)}`,
    `${chalk.gray("default pipeline:")}     ${chalk.yellow(health.default_pipeline_name)}`,
    "",
    chalk.bold.cyan(`Available pipelines (${health.available_pipelines.length})`),
    ...health.available_pipelines.map(
      (p) => `  ${chalk.blue(p.name)} — ${chalk.gray(p.description || "no description")}`
    ),
  ];
  return lines.join("\n");
}

export function formatPipelineList(pipelines: PipelineSummary[]): string {
  if (pipelines.length === 0) {
    return chalk.gray("No pipelines found.");
  }
  const lines: string[] = [chalk.bold.cyan(`Available pipelines (${pipelines.length})`)];
  for (const p of pipelines) {
    lines.push(`  ${chalk.blue(p.name)} — ${chalk.gray(p.description || "no description")}`);
  }
  return lines.join("\n");
}

export function formatPipelineDetail(detail: PipelineDetail): string {
  const graph = buildGraphModel(detail);
  const lines: string[] = [
    chalk.bold.cyan(detail.name),
    chalk.gray(detail.description || "no description"),
    "",
    ...renderGraphText(graph),
  ];
  return lines.join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/** "(model, 1.2s · 3,900 in · 12 out · 50 tok/s · context 4,096 (95% used))" */
export function nodeStats(node: NodeOutput): string {
  const usage = describeUsage(node.usage);
  const stats = `(${node.model_name}, ${formatDuration(node.duration_ms)}${usage?.summary ? ` · ${usage.summary}` : ""})`;
  return usage?.level === "full" ? chalk.red(stats) : usage?.level === "near" ? chalk.yellow(stats) : chalk.gray(stats);
}

/** One line per node whose prompt filled its context window — shown even
 * without /verbose, because the cut-off happens silently. */
export function contextWarnings(nodes: NodeOutput[]): string[] {
  return nodes.flatMap((node) => {
    const usage = describeUsage(node.usage);
    return usage?.level === "full" ? [chalk.yellow(`⚠ ${node.node_id}: ${usage.warning}`)] : [];
  });
}

function formatNode(nodeId: string, node: NodeOutput, isOutputNode: boolean): string {
  const tag = isOutputNode ? chalk.bold.magenta("  ← output node") : "";
  const header = `${chalk.bold.blue(nodeId)} ${nodeStats(node)}${tag}`;
  return `${header}\n${indent(node.output, 2)}`;
}

export function formatRunResponse(
  response: RunResponse,
  verbose: boolean,
  elapsedMs: number
): string {
  const sections: string[] = [];

  sections.push(
    `${chalk.gray("pipeline:")} ${chalk.yellow(response.pipeline_name)}   ` +
      `${chalk.gray("took:")} ${chalk.magenta(formatDuration(elapsedMs))}`
  );
  sections.push(DIVIDER);

  sections.push(chalk.bold.green("Final answer"));
  sections.push(response.final_answer);

  const nodeIds = Object.keys(response.node_outputs);
  if (verbose) {
    sections.push(DIVIDER);
    sections.push(chalk.bold.cyan(`Node outputs (${nodeIds.length})`));
    for (const nodeId of nodeIds) {
      sections.push("");
      sections.push(
        formatNode(nodeId, response.node_outputs[nodeId]!, nodeId === response.output_node)
      );
    }
  }

  const warnings = contextWarnings(Object.values(response.node_outputs));
  if (warnings.length > 0) sections.push("", ...warnings);

  const loopIds = Object.keys(response.loop_iterations);
  if (loopIds.length > 0) {
    sections.push(DIVIDER);
    sections.push(chalk.bold.cyan("Loop iterations"));
    for (const loopId of loopIds) {
      sections.push(`  ${chalk.blue(loopId)}: ${response.loop_iterations[loopId]} time(s)`);
    }
  }

  return sections.join("\n");
}

/** /preview: what a node would receive. `basis` says which message it was
 * rendered for (null: placeholders — nothing has run yet). */
export function formatPreview(nodeId: string, preview: PreviewPromptResponse, basis: string | null): string {
  const lines = [
    chalk.bold.cyan(`What ${nodeId} would receive`) +
      chalk.gray(` — ${basis ?? "with placeholders until the first run"}, ${preview.prompt.length.toLocaleString("en-US")} characters`),
  ];
  if (preview.system) lines.push(chalk.gray("system:"), indent(preview.system, 2));
  lines.push(chalk.gray("prompt:"), indent(preview.prompt, 2));
  if (preview.missing.length > 0) {
    lines.push(chalk.gray(`(no output yet from ${preview.missing.join(", ")} — shown as placeholders)`));
  }
  return lines.join("\n") + "\n";
}
