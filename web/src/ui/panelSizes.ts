/** Widths of the two columns beside the canvas. */
export interface PanelSizes {
  /** The settings column: the selected node's, dependency's or pipeline's settings. */
  settings: number;
  /** The run panel: Chat and Tests. */
  run: number;
}

/** Where the settings column goes: its own grid column; floating over the
 * canvas's right edge, when docking would leave the canvas too narrow; or
 * stacked with everything else in a narrow window. */
export type SettingsPlacement = "docked" | "floating" | "stacked";

export const DEFAULT_PANEL_SIZES: PanelSizes = { settings: 380, run: 420 };

// v3: the settings and run columns (v2 stored one panel width).
export const PANEL_SIZES_STORAGE_KEY = "llm-pipeline.panel-sizes.v3";

/** Narrower, and a column's fields stop fitting. */
const MIN_COLUMN_WIDTH = 320;
/** Smallest the canvas may get when a column grows. */
const MIN_CANVAS_WIDTH = 280;
/** Docked, the settings column must leave the canvas at least this much —
 * less, and it floats over the canvas instead. */
const MIN_DOCKED_CANVAS_WIDTH = 480;
/** At or below this window width everything stacks — keep in step with
 * the `@media (max-width: 960px)` block in style.css. */
const STACKED_MAX_WIDTH = 960;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Keeps both columns usable, and leaves the canvas room, in a window this wide. */
export function clampPanelSizes(sizes: PanelSizes, width: number): PanelSizes {
  const run = clamp(sizes.run, MIN_COLUMN_WIDTH, width - MIN_CANVAS_WIDTH);
  const settings = clamp(sizes.settings, MIN_COLUMN_WIDTH, width - run - MIN_CANVAS_WIDTH);
  return { settings, run };
}

/** The widths someone chose, as saved — not fitted to any window. A width
 * that's missing or unreadable is its default. */
export function readPanelSizes(raw: string | null): PanelSizes {
  try {
    const saved = JSON.parse(raw ?? "{}") as Partial<Record<keyof PanelSizes, unknown>>;
    return {
      settings: typeof saved.settings === "number" ? saved.settings : DEFAULT_PANEL_SIZES.settings,
      run: typeof saved.run === "number" ? saved.run : DEFAULT_PANEL_SIZES.run,
    };
  } catch {
    return DEFAULT_PANEL_SIZES; // unreadable (or "null") — defaults are fine
  }
}

/** Docked while the canvas keeps 480px beside both columns, else floating;
 * stacked in a narrow window. `sizes` are the widths as shown (clamped). */
export function settingsPlacement(sizes: PanelSizes, width: number): SettingsPlacement {
  if (width <= STACKED_MAX_WIDTH) return "stacked";
  return width - sizes.settings - sizes.run >= MIN_DOCKED_CANVAS_WIDTH ? "docked" : "floating";
}
