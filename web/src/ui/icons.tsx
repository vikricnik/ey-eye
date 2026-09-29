/** Auto-layout: one box above two, joined like a dependency tree. Sized
 * for React Flow's control buttons, which fill their icons with currentColor. */
export function AutoLayoutIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="4" y="0.5" width="4" height="3" rx="0.5" />
      <rect x="0.5" y="8.5" width="4" height="3" rx="0.5" />
      <rect x="7.5" y="8.5" width="4" height="3" rx="0.5" />
      <path d="M6 3.5V6M2.5 8.5V6h7v2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

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
