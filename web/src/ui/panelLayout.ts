/** The panel's sections, top to bottom. */
export type SectionId = "node" | "chat" | "pipeline" | "tests" | "add";
export const SECTION_ORDER: readonly SectionId[] = ["node", "chat", "pipeline", "tests", "add"];

/** How the left panel is laid out — what's remembered in the browser. */
export interface PanelLayout {
  /** The width someone chose; the window only limits what's shown (clampWidth). */
  width: number;
  /** Hidden to the rail (a stacked panel is never hidden — see shownHidden). */
  hidden: boolean;
  /** Which sections are open; any number can be. */
  open: Record<SectionId, boolean>;
  /** Each open section's share of the panel's height (relative). */
  weights: Record<SectionId, number>;
}

export const DEFAULT_WIDTH = 440;
export const MIN_WIDTH = 340;
export const MAX_WIDTH = 760;
/** Dragging the edge narrower than this hides the panel. */
export const HIDE_BELOW = 240;
/** The hidden panel's rail. */
export const RAIL_WIDTH = 48;
/** No open section gets shorter — a header and a line or two of content. */
export const MIN_SECTION_HEIGHT = 76;
/** At or below this window width everything stacks — keep in step with the
 * `@media (max-width: 960px)` block in style.css. */
export const STACKED_MAX_WIDTH = 960;

export const PANEL_LAYOUT_STORAGE_KEY = "llm-pipeline.panel-layout.v1";

export const DEFAULT_LAYOUT: PanelLayout = {
  width: DEFAULT_WIDTH,
  hidden: false,
  open: { node: true, chat: true, pipeline: false, tests: false, add: false },
  weights: { node: 1, chat: 1.2, pipeline: 1, tests: 1, add: 0.8 },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The layout as saved; anything missing or unreadable is its default,
 * field by field (and section by section). */
export function readPanelLayout(raw: string | null): PanelLayout {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "{}");
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!isRecord(saved)) return DEFAULT_LAYOUT;
  const open = isRecord(saved.open) ? saved.open : {};
  const weights = isRecord(saved.weights) ? saved.weights : {};
  return {
    width: typeof saved.width === "number" && Number.isFinite(saved.width) ? saved.width : DEFAULT_LAYOUT.width,
    hidden: typeof saved.hidden === "boolean" ? saved.hidden : DEFAULT_LAYOUT.hidden,
    open: Object.fromEntries(
      SECTION_ORDER.map((id) => {
        const value = open[id];
        return [id, typeof value === "boolean" ? value : DEFAULT_LAYOUT.open[id]];
      })
    ) as Record<SectionId, boolean>,
    weights: Object.fromEntries(
      SECTION_ORDER.map((id) => {
        const value = weights[id];
        return [id, typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_LAYOUT.weights[id]];
      })
    ) as Record<SectionId, number>,
  };
}

/** The widest the panel may be in a window this wide: 760px, or 60% of it. */
function maxWidth(windowWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(windowWidth * 0.6)));
}

/** A width as shown in a window this wide. */
export function clampWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth(windowWidth)));
}

/** Dragging the edge to `width`: below 240px hides the panel (keeping the
 * width it comes back at); otherwise that width, within the limits. */
export function dragWidth(layout: PanelLayout, width: number, windowWidth: number): PanelLayout {
  if (width < HIDE_BELOW) return layout.hidden ? layout : { ...layout, hidden: true };
  return { ...layout, hidden: false, width: clampWidth(width, windowWidth) };
}

export function toggleSection(layout: PanelLayout, id: SectionId): PanelLayout {
  return { ...layout, open: { ...layout.open, [id]: !layout.open[id] } };
}

export function openSection(layout: PanelLayout, id: SectionId): PanelLayout {
  return layout.open[id] ? layout : { ...layout, open: { ...layout.open, [id]: true } };
}

/** The nearest open section above `id` — the one dragging `id`'s header
 * re-splits the height with — or null. */
export function openAbove(layout: PanelLayout, id: SectionId): SectionId | null {
  for (let i = SECTION_ORDER.indexOf(id) - 1; i >= 0; i--) {
    const candidate = SECTION_ORDER[i]!;
    if (layout.open[candidate]) return candidate;
  }
  return null;
}

/** Moves the boundary between two adjacent open sections `dy` px down,
 * from the `heights` they had when the drag started. Both keep at least
 * 76px, and their combined weight stays the same, so the other open
 * sections keep their share. Two sections too short for that stay as
 * they are. */
export function resizeSplit(
  layout: PanelLayout,
  above: SectionId,
  below: SectionId,
  heights: { above: number; below: number },
  dy: number
): PanelLayout {
  const total = heights.above + heights.below;
  if (total < 2 * MIN_SECTION_HEIGHT) return layout;
  const a = Math.min(Math.max(heights.above + dy, MIN_SECTION_HEIGHT), total - MIN_SECTION_HEIGHT);
  const combined = layout.weights[above] + layout.weights[below];
  return {
    ...layout,
    weights: { ...layout.weights, [above]: (combined * a) / total, [below]: (combined * (total - a)) / total },
  };
}

/** Each open section's share of the panel's height, adding up to 1 (0 for
 * a folded one) — the flex-grow values. The weights themselves can add up
 * to less than 1 after a few drags, and flex-grow values that do leave
 * part of the height empty. */
export function openShares(layout: PanelLayout): Record<SectionId, number> {
  const open = SECTION_ORDER.filter((id) => layout.open[id]);
  const total = open.reduce((sum, id) => sum + layout.weights[id], 0);
  const shares = {} as Record<SectionId, number>;
  for (const id of SECTION_ORDER) {
    shares[id] = !layout.open[id] ? 0 : total > 0 ? layout.weights[id] / total : 1 / open.length;
  }
  return shares;
}

export function isStacked(windowWidth: number): boolean {
  return windowWidth <= STACKED_MAX_WIDTH;
}

/** Whether the panel shows as the rail: never while stacked — the saved
 * choice waits for a wide window. */
export function shownHidden(layout: PanelLayout, windowWidth: number): boolean {
  return layout.hidden && !isStacked(windowWidth);
}
