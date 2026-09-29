/** A one-line hint across the top of the canvas while a pipeline has
 * nothing to connect yet, or nothing connected — the two moments someone
 * building it may not know the next step. Null otherwise. */
export function canvasHint(canvas: { nodes: number; edges: number; editable: boolean }): string | null {
  if (!canvas.editable) return null;
  if (canvas.nodes === 1) return "Add more nodes with + Add node — drag one onto the canvas, or click it.";
  if (canvas.nodes > 1 && canvas.edges === 0) {
    return "Connect nodes: drag from a node's bottom dot to another node's top dot.";
  }
  return null;
}
