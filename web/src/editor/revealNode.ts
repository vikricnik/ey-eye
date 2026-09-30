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

/** Whether a node's center is outside the canvas. Only then is it panned
 * into view: a node that's merely cut off at an edge is left where the user
 * put it. */
export function needsReveal(node: FlowRect, viewport: Viewport, visible: { width: number; height: number }): boolean {
  const x = (node.x + node.width / 2) * viewport.zoom + viewport.x;
  const y = (node.y + node.height / 2) * viewport.zoom + viewport.y;
  return x < 0 || y < 0 || x > visible.width || y > visible.height;
}

/** The flow point to hand React Flow's setCenter to bring a node into the
 * middle of the canvas. */
export function revealCenter(node: FlowRect): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
