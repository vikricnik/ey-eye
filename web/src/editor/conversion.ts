import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import {
  LOOP_EXIT_END,
  buildGraphModel,
  detailFromDefinition,
  displayModel,
  effectiveModel,
} from "@llm-pipeline/client";
import type {
  GraphModel,
  NodeExecutionStatus,
  NodeOutput,
  NodeUsage,
  PipelineDefinition,
} from "@llm-pipeline/client";
import type { ValidationState } from "./editorState";

export interface LlmNodeData extends Record<string, unknown> {
  nodeId: string;
  model: string;
  temperature: number | undefined;
  optionCount: number;
  hasSystemPrompt: boolean;
  isOutput: boolean;
  status: NodeExecutionStatus;
  durationMs: number | undefined;
  /** Tokens and context use from the node's last run. */
  usage: NodeUsage | undefined;
  /** The last run (a re-run) reused this node's output. */
  replayed: boolean;
  /** Tail of the text the model is writing, while the node runs. */
  liveText: string | undefined;
  problem: "error" | "warning" | undefined;
}

export type LlmFlowNode = Node<LlmNodeData, "llm">;

/** Ids of the right-side handles loop back-edges attach to (see LlmNode). */
export const LOOP_OUT_HANDLE = "loop-out";
export const LOOP_IN_HANDLE = "loop-in";

/** Vertical distance between dependency levels — room for a node card
 * (~80px) plus the live-text preview it grows by while running. */
export const LEVEL_SPACING = 170;
/** Horizontal distance between siblings on one level (card is 220px wide). */
export const SIBLING_SPACING = 260;

/** A top-to-bottom position per node from the shared layout levels
 * (buildGraphModel) — the same leveling the CLI's diagram uses. Each
 * level is a row, centered, so parallel siblings sit side by side under
 * what they depend on. */
export function autoLayout(graph: GraphModel): Record<string, { x: number; y: number }> {
  const byLevel = new Map<number, string[]>();
  for (const node of graph.nodes) {
    byLevel.set(node.level, [...(byLevel.get(node.level) ?? []), node.id]);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [level, ids] of byLevel) {
    ids.forEach((id, index) => {
      positions[id] = {
        x: (index - (ids.length - 1) / 2) * SIBLING_SPACING,
        y: level * LEVEL_SPACING,
      };
    });
  }
  return positions;
}

export function graphOf(definition: PipelineDefinition): GraphModel {
  return buildGraphModel(detailFromDefinition(definition));
}

export interface FlowInputs {
  definition: PipelineDefinition;
  graph: GraphModel;
  status: Record<string, NodeExecutionStatus>;
  outputs: Record<string, NodeOutput>;
  liveText: Record<string, string>;
  validation: ValidationState;
  editable: boolean;
}

export function definitionToFlow(inputs: FlowInputs): { nodes: LlmFlowNode[]; edges: Edge[] } {
  const { definition, graph, status, outputs, liveText, validation, editable } = inputs;
  const fallback = autoLayout(graph);
  const outputIds = new Set(definition.output_nodes);

  const warnings = new Set(
    validation.status === "valid"
      ? [...validation.modelIssues, ...validation.warnings]
          .map((i) => i.nodeId)
          .filter((id): id is string => id !== null)
      : []
  );
  const errorNode = validation.status === "invalid" ? validation.nodeId : null;

  const nodes: LlmFlowNode[] = definition.nodes.map((n) => ({
    id: n.id,
    type: "llm",
    position: n.layout ?? fallback[n.id] ?? { x: 0, y: 0 },
    deletable: editable,
    data: {
      nodeId: n.id,
      model: displayModel(definition, n),
      temperature: effectiveModel(definition, n)?.temperature,
      optionCount: Object.keys(effectiveModel(definition, n)?.options ?? {}).length,
      hasSystemPrompt: Boolean(n.system_prompt ?? definition.defaults?.system_prompt),
      isOutput: outputIds.has(n.id),
      status: status[n.id] ?? "not-started",
      durationMs: outputs[n.id]?.duration_ms,
      usage: outputs[n.id]?.usage ?? undefined,
      replayed: outputs[n.id]?.replayed === true,
      liveText: status[n.id] === "running" && liveText[n.id] ? liveText[n.id]!.slice(-160) : undefined,
      problem: errorNode === n.id ? "error" : warnings.has(n.id) ? "warning" : undefined,
    },
  }));

  const edges: Edge[] = [];
  for (const e of graph.edges) {
    if (e.to === LOOP_EXIT_END) continue; // "exit to END" has no target node; shown in the inspector
    const running = status[e.to] === "running";
    if (e.kind === "plain") {
      edges.push({
        id: `dep:${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        className: "edge-plain",
        animated: running,
        deletable: editable,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    } else if (e.kind === "branch") {
      edges.push({
        id: `branch:${e.branchId}:${e.routeIndex}:${e.to}`,
        source: e.from,
        target: e.to,
        className: "edge-branch",
        label: e.label,
        animated: running,
        deletable: false,
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    } else {
      const isContinue = e.kind === "loop-continue";
      edges.push({
        id: `loop:${e.loopId}:${isContinue ? "back" : "exit"}`,
        source: e.from,
        target: e.to,
        // The back-edge goes up, beside the nodes — see LOOP_OUT_HANDLE.
        ...(isContinue
          ? { sourceHandle: LOOP_OUT_HANDLE, targetHandle: LOOP_IN_HANDLE, pathOptions: { offset: 36 } }
          : {}),
        className: "edge-loop",
        type: isContinue ? "smoothstep" : "default",
        label: isContinue ? `↻ ${e.loopId} ≤${e.maxIterations}` : `${e.loopId} exit`,
        animated: running,
        deletable: false,
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
  }

  return { nodes, edges };
}

/** Plain dependency edges carry "dep:<from>-><to>" ids; returns null for
 * branch/loop edges, which are edited in the inspector instead. */
export function parseDependencyEdgeId(id: string): { from: string; to: string } | null {
  const match = /^dep:(.+)->(.+)$/.exec(id);
  return match ? { from: match[1]!, to: match[2]! } : null;
}
