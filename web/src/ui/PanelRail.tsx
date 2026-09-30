import type { ReactNode } from "react";
import { PanelShowIcon } from "./icons";
import type { SectionId } from "./panelLayout";
import type { StateTone } from "./sectionSummaries";

/** A section as the rail shows it. */
export interface RailSection {
  id: SectionId;
  title: string;
  summary: string;
  icon: ReactNode;
  open: boolean;
  busy: boolean;
}

/**
 * The hidden panel: a 48px rail — show the panel, see the pipeline's
 * state, or jump straight to a section (which shows the panel with it
 * open). Open sections are marked; running ones pulse.
 */
export function PanelRail(props: {
  sections: RailSection[];
  state: { tone: StateTone; label: string };
  onShow: () => void;
  onOpenSection: (id: SectionId) => void;
}) {
  return (
    <nav className="rail" aria-label="Panel (hidden)">
      <button type="button" className="rail-btn" onClick={props.onShow} title="Show panel (⌘\ / Ctrl+\)" aria-label="Show panel">
        <PanelShowIcon />
      </button>
      <span className={`rail-state ${props.state.tone}`} role="img" aria-label={props.state.label} title={props.state.label} />
      <span className="rail-sep" aria-hidden="true" />
      {props.sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className={s.open ? "rail-btn rail-sec open" : "rail-btn rail-sec"}
          title={`${s.title} · ${s.summary}`}
          aria-label={`${s.title}: ${s.summary}`}
          onClick={() => props.onOpenSection(s.id)}
        >
          {s.icon}
          {s.busy && <span className="pulse-dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  );
}
