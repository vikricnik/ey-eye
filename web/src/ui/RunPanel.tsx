import type { ReactNode } from "react";

export type PanelTab = "chat" | "tests";

export const PANEL_TABS: { id: PanelTab; label: string; title: string }[] = [
  { id: "chat", label: "Chat", title: "The conversation with this pipeline, and each run's trace" },
  { id: "tests", label: "Tests", title: "Test cases and model comparisons" },
];

/**
 * The run panel, at the right: Chat and Tests, and the message box under
 * Chat (Tests has its own Run buttons, for test cases). Settings have their
 * own column (editor/SettingsColumn.tsx), so nothing here switches tabs
 * on its own.
 */
export function RunPanel(props: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** Shown after a tab's label — e.g. a pulsing dot while it's busy. */
  badges?: Partial<Record<PanelTab, ReactNode>>;
  children: ReactNode;
  footer: ReactNode;
  /** Hides the footer without unmounting it, so what's typed there is kept. */
  footerHidden?: boolean;
}) {
  return (
    <aside className="run-panel" aria-label="Run">
      <div className="panel-tabs" role="tablist" aria-label="Run">
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
      <div className="panel-footer" hidden={props.footerHidden}>
        {props.footer}
      </div>
    </aside>
  );
}
