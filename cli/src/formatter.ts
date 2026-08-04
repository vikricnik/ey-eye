import chalk from "chalk";
import type {
  AskResponse,
  HealthResponse,
  NodeOutput,
  PipelineDetail,
  PipelineSummary,
} from "./types.js";

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
  const lines: string[] = [
    chalk.bold.cyan(detail.name),
    chalk.gray(detail.description || "no description"),
    "",
    chalk.bold.cyan("Nodes"),
  ];
  for (const node of detail.nodes) {
    const isOutput = detail.output_node_candidates.includes(node.id);
    const deps = node.depends_on.length > 0 ? node.depends_on.join(", ") : "(root)";
    const tag = isOutput ? chalk.bold.magenta("  ← possible output") : "";
    lines.push(
      `  ${chalk.blue(node.id)} ${chalk.gray(`[${node.model}]`)} depends_on: ${chalk.yellow(deps)}${tag}`
    );
  }

  if (detail.branches.length > 0) {
    lines.push("", chalk.bold.cyan("Branches"));
    for (const b of detail.branches) {
      lines.push(`  ${chalk.blue(b.id)}: ${b.from} → ${b.routes.join(" | ")}`);
    }
  }

  if (detail.loops.length > 0) {
    lines.push("", chalk.bold.cyan("Loops"));
    for (const l of detail.loops) {
      lines.push(
        `  ${chalk.blue(l.id)}: ${l.from} → (loop) ${l.back_to} / (exit) ${l.exit_to} ` +
          `${chalk.gray(`[max ${l.max_iterations} iterations]`)}`
      );
    }
  }

  return lines.join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function formatNode(nodeId: string, node: NodeOutput, isOutputNode: boolean): string {
  const tag = isOutputNode ? chalk.bold.magenta("  ← output node") : "";
  const header = `${chalk.bold.blue(nodeId)} ${chalk.gray(`(${node.model_name}, ${formatDuration(node.duration_ms)})`)}${tag}`;
  return `${header}\n${indent(node.output, 2)}`;
}

export function formatAskResponse(
  response: AskResponse,
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
