import { useState } from "react";
import type { ReactNode } from "react";

/** Which settings sections were left open, by section id — the same for
 * every node, so opening Routing once keeps it open while you step
 * through nodes. Kept in this browser. */
const STORAGE_KEY = "llm-pipeline.inspector-sections";

/** The saved open/closed states; anything unreadable counts as unsaved. */
export function readOpenSections(raw: string | null): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "boolean"));
  } catch {
    return {};
  }
}

function load(): Record<string, boolean> {
  try {
    return readOpenSections(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {}; // storage unavailable (private mode, blocked)
  }
}

function remember(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), [id]: open }));
  } catch {
    // not remembered — still applied for this page
  }
}

/**
 * A foldable group of settings (a <details>, so the keyboard and screen
 * readers handle it natively). `summary` says what's inside while it's
 * folded; `defaultOpen` applies until it's first opened or closed.
 */
export function Section(props: {
  id: string;
  title: string;
  summary?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => load()[props.id] ?? props.defaultOpen);
  return (
    <details
      className="settings-section"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next === open) return; // React setting `open` fires toggle too
        setOpen(next);
        remember(props.id, next);
      }}
    >
      <summary>
        <span className="section-title">{props.title}</span>
        {props.summary && <span className="section-summary">{props.summary}</span>}
      </summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}
