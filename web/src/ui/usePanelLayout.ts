import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  DEFAULT_LAYOUT,
  DEFAULT_WIDTH,
  PANEL_LAYOUT_STORAGE_KEY,
  RAIL_WIDTH,
  clampWidth,
  dragWidth,
  isStacked,
  openSection,
  readPanelLayout,
  resizeSplit,
  shownHidden,
  toggleSection,
} from "./panelLayout";
import type { PanelLayout, SectionId } from "./panelLayout";

export interface PanelLayoutApi {
  layout: PanelLayout;
  /** The width as shown: the chosen one, fitted to the window. */
  width: number;
  /** A window 960px wide or less: everything stacks; no hiding or resizing. */
  stacked: boolean;
  /** Shown as the rail. */
  hidden: boolean;
  /** Sets --panel-w, the panel's grid column. */
  style: CSSProperties;
  toggleSection(id: SectionId): void;
  openSection(id: SectionId): void;
  resizeSplit(above: SectionId, below: SectionId, heights: { above: number; below: number }, dy: number): void;
  /** Dragging the edge (below 240px hides the panel). */
  dragWidth(px: number): void;
  resetWidth(): void;
  setHidden(hidden: boolean): void;
}

function load(): PanelLayout {
  try {
    return readPanelLayout(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_LAYOUT; // storage unavailable (private mode, blocked) — defaults are fine
  }
}

/** The left panel's layout (see panelLayout.ts), remembered in this
 * browser; ⌘\ / Ctrl+\ hides or shows the panel from anywhere. */
export function usePanelLayout(): PanelLayoutApi {
  const [layout, setLayout] = useState<PanelLayout>(load);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const update = useCallback((change: (current: PanelLayout) => PanelLayout) => {
    setLayout((current) => {
      const next = change(current);
      if (next === current) return current;
      try {
        window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // not remembered — still applied for this page
      }
      return next;
    });
  }, []);

  const stacked = isStacked(windowWidth);
  const hidden = shownHidden(layout, windowWidth);
  const width = clampWidth(layout.width, windowWidth);

  useEffect(() => {
    if (stacked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        update((l) => ({ ...l, hidden: !l.hidden }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stacked, update]);

  return {
    layout,
    width,
    stacked,
    hidden,
    style: { "--panel-w": `${hidden ? RAIL_WIDTH : width}px` } as CSSProperties,
    toggleSection: useCallback((id) => update((l) => toggleSection(l, id)), [update]),
    openSection: useCallback((id) => update((l) => openSection(l, id)), [update]),
    resizeSplit: useCallback(
      (above, below, heights, dy) => update((l) => resizeSplit(l, above, below, heights, dy)),
      [update]
    ),
    dragWidth: useCallback((px) => update((l) => dragWidth(l, px, window.innerWidth)), [update]),
    resetWidth: useCallback(() => update((l) => ({ ...l, width: DEFAULT_WIDTH, hidden: false })), [update]),
    setHidden: useCallback((next) => update((l) => (l.hidden === next ? l : { ...l, hidden: next })), [update]),
  };
}
