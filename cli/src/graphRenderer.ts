import chalk from "chalk";
import type {
  GraphEdge,
  GraphModel,
  GraphNode,
  GraphViewState,
  NodeExecutionStatus,
} from "@llm-pipeline/client";
import { LOOP_EXIT_END } from "@llm-pipeline/client";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Visible length of a chalk-colored string, ignoring ANSI escape codes —
 * needed to size box-drawing borders correctly, since the escape codes
 * chalk inserts don't occupy any terminal columns. */
function visibleLength(str: string): number {
  return str.replace(ANSI_PATTERN, "").length;
}

function padVisible(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - visibleLength(str)));
}

/** Truncates a PLAIN (no ANSI codes) string to `maxLen` visible columns,
 * appending an ellipsis if anything was cut — must run on plain text
 * before chalk-coloring, since slicing a colored string by character
 * count can land mid-escape-sequence and corrupt the color codes for the
 * rest of the line. */
function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return text.slice(0, 1);
  return text.slice(0, maxLen - 1) + "…";
}

/** FR-016's terminal case: the diagram must wrap/truncate rather than
 * become illegible when the terminal is narrower than its natural width.
 * Falls back to 80 columns for non-TTY output (e.g. piped/redirected). */
function terminalWidth(): number {
  return process.stdout.columns || 80;
}

/** One horizontal rule of box-drawing characters, `width` visible columns
 * wide, with an optional title cut into the top-left. */
function boxRule(width: number, left: string, right: string, title?: string): string {
  if (!title) return left + "─".repeat(width) + right;
  const label = ` ${title} `;
  const remaining = Math.max(0, width - label.length);
  return left + label + "─".repeat(remaining) + right;
}

const STATUS_GLYPH: Record<NodeExecutionStatus, string> = {
  "not-started": "○",
  running: "◐",
  complete: "●",
  failed: "✕",
};

function statusColor(status: NodeExecutionStatus | undefined): (s: string) => string {
  switch (status) {
    case "running":
      return chalk.yellow;
    case "complete":
      return chalk.green;
    case "failed":
      return chalk.red;
    default:
      return chalk.gray;
  }
}

/** One node's single-line label: status glyph (if live status is known),
 * id, output-candidate marker (FR-007), and model identity (FR-006). When
 * `maxWidth` is given and the full line wouldn't fit, the model portion
 * is truncated first — the node id is what a user actually needs to
 * recognize, so it's the last thing to give up space. */
function nodeLine(
  node: GraphNode,
  status: NodeExecutionStatus | undefined,
  maxWidth?: number
): string {
  const glyphPlain = status ? STATUS_GLYPH[status] + " " : "";
  const badgePlain = node.isOutputCandidate ? " ★" : "";
  const prefixPlain = glyphPlain + node.id + badgePlain;

  let modelPlain = `[${node.model}]`;
  if (maxWidth !== undefined) {
    const available = maxWidth - prefixPlain.length - 2; // 2 = the two spaces before the bracket
    modelPlain = available < 3 ? "" : truncatePlain(modelPlain, available);
  }

  const glyphColored = status ? statusColor(status)(STATUS_GLYPH[status]) + " " : "";
  const badgeColored = node.isOutputCandidate ? chalk.magenta(" ★") : "";
  const modelColored = modelPlain ? "  " + chalk.gray(modelPlain) : "";
  return `${glyphColored}${chalk.bold(node.id)}${badgeColored}${modelColored}`;
}

function groupByLevel(nodes: GraphNode[]): Map<number, GraphNode[]> {
  const byLevel = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const bucket = byLevel.get(node.level) ?? [];
    bucket.push(node);
    byLevel.set(node.level, bucket);
  }
  return byLevel;
}

function edgeGlyphAndColor(edge: GraphEdge): { glyph: string; color: (s: string) => string } {
  if (edge.kind === "plain") return { glyph: "→", color: chalk.gray };
  if (edge.kind === "branch") return { glyph: "⇢", color: chalk.cyan };
  return { glyph: "↻", color: chalk.yellow }; // loop-continue / loop-exit
}

/** Builds a live loop edge's label, folding in `progress` (iteration vs.
 * max, and "(exhausted)" once known) on top of the static "id (max N)"
 * text — same information the web view's applyGraphViewState() shows,
 * kept consistent across surfaces. Falls back to the static label when no
 * live progress is known yet (User Story 2's static call sites). */
function loopEdgeLabel(edge: GraphEdge, state: GraphViewState | undefined): string | null {
  const progress = edge.loopId ? state?.loopProgress[edge.loopId] : undefined;
  if (!progress) return edge.label;
  const exhausted = progress.exhausted ? " (exhausted)" : "";
  return `${edge.loopId} — iteration ${progress.iteration}/${progress.maxIterations}${exhausted}`;
}

function renderEdgeLines(edges: GraphEdge[], state: GraphViewState | undefined): string[] {
  const byKind = {
    plain: edges.filter((e) => e.kind === "plain"),
    branch: edges.filter((e) => e.kind === "branch"),
    loop: edges.filter((e) => e.kind === "loop-continue" || e.kind === "loop-exit"),
  };

  const lines: string[] = [chalk.bold("Edges")];

  const maxLineWidth = Math.max(20, terminalWidth() - 2);

  function section(kind: keyof typeof byKind, heading: string): void {
    const list = byKind[kind];
    const { glyph, color } = edgeGlyphAndColor(list[0] ?? ({ kind } as GraphEdge));
    if (list.length === 0) {
      lines.push(`  ${color(glyph)} ${heading.padEnd(8)} (none)`);
      return;
    }
    list.forEach((edge, i) => {
      const targetPlain = edge.to === LOOP_EXIT_END ? "END" : edge.to;
      // FR-010: once a branch has resolved, mark which route was taken and
      // dim the ones that weren't — matches the web view's route-taken /
      // route-not-taken styling.
      const outcome = edge.branchId ? state?.branchOutcomes[edge.branchId] : undefined;
      const isTaken = outcome !== undefined && outcome.takenTo === edge.to;
      const isNotTaken = outcome !== undefined && outcome.takenTo !== edge.to;
      const suffixPlain = isTaken ? " ✓ taken" : isNotTaken ? " (not taken)" : "";

      const prefixPlain = i === 0 ? `  ${glyph} ${heading.padEnd(8)} ` : " ".repeat(12);
      const corePlain = `${edge.from} ${glyph} ${targetPlain}${suffixPlain}`;
      const rawLabel = kind === "loop" ? loopEdgeLabel(edge, state) : edge.label;
      const available = maxLineWidth - prefixPlain.length - corePlain.length;
      const labelPlain = rawLabel ? truncatePlain(` — ${rawLabel}`, Math.max(0, available)) : "";

      const target = edge.to === LOOP_EXIT_END ? chalk.italic("END") : targetPlain;
      const rowColor = isNotTaken ? chalk.dim : (s: string) => s;
      const suffix = isTaken ? chalk.bold.green(" ✓ taken") : isNotTaken ? chalk.dim(" (not taken)") : "";
      const label = labelPlain ? chalk.dim(labelPlain) : "";
      lines.push(rowColor(`${prefixPlain}${edge.from} ${color(glyph)} ${target}${suffix}${label}`));
    });
  }

  section("plain", "plain");
  section("branch", "branch");
  section("loop", "loop");

  return lines;
}

/**
 * Renders a pipeline's structure (and, optionally, live status via
 * `state`) as an array of terminal lines — box-drawing node groups per
 * layout level, then a distinctly-glyphed, labeled edge list per kind
 * (FR-002, FR-003, FR-004, FR-005, FR-006, FR-007). Returns an array
 * (rather than a single joined string) so callers doing an in-place
 * redraw (User Story 3 / cli/src/index.ts) know exactly how many
 * terminal lines to clear before reprinting. `state` is optional and
 * unused by User Story 2's static call sites — User Story 3 passes it to
 * layer live per-node status, taken routes, loop progress, and any
 * connection error on top of this same structure (see
 * contracts/graph-model.md).
 */
export function renderGraphText(graph: GraphModel, state?: GraphViewState): string[] {
  const lines: string[] = [];
  const byLevel = groupByLevel(graph.nodes);
  const maxLevel = Math.max(0, ...graph.nodes.map((n) => n.level));

  const terminalCap = Math.max(20, terminalWidth() - 4);

  for (let level = 0; level <= maxLevel; level++) {
    const nodes = byLevel.get(level);
    if (!nodes || nodes.length === 0) continue;

    const rawContentLines = nodes.map((n) => nodeLine(n, state?.nodeStatus[n.id]));
    const rawInnerWidth = Math.max(
      visibleLength(`Level ${level}`) + 2,
      ...rawContentLines.map(visibleLength)
    );
    const innerWidth = Math.min(rawInnerWidth, terminalCap);
    // Only re-truncate if capping actually kicked in — the common case
    // (diagram already fits) does no extra work.
    const contentLines =
      innerWidth < rawInnerWidth
        ? nodes.map((n) => nodeLine(n, state?.nodeStatus[n.id], innerWidth - 1))
        : rawContentLines;

    lines.push(chalk.gray(boxRule(innerWidth, "┌", "┐", `Level ${level}`)));
    for (const content of contentLines) {
      lines.push(chalk.gray("│ ") + padVisible(content, innerWidth - 1) + chalk.gray("│"));
    }
    lines.push(chalk.gray(boxRule(innerWidth, "└", "┘")));
    lines.push("");
  }

  lines.push(...renderEdgeLines(graph.edges, state));

  if (graph.nodes.some((n) => n.isOutputCandidate)) {
    lines.push("");
    lines.push(chalk.gray(`★ = possible output node`));
  }

  if (state?.connectionError) {
    lines.push("");
    lines.push(chalk.red(`✕ ${state.connectionError}`));
  }

  return lines;
}
