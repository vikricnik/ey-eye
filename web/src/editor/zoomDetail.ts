/**
 * How canvas cards stay readable when the view is zoomed out. Cards are
 * drawn in flow coordinates, so their text shrinks with the zoom. Below
 * COMPACT_BELOW a card shows only its id, model and status, in text scaled
 * up to cancel the zoom — so it reads at the display text size on screen.
 * Both thresholds are relative to the text size, like fitting the view.
 */

/** Share of the text size below which cards switch to their compact form. */
export const COMPACT_BELOW = 0.85;

/** The most compact text is scaled up to cancel the zoom; zoomed out
 * further, it shrinks with the view again. */
export const MAX_TEXT_SCALE = 2.5;

export function isCompact(zoom: number, textScale: number): boolean {
  return zoom < COMPACT_BELOW * textScale;
}

/** The factor a compact card's text is scaled by (see --node-text-scale in style.css). */
export function compactTextScale(zoom: number, textScale: number): number {
  return Math.min(MAX_TEXT_SCALE, Math.max(1, textScale / zoom));
}

/** Fitting the view zooms in no further than the text size (a small
 * pipeline would otherwise fill the canvas with giant cards) and out no
 * further than compact text can make up for — a wide pipeline then extends
 * past the edges instead of becoming unreadable. */
export function fitOptions(textScale: number) {
  return { padding: 0.2, minZoom: textScale / MAX_TEXT_SCALE, maxZoom: textScale };
}
