import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { PanelSection } from "./PanelSection";
import { openAbove, openShares } from "./panelLayout";
import type { SectionId } from "./panelLayout";
import type { PanelLayoutApi } from "./usePanelLayout";
import { PanelRail } from "./PanelRail";
import { Splitter } from "./Splitter";
import type { StateTone } from "./sectionSummaries";

/** One section as App describes it: its header line and its content. */
export interface PanelSectionSpec {
  id: SectionId;
  title: string;
  detail?: string | undefined;
  summary: string;
  icon: ReactNode;
  busy?: boolean;
  fill?: boolean;
  preview?: ReactNode;
  content: ReactNode;
}

/**
 * The one panel, on the left: the header (what the top bar held), the
 * notices, the sections — any number open, sharing the height, each
 * scrolling on its own — and the message box docked at the bottom.
 */
export function LeftPanel(props: {
  panel: PanelLayoutApi;
  header: ReactNode;
  notices: ReactNode;
  sections: PanelSectionSpec[];
  /** Shown instead of the sections before a pipeline has loaded. */
  placeholder: ReactNode;
  dock: ReactNode;
  /** The pipeline's state, for the rail's dot. */
  state: { tone: StateTone; label: string };
}) {
  const { panel } = props;
  const { layout } = panel;
  const elements = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const shares = openShares(layout);

  /** An open section and the open one above it, with their heights now. */
  const pair = (id: SectionId) => {
    const above = openAbove(layout, id);
    const aboveEl = above ? elements.current[above] : null;
    const el = elements.current[id];
    if (!above || !aboveEl || !el) return null;
    return { above, heights: { above: aboveEl.getBoundingClientRect().height, below: el.getBoundingClientRect().height } };
  };

  const startSplit = (id: SectionId, e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const start = pair(id);
    if (!start) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const move = (ev: globalThis.PointerEvent) => panel.resizeSplit(start.above, id, start.heights, ev.clientY - startY);
    const end = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", end);
      head.removeEventListener("pointercancel", end);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  };

  const keySplit = (id: SectionId, dy: number) => {
    const now = pair(id);
    if (now) panel.resizeSplit(now.above, id, now.heights, dy);
  };

  const { hidden } = panel;
  // Hidden, the panel is the rail, but everything else stays mounted (and
  // hidden) — a half-typed message, the Tests view's state and the scroll
  // positions are there when it's shown again. The notices stay visible:
  // they float beside the rail, so an error isn't missed.
  return (
    <>
    <aside
      className={hidden ? "left-panel hidden" : "left-panel"}
      aria-label={hidden ? "Pipeline panel (hidden)" : "Pipeline panel"}
    >
      {hidden && (
        <PanelRail
          sections={props.sections.map((s) => ({
            id: s.id,
            title: s.detail ? `${s.title} · ${s.detail}` : s.title,
            summary: s.summary,
            icon: s.icon,
            open: layout.open[s.id],
            busy: s.busy ?? false,
          }))}
          state={props.state}
          onShow={() => panel.setHidden(false)}
          onOpenSection={(id) => {
            panel.openSection(id);
            panel.setHidden(false);
          }}
        />
      )}
      <header className="panel-head" hidden={hidden}>{props.header}</header>
      <div className="panel-notices">{props.notices}</div>
      <div className="psections" hidden={hidden}>
        {props.sections.length === 0
          ? props.placeholder
          : props.sections.map((s) => (
              <PanelSection
                key={s.id}
                ref={(el) => {
                  elements.current[s.id] = el;
                }}
                title={s.title}
                detail={s.detail}
                summary={s.summary}
                icon={s.icon}
                busy={s.busy ?? false}
                fill={s.fill ?? false}
                preview={s.preview}
                open={layout.open[s.id]}
                weight={shares[s.id]}
                resizable={layout.open[s.id] && openAbove(layout, s.id) !== null}
                onToggle={() => panel.toggleSection(s.id)}
                onSplitStart={(e) => startSplit(s.id, e)}
                onSplitKey={(dy) => keySplit(s.id, dy)}
              >
                {s.content}
              </PanelSection>
            ))}
      </div>
      <div className="dock" hidden={hidden}>{props.dock}</div>
    </aside>
    {/* The right edge: drag to resize (below 240px hides it), double-click
        to reset, ←/→ when focused. Not while stacked. */}
    {!hidden && !panel.stacked && (
      <Splitter
        axis="x"
        grow={1}
        value={panel.width}
        onResize={panel.dragWidth}
        onReset={panel.resetWidth}
        label="Resize the panel"
        className="splitter-panel-edge"
      />
    )}
    </>
  );
}
