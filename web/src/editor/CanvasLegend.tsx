import { useEffect, useId, useRef, useState } from "react";

/**
 * "?" in a corner of the canvas: what its colors, lines and marks mean,
 * next to the drawing it explains. A disclosure — the button shows and
 * hides the legend; Escape or a click elsewhere hides it too.
 */
export function CanvasLegend() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      className="canvas-legend"
      ref={wrapper}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation(); // not also "stop the run" (App's Esc)
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="ghost icon"
        aria-expanded={open}
        aria-controls={`${id}-legend`}
        aria-label="Legend"
        title="What the canvas shows"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <div className="legend-panel" id={`${id}-legend`} role="region" aria-label="Legend">
          <h3>Nodes</h3>
          <ul className="legend">
            <li>
              <span className="swatch status-running" /> running
            </li>
            <li>
              <span className="swatch status-complete" /> done — ✓ when zoomed out
            </li>
            <li>
              <span className="swatch status-failed" /> failed — ✕ when zoomed out
            </li>
            <li>
              <span className="output-badge in-legend">output</span> the pipeline&apos;s answer comes from it
            </li>
            <li>
              <span className="swatch problem" /> dashed: invalid (red) or a warning (amber)
            </li>
          </ul>
          <h3>Edges</h3>
          <ul className="legend">
            <li>
              <span className="line plain" /> depends on — drag from a node&apos;s bottom dot to another&apos;s top dot
            </li>
            <li>
              <span className="line branch" /> branch route
            </li>
            <li>
              <span className="line loop" /> loop
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
