import type { ReactNode } from "react";

export type PanelTab = "chat" | "settings" | "add" | "messages" | "tests";

export const PANEL_TABS: { id: PanelTab; label: string; title: string }[] = [
  { id: "chat", label: "Chat", title: "The conversation with this pipeline" },
  { id: "settings", label: "Settings", title: "The selected node — or the pipeline, with nothing selected" },
  { id: "add", label: "Add", title: "Add a node: blank, or from a preset" },
  { id: "messages", label: "Messages", title: "What every node received and replied, per run" },
  { id: "tests", label: "Tests", title: "Test cases and model comparisons" },
];

/**
 * The one panel beside the canvas: a tab for everything that isn't the
 * graph itself, and the message box below them — so a message can be sent
 * from any tab.
 */
export function SidePanel(props: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** Shown after a tab's label — e.g. a pulsing dot while it's busy. */
  badges?: Partial<Record<PanelTab, ReactNode>>;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <aside className="side-panel" aria-label="Panel">
      <div className="panel-tabs" role="tablist" aria-label="Panel">
        {PANEL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`panel-tab-${t.id}`}
            aria-selected={props.tab === t.id}
            aria-controls="panel-body"
            title={t.title}
            className={props.tab === t.id ? "tab active" : "tab"}
            onClick={() => props.onTab(t.id)}
          >
            {t.label}
            {props.badges?.[t.id]}
          </button>
        ))}
      </div>
      <div className="panel-body" id="panel-body" role="tabpanel" aria-labelledby={`panel-tab-${props.tab}`}>
        {props.children}
      </div>
      <div className="panel-footer">{props.footer}</div>
    </aside>
  );
}
