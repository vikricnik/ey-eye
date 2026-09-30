import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

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
  // Unmounted mid-drag (dragging the panel's edge far left hides it, and
  // the edge with it), pointerup never reaches it: the drag's body class
  // would stay, and with it the resize cursor and no text selection.
  useEffect(() => () => document.body.classList.remove("resizing-x", "resizing-y"), []);

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
