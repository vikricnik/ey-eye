import { useCallback, useEffect, useRef, useState } from "react";

export type ThemeSetting = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export interface DisplaySettings {
  theme: ThemeSetting;
  /** Multiplies the browser's default font size (which the user may have
   * changed too) — every rem-sized text in the app follows it. */
  textScale: number;
}

export const TEXT_SCALES = [0.875, 1, 1.125, 1.25, 1.375, 1.5];
const DEFAULTS: DisplaySettings = { theme: "system", textScale: 1 };

/** Also read by the inline script in index.html, which applies the saved
 * settings before the first paint — keep the two in step. */
const STORAGE_KEY = "llm-pipeline.display";

function load(): DisplaySettings {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<DisplaySettings>;
    return {
      theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : "system",
      textScale: TEXT_SCALES.includes(saved.textScale ?? NaN) ? saved.textScale! : 1,
    };
  } catch {
    return DEFAULTS; // storage unavailable (private mode, blocked) — defaults are fine
  }
}

const prefersLight = () => window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;

/** The theme and text size, remembered in this browser and applied to
 * <html> (data-theme, font-size). "system" follows the OS setting live. */
export function useDisplaySettings(): {
  settings: DisplaySettings;
  theme: Theme;
  update: (change: Partial<DisplaySettings>) => void;
} {
  const [settings, setSettings] = useState<DisplaySettings>(load);
  const [systemLight, setSystemLight] = useState(prefersLight);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return;
    const onChange = () => setSystemLight(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme: Theme = settings.theme === "system" ? (systemLight ? "light" : "dark") : settings.theme;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.fontSize = settings.textScale === 1 ? "" : `${settings.textScale * 100}%`;
  }, [theme, settings.textScale]);

  const update = useCallback((change: Partial<DisplaySettings>) => {
    setSettings((current) => {
      const next = { ...current, ...change };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // not remembered — still applied for this page
      }
      return next;
    });
  }, []);

  return { settings, theme, update };
}

const THEME_LABELS: Record<ThemeSetting, string> = { system: "System", light: "Light", dark: "Dark" };

/** "Aa" in the top bar: theme and text size. */
export function DisplayMenu(props: { settings: DisplaySettings; onChange: (change: Partial<DisplaySettings>) => void }) {
  const { settings, onChange } = props;
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const index = TEXT_SCALES.indexOf(settings.textScale);
  const step = (by: number) => {
    const next = TEXT_SCALES[index + by];
    if (next !== undefined) onChange({ textScale: next });
  };

  return (
    <div className="display-menu" ref={menu}>
      <button
        type="button"
        className="ghost icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Display: theme and text size"
        onClick={() => setOpen((o) => !o)}
      >
        Aa
      </button>
      {open && (
        <div className="display-popover" role="dialog" aria-label="Display settings">
          <div className="field">
            <span className="field-label">Theme</span>
            <div className="view-switch" role="radiogroup" aria-label="Theme">
              {(Object.keys(THEME_LABELS) as ThemeSetting[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === t}
                  className={settings.theme === t ? "active" : ""}
                  onClick={() => onChange({ theme: t })}
                >
                  {THEME_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Text size</span>
            <div className="row">
              <button type="button" className="ghost icon" aria-label="Smaller text" disabled={index <= 0} onClick={() => step(-1)}>
                A−
              </button>
              <span className="text-size-value" aria-live="polite">
                {Math.round(settings.textScale * 100)}%
              </span>
              <button
                type="button"
                className="ghost icon"
                aria-label="Larger text"
                disabled={index >= TEXT_SCALES.length - 1}
                onClick={() => step(1)}
              >
                A+
              </button>
              <button type="button" className="link" disabled={settings.textScale === 1} onClick={() => onChange({ textScale: 1 })}>
                reset
              </button>
            </div>
          </div>
          <p className="field-hint">
            Remembered in this browser. Text also follows your browser&apos;s font size; canvas cards scale with the
            canvas zoom, which fits to the text size.
          </p>
        </div>
      )}
    </div>
  );
}
