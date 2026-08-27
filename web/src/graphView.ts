import type { GraphEdge, GraphModel, GraphNode, GraphViewState } from "@llm-pipeline/client";
import { LOOP_EXIT_END } from "@llm-pipeline/client";

const SVG_NS = "http://www.w3.org/2000/svg";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 52;
const COLUMN_GAP = 150;
const ROW_GAP = 26;
const MARGIN = 44;
// The visual stub line itself is short, but the reserved canvas width must
// fit its label text ("<loop id> exit (max N)"), which is often wider
// than the stub line — reserved separately so long loop ids don't get
// clipped at the SVG's right edge.
const END_STUB_LINE_WIDTH = 40;
const END_STUB_WIDTH = 200;

interface NodePosition {
  x: number;
  y: number;
}

interface Layout {
  positions: Map<string, NodePosition>;
  width: number;
  height: number;
}

/** Groups nodes by layout level (preserving each level's original node
 * order for determinism) and assigns a simple left-to-right grid position
 * — one column per level, one row per node within that level. */
function computeLayout(graph: GraphModel): Layout {
  const byLevel = new Map<number, GraphNode[]>();
  let maxLevel = 0;
  for (const node of graph.nodes) {
    maxLevel = Math.max(maxLevel, node.level);
    const bucket = byLevel.get(node.level) ?? [];
    bucket.push(node);
    byLevel.set(node.level, bucket);
  }

  let maxRows = 1;
  const positions = new Map<string, NodePosition>();
  for (const [level, nodes] of byLevel) {
    maxRows = Math.max(maxRows, nodes.length);
    nodes.forEach((node, row) => {
      const x = MARGIN + level * (NODE_WIDTH + COLUMN_GAP);
      const y = MARGIN + row * (NODE_HEIGHT + ROW_GAP);
      positions.set(node.id, { x, y });
    });
  }

  return {
    positions,
    width: MARGIN * 2 + (maxLevel + 1) * NODE_WIDTH + maxLevel * COLUMN_GAP + END_STUB_WIDTH,
    height: MARGIN * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP,
  };
}

/**
 * Assigns each edge a "port" — a fractional position along its source
 * node's right edge and its target node's left edge — instead of every
 * edge always anchoring at dead center. Without this, every edge sharing
 * a source (e.g. a 3-way branch) or a target (e.g. a diamond join)
 * converges on the exact same pixel and the curves tangle into an
 * unreadable knot right at the node. Ports are assigned by each edge's
 * position within graph.edges, grouped by `from`/`to` — deterministic,
 * and stable across re-renders of the same GraphModel.
 */
function computeEdgePorts(graph: GraphModel): {
  startY: (edge: GraphEdge) => number;
  endY: (edge: GraphEdge) => number;
} {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge);
    if (edge.to !== LOOP_EXIT_END) {
      (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge);
    }
  }

  function portOffset(list: GraphEdge[] | undefined, edge: GraphEdge): number {
    if (!list || list.length === 0) return NODE_HEIGHT / 2;
    const index = list.indexOf(edge);
    return (NODE_HEIGHT * (index + 1)) / (list.length + 1);
  }

  return {
    startY: (edge) => portOffset(outgoing.get(edge.from), edge),
    endY: (edge) => portOffset(incoming.get(edge.to), edge),
  };
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function edgeKindClass(edge: GraphEdge): string {
  return edge.kind === "plain" ? "plain" : edge.kind.startsWith("loop") ? "loop" : "branch";
}

/** Draws one node box: id, model identity, and an output-candidate marker
 * (FR-006, FR-007), stacked as three rows so a long node id never
 * collides with the badge. `data-node-id` is used both by CSS and by
 * applyGraphViewState() (T023) to target a node for live-status styling. */
function renderNodeEl(node: GraphNode, pos: NodePosition): SVGGElement {
  const g = svgEl("g");
  g.setAttribute("class", "graph-node" + (node.isOutputCandidate ? " output-candidate" : ""));
  g.setAttribute("data-node-id", node.id);
  g.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);

  const rect = svgEl("rect");
  rect.setAttribute("class", "graph-node-box");
  rect.setAttribute("width", String(NODE_WIDTH));
  rect.setAttribute("height", String(NODE_HEIGHT));
  rect.setAttribute("rx", "4");
  g.appendChild(rect);

  const idText = svgEl("text");
  idText.setAttribute("class", "graph-node-id");
  idText.setAttribute("x", "10");
  idText.setAttribute("y", "17");
  idText.textContent = node.id;
  g.appendChild(idText);

  const modelText = svgEl("text");
  modelText.setAttribute("class", "graph-node-model");
  modelText.setAttribute("x", "10");
  modelText.setAttribute("y", "31");
  modelText.textContent = node.model;
  g.appendChild(modelText);

  if (node.isOutputCandidate) {
    const badge = svgEl("text");
    badge.setAttribute("class", "graph-node-output-badge");
    badge.setAttribute("x", "10");
    badge.setAttribute("y", "45");
    badge.textContent = "→ possible output";
    g.appendChild(badge);
  }

  const title = svgEl("title");
  title.textContent = `${node.id} (${node.model})`;
  g.appendChild(title);

  return g;
}

/** One plain edge: a straight line, arrowhead at the target, no label —
 * the "default" visual treatment every other edge kind is drawn distinct
 * from (FR-003). */
function renderPlainEdge(
  edge: GraphEdge,
  from: NodePosition,
  to: NodePosition,
  startY: number,
  endY: number
): SVGElement {
  const line = svgEl("line");
  line.setAttribute("class", "graph-edge plain");
  line.setAttribute("x1", String(from.x + NODE_WIDTH));
  line.setAttribute("y1", String(from.y + startY));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y + endY));
  line.setAttribute("marker-end", "url(#arrow-plain)");
  return line;
}

/** One branch or loop edge: a curved path (distinct from plain edges'
 * straight lines even when running in the same direction) with a label at
 * its midpoint — condition/"default" for branches (FR-004), loop id +
 * max_iterations for loops (FR-005). Used for both forward branch edges
 * and loop edges that may run backward (back_to) or sideways (exit_to to
 * an arbitrary real node). */
function renderCurvedEdge(
  edge: GraphEdge,
  from: NodePosition,
  to: NodePosition,
  startYOffset: number,
  endYOffset: number
): SVGGElement {
  const g = svgEl("g");
  g.setAttribute("class", `graph-edge-group ${edgeKindClass(edge)}`);
  g.setAttribute("data-edge-kind", edge.kind);
  g.setAttribute("data-edge-to", edge.to);
  if (edge.branchId) g.setAttribute("data-branch-id", edge.branchId);
  if (edge.loopId) g.setAttribute("data-loop-id", edge.loopId);

  const startX = from.x + NODE_WIDTH;
  const startY = from.y + startYOffset;
  const endX = to.x;
  const endY = to.y + endYOffset;
  const backward = endX <= startX;

  // A backward/sideways edge (loop back_to, or a loop exit_to that isn't
  // strictly to the right) arcs below the row instead of cutting straight
  // through intervening nodes; a forward edge (branch, or a
  // forward-pointing loop exit) gets a gentle bow so it's still visibly
  // distinct from a plain straight line.
  const bow = backward ? Math.max(50, Math.abs(endY - startY) / 2 + 40) : 34;
  const midX = (startX + endX) / 2;
  const midY = backward ? Math.max(startY, endY) + bow : (startY + endY) / 2 - bow;

  const path = svgEl("path");
  path.setAttribute("class", `graph-edge ${edgeKindClass(edge)}`);
  path.setAttribute("d", `M ${startX} ${startY} Q ${midX} ${midY} ${endX} ${endY}`);
  path.setAttribute(
    "marker-end",
    edgeKindClass(edge) === "loop" ? "url(#arrow-loop)" : "url(#arrow-branch)"
  );
  g.appendChild(path);

  if (edge.label) {
    const label = svgEl("text");
    label.setAttribute("class", `graph-edge-label ${edgeKindClass(edge)}`);
    label.setAttribute("x", String(midX));
    label.setAttribute("y", String(midY - (backward ? -14 : 6)));
    label.setAttribute("text-anchor", "middle");
    label.textContent = edge.label;
    g.appendChild(label);
  }

  return g;
}

/** A loop's exit_to === "END" has no real destination node — drawn as a
 * short stub with a terminal marker next to the source node instead of a
 * full edge into the grid (LOOP_EXIT_END is never a key in `positions`). */
function renderEndStub(edge: GraphEdge, from: NodePosition, startYOffset: number): SVGGElement {
  const g = svgEl("g");
  g.setAttribute("class", "graph-edge-group loop end-stub");
  g.setAttribute("data-edge-kind", edge.kind);
  if (edge.loopId) g.setAttribute("data-loop-id", edge.loopId);

  const startX = from.x + NODE_WIDTH;
  const startY = from.y + startYOffset;
  const endX = startX + END_STUB_LINE_WIDTH;

  const line = svgEl("line");
  line.setAttribute("class", "graph-edge loop");
  line.setAttribute("x1", String(startX));
  line.setAttribute("y1", String(startY));
  line.setAttribute("x2", String(endX));
  line.setAttribute("y2", String(startY));
  line.setAttribute("marker-end", "url(#arrow-loop)");
  g.appendChild(line);

  const label = svgEl("text");
  label.setAttribute("class", "graph-edge-label loop");
  label.setAttribute("x", String(startX + 6));
  label.setAttribute("y", String(startY - 6));
  label.textContent = edge.label ?? "END";
  g.appendChild(label);

  return g;
}

function renderDefs(): SVGDefsElement {
  const defs = svgEl("defs");
  const markers: Array<[id: string, className: string]> = [
    ["arrow-plain", "plain"],
    ["arrow-branch", "branch"],
    ["arrow-loop", "loop"],
  ];
  for (const [id, className] of markers) {
    const marker = svgEl("marker");
    marker.setAttribute("id", id);
    marker.setAttribute("class", `graph-arrow ${className}`);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = svgEl("path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  return defs;
}

/**
 * Renders a pipeline's structure as an inline SVG diagram — every node
 * and every edge from `graph`, with plain/branch/loop edges visually
 * distinct (FR-001, FR-003, FR-006, FR-007). Optional live `state` support
 * (per-node status, taken routes, loop progress, connection errors) is
 * layered on afterwards by applyGraphViewState() (T023), not here — this
 * function always draws the same static structure regardless of any run
 * in progress, matching User Story 1/2's "no prompt sent" independent
 * test.
 */
export function renderGraphSvg(graph: GraphModel): SVGSVGElement {
  const layout = computeLayout(graph);
  const ports = computeEdgePorts(graph);

  const svg = svgEl("svg");
  svg.setAttribute("class", "graph-svg");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${graph.pipelineName} pipeline structure diagram`);

  svg.appendChild(renderDefs());

  const edgeLayer = svgEl("g");
  edgeLayer.setAttribute("class", "graph-edge-layer");
  for (const edge of graph.edges) {
    const from = layout.positions.get(edge.from);
    if (!from) continue; // defensive — every edge's `from` is always a real node
    const startY = ports.startY(edge);
    if (edge.to === LOOP_EXIT_END) {
      edgeLayer.appendChild(renderEndStub(edge, from, startY));
      continue;
    }
    const to = layout.positions.get(edge.to);
    if (!to) continue;
    const endY = ports.endY(edge);
    edgeLayer.appendChild(
      edge.kind === "plain"
        ? renderPlainEdge(edge, from, to, startY, endY)
        : renderCurvedEdge(edge, from, to, startY, endY)
    );
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = svgEl("g");
  nodeLayer.setAttribute("class", "graph-node-layer");
  for (const node of graph.nodes) {
    const pos = layout.positions.get(node.id);
    if (!pos) continue;
    nodeLayer.appendChild(renderNodeEl(node, pos));
  }
  svg.appendChild(nodeLayer);

  return svg;
}

/**
 * An inline error marker for the graph container — shown when a
 * pipeline's structure fails to load, or when a live run's connection is
 * lost (FR-015 / spec.md Clarification 1). Deliberately a plain element
 * rather than part of the SVG diagram so it can be shown even when no
 * diagram has ever successfully rendered yet.
 */
export function renderGraphErrorMarker(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "graph-error";
  el.textContent = message;
  return el;
}

const NODE_STATUS_CLASSES = ["status-not-started", "status-running", "status-complete", "status-failed"];

/**
 * Layers live status from `state` onto an already-rendered graph
 * container (as returned by `renderGraphSvg` and appended into the DOM) —
 * per-node not-started/running/complete/failed styling, taken-vs-not-taken
 * branch route highlighting, live loop iteration counts, and the
 * connection-error marker (FR-009, FR-010, FR-011, FR-012, FR-015). Safe
 * to call repeatedly as `state` changes — it only ever adds/removes
 * classes and updates label text on the existing elements rather than
 * re-rendering the diagram, so scroll/pan position (FR-016) is preserved
 * across every live update during a run.
 */
export function applyGraphViewState(container: HTMLElement, state: GraphViewState): void {
  const svg = container.querySelector<SVGSVGElement>(".graph-svg");
  if (svg) {
    for (const node of state.graph.nodes) {
      const nodeEl = svg.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!nodeEl) continue;
      nodeEl.classList.remove(...NODE_STATUS_CLASSES);
      nodeEl.classList.add(`status-${state.nodeStatus[node.id] ?? "not-started"}`);
    }

    for (const edgeEl of svg.querySelectorAll<SVGGElement>("[data-branch-id]")) {
      const branchId = edgeEl.getAttribute("data-branch-id")!;
      const to = edgeEl.getAttribute("data-edge-to")!;
      const outcome = state.branchOutcomes[branchId];
      edgeEl.classList.toggle("route-taken", outcome?.takenTo === to);
      edgeEl.classList.toggle("route-not-taken", outcome !== undefined && outcome.takenTo !== to);
    }

    for (const [loopId, progress] of Object.entries(state.loopProgress)) {
      const continueEdge = svg.querySelector<SVGGElement>(
        `[data-loop-id="${CSS.escape(loopId)}"][data-edge-kind="loop-continue"]`
      );
      const label = continueEdge?.querySelector<SVGTextElement>(".graph-edge-label");
      if (label) {
        label.textContent = `${loopId} — iteration ${progress.iteration}/${progress.maxIterations}${progress.exhausted ? " (exhausted)" : ""}`;
      }
    }
  }

  const existingError = container.querySelector(".graph-error");
  if (state.connectionError) {
    if (existingError) {
      existingError.textContent = state.connectionError;
    } else {
      container.appendChild(renderGraphErrorMarker(state.connectionError));
    }
  } else {
    existingError?.remove();
  }
}

/**
 * Adds click-and-drag panning to a scrollable container, on top of its
 * native scrollbars/wheel scrolling — FR-016's "basic scroll/pan, no zoom
 * controls" for diagrams larger than the viewport. Idempotent-safe to
 * call once at startup on the graph container (not per-render): it
 * listens on the container itself, not its contents, so it keeps working
 * across every renderGraphSvg() re-render.
 */
export function enableDragPan(container: HTMLElement): void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  container.addEventListener("mousedown", (e: MouseEvent) => {
    // Only the primary button, and only when there's actually overflow to
    // pan — otherwise this would swallow clicks on a diagram that fits.
    if (e.button !== 0) return;
    if (
      container.scrollWidth <= container.clientWidth &&
      container.scrollHeight <= container.clientHeight
    ) {
      return;
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startScrollLeft = container.scrollLeft;
    startScrollTop = container.scrollTop;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    container.scrollLeft = startScrollLeft - (e.clientX - startX);
    container.scrollTop = startScrollTop - (e.clientY - startY);
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });
}
