import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, RefObject } from "react";
import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import type { Edge, EdgeChange, IsValidConnection, NodeChange, NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { LlmNode } from "./LlmNode";
import { parseDependencyEdgeId } from "./conversion";
import type { LlmFlowNode } from "./conversion";
import type { Selection } from "./editorState";
import { compactTextScale, fitOptions, isCompact } from "./zoomDetail";
import { AutoLayoutIcon } from "../ui/icons";
import { CanvasLegend } from "./CanvasLegend";
import { canvasHint } from "./canvasHint";

/** Drag-and-drop payload type set by the sidebar palette. The value is a
 * preset name, or "" for a plain node. */
export const NODE_DRAG_TYPE = "application/x-llm-pipeline-node";

const nodeTypes: NodeTypes = { llm: LlmNode };

export interface PipelineCanvasProps {
  nodes: LlmFlowNode[];
  edges: Edge[];
  editable: boolean;
  /** The app's resolved theme. */
  colorMode: "light" | "dark";
  /** The display text size: fitting the view zooms up to it, so cards
   * grow with the text elsewhere as long as the pipeline still fits, and
   * zoomed-out cards keep their text at it (see zoomDetail.ts). */
  textScale: number;
  selectedNodeId: string | null;
  /** The selected dependency edge's id (see dependencyEdgeId), if any. */
  selectedEdgeId: string | null;
  /** Bump to re-fit the view (after auto-layout, import, …). */
  fitSignal: number;
  onConnect: (from: string, to: string) => void;
  onDisconnect: (from: string, to: string) => void;
  onDeleteNodes: (ids: string[]) => void;
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void;
  onSelect: (selection: Selection | null) => void;
  onDropNode: (position: { x: number; y: number }, presetName: string | undefined) => void;
  /** Re-arranges every node by dependency level (a canvas control, beside
   * zoom and fit). */
  onAutoLayout: () => void;
}

const isValidConnection: IsValidConnection = (c) => c.source !== c.target;

/** Keeps --node-text-scale on the canvas in step with the zoom, written
 * straight to the element so zooming doesn't re-render the canvas. */
function CompactTextScale({ target, textScale }: { target: RefObject<HTMLDivElement | null>; textScale: number }) {
  const zoom = useStore((s) => s.transform[2]);
  useLayoutEffect(() => {
    target.current?.style.setProperty("--node-text-scale", String(compactTextScale(zoom, textScale)));
  }, [target, zoom, textScale]);
  return null;
}

function CanvasInner(props: PipelineCanvasProps) {
  const { editable, selectedNodeId, selectedEdgeId, textScale } = props;
  const flow = useReactFlow();
  const fit = useMemo(() => fitOptions(textScale), [textScale]);
  const canvas = useRef<HTMLDivElement>(null);
  const hint = canvasHint({ nodes: props.nodes.length, edges: props.edges.length, editable });
  // Re-renders only when the zoom crosses the threshold, not on every step.
  const compact = useStore((s) => isCompact(s.transform[2], textScale));

  // React Flow keeps per-node runtime state (measured size, drag state,
  // selection) on the node objects themselves. The pipeline definition is
  // the source of truth for everything else, so each new derived node list
  // is merged with that runtime state instead of replacing it — otherwise
  // a run event arriving mid-drag would snap the node back.
  const [nodes, setNodes] = useState<LlmFlowNode[]>(props.nodes);
  const [edges, setEdges] = useState<Edge[]>(props.edges);

  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return props.nodes.map((n) => {
        const old = byId.get(n.id);
        return {
          ...n,
          selected: n.id === selectedNodeId,
          ...(old?.measured ? { measured: old.measured } : {}),
          ...(old?.dragging ? { dragging: true, position: old.position } : {}),
        };
      });
    });
  }, [props.nodes, selectedNodeId]);

  useEffect(() => {
    setEdges((previous) => {
      const selected = new Set(previous.filter((e) => e.selected).map((e) => e.id));
      return props.edges.map((e) => ({ ...e, selected: selected.has(e.id) }));
    });
  }, [props.edges]);

  // With no edge selected in the app (the pipeline settings were opened, or
  // the breadcrumb clicked), none stays selected here either — or Backspace
  // would delete an edge the panel no longer shows.
  useEffect(() => {
    if (selectedEdgeId !== null) return;
    setEdges((current) =>
      current.some((e) => e.selected) ? current.map((e) => (e.selected ? { ...e, selected: false } : e)) : current
    );
  }, [selectedEdgeId]);

  const latestFit = useRef(fit);
  latestFit.current = fit;
  useEffect(() => {
    if (props.fitSignal > 0) requestAnimationFrame(() => void flow.fitView({ ...latestFit.current, duration: 300 }));
  }, [props.fitSignal, flow]);

  // A new text size re-fits, so the canvas follows it right away.
  const firstScale = useRef(textScale);
  useEffect(() => {
    if (textScale === firstScale.current) return;
    firstScale.current = textScale;
    requestAnimationFrame(() => void flow.fitView({ ...fit, duration: 300 }));
  }, [textScale, fit, flow]);

  // Removals go through onNodesDelete/onEdgesDelete (-> the definition);
  // everything else (drag, select, measure) is applied locally.
  const onNodesChange = useCallback((changes: NodeChange<LlmFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), current));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), current));
  }, []);

  const onDrop = (event: DragEvent) => {
    if (!editable || !event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
    event.preventDefault();
    const preset = event.dataTransfer.getData(NODE_DRAG_TYPE);
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    props.onDropNode({ x: position.x - 100, y: position.y - 30 }, preset || undefined);
  };

  return (
    <div
      ref={canvas}
      className={compact ? "canvas detail-compact" : "canvas"}
      onDragOver={(e) => {
        if (editable && e.dataTransfer.types.includes(NODE_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={onDrop}
    >
      <CompactTextScale target={canvas} textScale={textScale} />
      <ReactFlow<LlmFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={props.colorMode}
        fitView
        fitViewOptions={fit}
        minZoom={0.2}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        isValidConnection={isValidConnection}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(c) => props.onConnect(c.source, c.target)}
        onNodesDelete={(deleted) => props.onDeleteNodes(deleted.map((n) => n.id))}
        onEdgesDelete={(deleted) => {
          for (const e of deleted) {
            const dep = parseDependencyEdgeId(e.id);
            if (dep) props.onDisconnect(dep.from, dep.to);
          }
        }}
        onNodeDragStop={(_event, _node, dragged) =>
          props.onMoveNodes(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })))
        }
        onNodeClick={(_event, node) => props.onSelect({ kind: "node", id: node.id })}
        onEdgeClick={(_event, edge) => {
          const dep = parseDependencyEdgeId(edge.id);
          if (dep) props.onSelect({ kind: "edge", ...dep });
        }}
        onPaneClick={() => props.onSelect(null)}
      >
        <Background gap={24} size={1} />
        {/* Its fit button takes its own options — the same limits as fitting on load. */}
        <Controls showInteractive={false} fitViewOptions={fit}>
          <ControlButton
            onClick={props.onAutoLayout}
            disabled={!editable}
            title={editable ? "Auto-layout: arrange the nodes by dependency level" : "Auto-layout (editing is disabled)"}
            aria-label="Auto-layout"
          >
            <AutoLayoutIcon />
          </ControlButton>
        </Controls>
        <MiniMap pannable zoomable nodeStrokeWidth={3} style={{ width: 140, height: 90 }} />
        <Panel position="top-right">
          <CanvasLegend />
        </Panel>
        {hint && (
          <Panel position="top-center" className="canvas-hint">
            {hint}
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

export function PipelineCanvas(props: PipelineCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
