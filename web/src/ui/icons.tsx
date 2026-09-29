/** A settings cog, in the current text color. Drawn rather than the ⚙
 * character, which some systems render as a color emoji. */
export function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {/* Eight teeth: a thick dashed ring (circumference 2π·5.6 ≈ 35.2 = 8 × 4.4). */}
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeDasharray="2.2 2.2" />
      {/* The body, with the hole in the middle. */}
      <circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}
