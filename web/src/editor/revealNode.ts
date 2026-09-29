/** A node's box, in flow coordinates. */
export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** React Flow's viewport: where the flow's origin is on screen, and the zoom. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Whether a node's center is outside the part of the canvas that can be
 * seen — the canvas less what covers its right edge (the floating settings
 * column). Only then is it panned into view: a node that's merely cut off
 * at an edge is left where the user put it. */
export function needsReveal(node: FlowRect, viewport: Viewport, visible: { width: number; height: number }): boolean {
  const x = (node.x + node.width / 2) * viewport.zoom + viewport.x;
  const y = (node.y + node.height / 2) * viewport.zoom + viewport.y;
  return x < 0 || y < 0 || x > visible.width || y > visible.height;
}

/** The flow point to hand React Flow's setCenter so the node lands in the
 * middle of the uncovered part of the canvas. setCenter centers a point
 * in the whole canvas; `coveredRight` screen pixels are hidden on the
 * right, so the point is moved right by half of that, in flow units. */
export function revealCenter(node: FlowRect, zoom: number, coveredRight: number): { x: number; y: number } {
  return { x: node.x + node.width / 2 + coveredRight / 2 / zoom, y: node.y + node.height / 2 };
}
