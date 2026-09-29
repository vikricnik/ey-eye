import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A second line: what the item does, or why it's unavailable. */
  detail?: string | undefined;
  /** Starts a new group, below a divider. */
  separated?: boolean;
  /** Destructive — shown in the danger color. */
  danger?: boolean;
}

/** Where a key moves the active item in a menu of `count` items, or null
 * for a key the menu doesn't handle. The arrows wrap around. */
export function menuIndexFor(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * A button that opens a menu of actions, with the ARIA menu button
 * keyboard contract: Enter, Space or ↓ opens it on the first item (↑ on
 * the last); ↑ ↓ Home End move; Enter or Space picks; Escape closes it and
 * returns to the button; Tab or a click elsewhere closes it. Unavailable
 * items stay in the list (aria-disabled), so their reason can be read.
 * Positioned like the display menu — absolutely, under its button — so it
 * needs no anchor positioning.
 */
export function MenuButton(props: {
  label: string;
  items: MenuItem[];
  /** For a button whose label is only a symbol, e.g. "⋯". */
  ariaLabel?: string;
  /** Show ▾ after the label (the default). */
  caret?: boolean;
  /** Which edge of the button the menu lines up with: "end" opens it
   * leftwards, for a button near the right edge of a panel. */
  align?: "start" | "end";
}) {
  const { label, items, caret = true, align = "start" } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Roving focus: the active item has it while the menu is open.
  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const next = menuIndexFor(e.key, active, items.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not also "stop the run" (App's Esc)
      close(true);
    } else if (e.key === "Tab") {
      close(false); // focus moves on as usual
    }
  };

  return (
    <div className="menu-button" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="ghost"
        id={`${id}-button`}
        aria-label={props.ariaLabel}
        title={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openAt(e.key === "ArrowDown" ? 0 : items.length - 1);
          }
        }}
      >
        {label}
        {caret && (
          <span className="caret" aria-hidden="true">
            ▾
          </span>
        )}
      </button>
      {open && (
        <div className={align === "end" ? "menu align-end" : "menu"} role="menu" id={`${id}-menu`} aria-labelledby={`${id}-button`} onKeyDown={onMenuKeyDown}>
          {items.map((item, i) => (
            <Fragment key={item.label}>
              {item.separated && <div role="separator" className="menu-separator" />}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                className={item.danger ? "menu-item danger" : "menu-item"}
                onClick={() => {
                  if (item.disabled) return;
                  close(true);
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.detail && <span className="menu-detail">{item.detail}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
