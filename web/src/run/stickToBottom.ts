/** How close to the end still counts as "at the end" — about a line. */
const THRESHOLD_PX = 40;

/** Whether a scrolling box is showing its end. New content should keep it
 * there; scrolled up, the reader's place is left alone. */
export function isNearBottom(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < THRESHOLD_PX;
}
