import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

export interface PanelSizes {
  /** Width of the side panel beside the canvas. */
  panel: number;
}

export const DEFAULT_PANEL_SIZES: PanelSizes = { panel: 440 };

/** Smallest the canvas may get when the panel grows. */
const MIN_CANVAS_WIDTH = 280;
const MIN_PANEL_WIDTH = 320;
// v2: one side panel (earlier versions stored three panel sizes).
const STORAGE_KEY = "llm-pipeline.panel-sizes.v2";

/** Keeps the panel within a sensible range for the current window. */
export function clampPanelSizes(sizes: PanelSizes, width: number = window.innerWidth): PanelSizes {
  const panel = Math.min(Math.max(sizes.panel, MIN_PANEL_WIDTH), Math.max(MIN_PANEL_WIDTH, width - MIN_CANVAS_WIDTH));
  return { panel };
}

function loadSizes(): PanelSizes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PANEL_SIZES;
    const saved = JSON.parse(raw) as Partial<PanelSizes>;
    return clampPanelSizes({ ...DEFAULT_PANEL_SIZES, ...saved });
  } catch {
    return DEFAULT_PANEL_SIZES; // storage unavailable (private mode, blocked) — defaults are fine
  }
}

/** The panel's width, remembered in this browser, applied as the CSS
 * variable the app grid uses. */
export function usePanelSizes(): {
  sizes: PanelSizes;
  setSize: (panel: keyof PanelSizes, px: number) => void;
  resetSize: (panel: keyof PanelSizes) => void;
  style: CSSProperties;
} {
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);

  const update = useCallback((next: (current: PanelSizes) => PanelSizes) => {
    setSizes((current) => {
      const clamped = clampPanelSizes(next(current));
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clamped));
      } catch {
        // not persisted — still applied for this page
      }
      return clamped;
    });
  }, []);

  // A smaller window may no longer fit the saved sizes — re-clamp.
  useEffect(() => {
    const onResize = () => update((s) => s);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [update]);

  return {
    sizes,
    setSize: useCallback((panel, px) => update((s) => ({ ...s, [panel]: Math.round(px) })), [update]),
    resetSize: useCallback((panel) => update((s) => ({ ...s, [panel]: DEFAULT_PANEL_SIZES[panel] })), [update]),
    style: { "--panel-w": `${sizes.panel}px` } as CSSProperties,
  };
}

/**
 * A draggable border between two panels. `axis="x"` is a vertical bar that
 * resizes a width, `axis="y"` a horizontal bar that resizes a height.
 * `grow` says which drag direction makes the panel bigger: +1 when the
 * panel is before the bar (left/top), -1 when it is after it (right/bottom).
 * Arrow keys nudge by 16px (Shift: 64px); double-click resets.
 */
export function Splitter(props: {
  axis: "x" | "y";
  grow: 1 | -1;
  value: number;
  onResize: (px: number) => void;
  onReset: () => void;
  label: string;
  className: string;
}) {
  const { axis, grow, value, onResize } = props;
  const drag = useRef<{ start: number; startValue: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: axis === "x" ? e.clientX : e.clientY, startValue: value };
    setActive(true);
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const position = axis === "x" ? e.clientX : e.clientY;
    onResize(drag.current.startValue + (position - drag.current.start) * grow);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    document.body.classList.remove("resizing-x", "resizing-y");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const [less, more] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (e.key === less) onResize(value - step * grow);
    else if (e.key === more) onResize(value + step * grow);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={props.label}
      aria-valuenow={value}
      tabIndex={0}
      title={`${props.label} — drag to resize, double-click to reset`}
      className={`splitter splitter-${axis} ${props.className}${active ? " active" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
    />
  );
}
