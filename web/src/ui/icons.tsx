import type { ReactNode } from "react";

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

/** The left panel's section icons (and its rail's): 15px, stroked in the
 * current text color. */
function StrokeIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function NodeIcon() {
  return (
    <StrokeIcon>
      <rect x="3" y="4" width="10" height="8" rx="1.5" />
      <circle cx="8" cy="2.5" r="1" />
      <circle cx="8" cy="13.5" r="1" />
    </StrokeIcon>
  );
}

export function ChatIcon() {
  return (
    <StrokeIcon>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </StrokeIcon>
  );
}

export function PipelineIcon() {
  return (
    <StrokeIcon>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5v6M5.4 4.3l5.2 3" />
    </StrokeIcon>
  );
}

export function TestsIcon() {
  return (
    <StrokeIcon>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8.2l2 2 4-4.4" />
    </StrokeIcon>
  );
}

export function AddNodeIcon() {
  return (
    <StrokeIcon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.5v5M5.5 8h5" />
    </StrokeIcon>
  );
}

export function PanelHideIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M11 6l-2 2 2 2" />
    </StrokeIcon>
  );
}

export function PanelShowIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M9 6l2 2-2 2" />
    </StrokeIcon>
  );
}
