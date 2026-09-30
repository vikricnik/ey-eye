import { useId } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, Ref } from "react";

/**
 * One section of the left panel: a header row — fold/open, title,
 * one-line summary — and its body. Open, it takes its share of the
 * panel's height (`weight`); `resizable` sections (an open one above)
 * re-split the height by dragging the header, or ↑/↓ on it.
 */
export function PanelSection(props: {
  title: string;
  /** What's selected — shown beside the title, as typed. */
  detail?: string | undefined;
  summary: string;
  icon: ReactNode;
  open: boolean;
  weight: number;
  resizable: boolean;
  /** Something's running in it (a pulsing dot). */
  busy: boolean;
  /** The content fills the body and scrolls itself (Chat, node settings). */
  fill: boolean;
  /** Shown under the header while folded (Chat's last exchange). */
  preview?: ReactNode;
  onToggle: () => void;
  onSplitStart: (e: PointerEvent<HTMLElement>) => void;
  onSplitKey: (dy: number) => void;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  const bodyId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // the fold button's own keys
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowUp") props.onSplitKey(-step);
    else if (e.key === "ArrowDown") props.onSplitKey(step);
    else return;
    e.preventDefault();
  };
  return (
    <section
      ref={props.ref}
      className={props.open ? "psec open" : "psec"}
      style={props.open ? { flexGrow: props.weight } : undefined}
      aria-label={props.title}
    >
      <div
        className={props.resizable ? "psec-head resizable" : "psec-head"}
        tabIndex={props.resizable ? 0 : undefined}
        title={props.resizable ? "Drag to change how the height is split (↑ ↓ when focused)" : undefined}
        onPointerDown={props.resizable ? props.onSplitStart : undefined}
        onKeyDown={props.resizable ? onKeyDown : undefined}
      >
        <button
          type="button"
          className="psec-toggle"
          aria-expanded={props.open}
          aria-controls={props.open ? bodyId : undefined}
          onClick={props.onToggle}
        >
          <span className="psec-chev" aria-hidden="true">
            {props.open ? "▾" : "▸"}
          </span>
          <span className="psec-icon">{props.icon}</span>
          <span className="psec-title">{props.title}</span>
          {props.detail && <span className="psec-detail">{props.detail}</span>}
        </button>
        {props.busy && <span className="pulse-dot" aria-hidden="true" />}
        <span className="psec-summary" title={props.summary}>
          {props.summary}
        </span>
        {props.resizable && <span className="psec-grip" aria-hidden="true" />}
      </div>
      {!props.open && props.preview}
      {props.open && (
        <div id={bodyId} className={props.fill ? "psec-body fill" : "psec-body"}>
          {props.children}
        </div>
      )}
    </section>
  );
}
