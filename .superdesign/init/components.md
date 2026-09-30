# Components — ey-eye web client (`web/`)

Framework: **React 19 + TypeScript**, bundled with **Vite 6**. No component library, no Tailwind: every component is custom and styled by one global stylesheet, `web/src/style.css` (plain CSS with custom properties; see theme.md). Canvas: **@xyflow/react 12** (React Flow). Markdown: marked + DOMPurify.

Button variants are CSS classes on a plain `<button>`: default (filled accent), `.ghost`, `.icon`, `.small`, `.link`, `.danger`, `.danger-solid`; status chips `.chip-status ok|warn|error`; tags `.tag`, `.tag-mini`.

## Section
- Foldable settings section (`<details>`), open/closed remembered in localStorage by id; `summary` shown while folded.

### `web/src/editor/Section.tsx`

```tsx
import { useState } from "react";
import type { ReactNode } from "react";

/** Which settings sections were left open, by section id — the same for
 * every node, so opening Routing once keeps it open while you step
 * through nodes. Kept in this browser. */
const STORAGE_KEY = "llm-pipeline.inspector-sections";

/** The saved open/closed states; anything unreadable counts as unsaved. */
export function readOpenSections(raw: string | null): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "boolean"));
  } catch {
    return {};
  }
}

function load(): Record<string, boolean> {
  try {
    return readOpenSections(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {}; // storage unavailable (private mode, blocked)
  }
}

function remember(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), [id]: open }));
  } catch {
    // not remembered — still applied for this page
  }
}

/**
 * A foldable group of settings (a <details>, so the keyboard and screen
 * readers handle it natively). `summary` says what's inside while it's
 * folded; `defaultOpen` applies until it's first opened or closed.
 */
export function Section(props: {
  id: string;
  title: string;
  summary?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => load()[props.id] ?? props.defaultOpen);
  return (
    <details
      className="settings-section"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next === open) return; // React setting `open` fires toggle too
        setOpen(next);
        remember(props.id, next);
      }}
    >
      <summary>
        <span className="section-title">{props.title}</span>
        {props.summary && <span className="section-summary">{props.summary}</span>}
      </summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}
```

## fields
- Form primitives: Field (label + hint), CommitInput, NumberField, ModelPicker, Ollama option fields.

### `web/src/editor/fields.tsx`

```tsx
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ModelLimitsResponse, ModelsResponse, NodeModelConfig, OllamaOptions } from "@llm-pipeline/client";
import { client } from "../config";
import { formatBytes } from "../format";

// One request per model per page load: limits don't change while you edit.
const limitsCache = new Map<string, Promise<ModelLimitsResponse | null>>();

/** An Ollama model's limits (max context, size) for hints; null while
 * loading, for other providers, or when the server can't tell. */
export function useModelLimits(model: NodeModelConfig | undefined): ModelLimitsResponse | null {
  const name = model?.provider === "ollama" ? model.name : null;
  const [limits, setLimits] = useState<ModelLimitsResponse | null>(null);
  useEffect(() => {
    setLimits(null);
    if (!name) return;
    let cancelled = false;
    let pending = limitsCache.get(name);
    if (!pending) {
      pending = client.getModelLimits(name).catch(() => null);
      limitsCache.set(name, pending);
    }
    void pending.then((found) => {
      if (!cancelled) setLimits(found);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);
  return limits;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/**
 * A numeric input that keeps what the user is typing ("0.", "-", "1e")
 * instead of snapping it to a parsed number mid-keystroke. Commits a
 * number whenever the text parses, and `undefined` when cleared — which
 * callers treat as "unset, use the default".
 */
export function NumberField(props: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { value, onChange, placeholder, disabled, ariaLabel } = props;
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value === undefined ? "" : String(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder ?? "default"}
      disabled={disabled}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(value === undefined ? "" : String(value));
      }}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === "") onChange(undefined);
        else if (!Number.isNaN(Number(next))) onChange(Number(next));
      }}
    />
  );
}

/** A text input that commits on blur / Enter rather than per keystroke —
 * for values like a node id, where every intermediate spelling would be
 * a rename. */
export function CommitInput(props: {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    if (text !== props.value) props.onCommit(text.trim());
  };
  return (
    <input
      type="text"
      value={text}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(props.value);
      }}
    />
  );
}

function normalizeOllama(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** Picks "provider:name" from what the server says may be selected. A
 * model the node already uses but the server doesn't list stays visible
 * (marked) instead of silently disappearing. */
export function ModelPicker(props: {
  model: NodeModelConfig | undefined;
  models: ModelsResponse | null;
  limits: ModelLimitsResponse | null;
  /** Called with "provider:name", or "" for the empty choice. */
  onChange: (identity: string) => void;
  onRefresh: () => void;
  disabled?: boolean;
  /** Offers "no model here" as a choice (value ""), with this label — e.g.
   * "pipeline default (ollama:llama3)" or "none". */
  emptyOption?: string;
}) {
  const { model, models } = props;
  const current = model ? `${model.provider}:${model.name}` : "";
  const providers = models?.providers ?? [];

  let selected = "";
  const listed: string[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      const identity = `${p.provider}:${m.name}`;
      listed.push(identity);
      if (
        model &&
        p.provider === model.provider &&
        (p.provider === "ollama" ? normalizeOllama(m.name) === normalizeOllama(model.name) : m.name === model.name)
      ) {
        selected = identity;
      }
    }
  }
  const unlisted = current !== "" && selected === "";
  const ollama = providers.find((p) => p.provider === "ollama");
  // Ollama being down explains everything else that's missing here (the
  // app-wide notice says what it means for runs), so it's the one warning.
  const ollamaDown = ollama !== undefined && !ollama.reachable;
  const unlistedBecauseDown = unlisted && ollamaDown && model?.provider === "ollama";

  return (
    <div className="model-picker">
      <div className="row">
        <select
          value={unlisted ? current : selected}
          disabled={props.disabled}
          aria-label="Model"
          onChange={(e) => props.onChange(e.target.value)}
        >
          {props.emptyOption !== undefined && <option value="">{props.emptyOption}</option>}
          {unlisted && (
            <option value={current}>
              {current} ({unlistedBecauseDown ? "Ollama unreachable" : "not available on server"})
            </option>
          )}
          {!current && props.emptyOption === undefined && <option value="">choose a model…</option>}
          {providers.map((p) => (
            <optgroup key={p.provider} label={p.reachable ? p.provider : `${p.provider} (unreachable)`}>
              {p.models.map((m) => {
                const meta = [m.parameter_size, m.quantization, formatBytes(m.size_bytes)]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <option key={m.name} value={`${p.provider}:${m.name}`}>
                    {m.name}
                    {meta ? `  — ${meta}` : ""}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
        {/* Words, not ↻ — that already means "re-run" and "loop" elsewhere. */}
        <button type="button" className="ghost" onClick={props.onRefresh} title="Ask the server for its model list again">
          Refresh
        </button>
      </div>
      {props.limits && (
        <p className="field-hint">
          {[
            props.limits.context_length ? `max context ${props.limits.context_length.toLocaleString("en-US")}` : null,
            props.limits.parameter_size,
            props.limits.quantization,
            props.limits.family,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {ollamaDown && <p className="hint-warn">Ollama isn&apos;t reachable — its models aren&apos;t listed.</p>}
      {unlisted && !unlistedBecauseDown && (
        <p className="hint-warn">
          This model isn&apos;t installed/allowlisted — a save only succeeds if the pipeline already used it.
        </p>
      )}
      {listed.length === 0 && models && !ollamaDown && (
        <p className="hint-warn">The server lists no selectable models.</p>
      )}
    </div>
  );
}

type NumericOption = Exclude<
  keyof OllamaOptions,
  "stop" | "keep_alive" | "format" | "mirostat"
>;

const NUMERIC_OPTIONS: { key: NumericOption; label: string; hint: string }[] = [
  { key: "num_ctx", label: "num_ctx", hint: "context window in tokens" },
  { key: "num_predict", label: "num_predict", hint: "max tokens to generate (-1 unlimited)" },
  { key: "top_p", label: "top_p", hint: "nucleus sampling, 0–1" },
  { key: "top_k", label: "top_k", hint: "sample from the k likeliest tokens" },
  { key: "repeat_penalty", label: "repeat_penalty", hint: "penalize repetition (1 = off)" },
  { key: "repeat_last_n", label: "repeat_last_n", hint: "how far back to look for repeats" },
  { key: "seed", label: "seed", hint: "fixed seed for reproducible output" },
  { key: "tfs_z", label: "tfs_z", hint: "tail-free sampling (1 = off)" },
  { key: "mirostat_eta", label: "mirostat_eta", hint: "mirostat learning rate" },
  { key: "mirostat_tau", label: "mirostat_tau", hint: "mirostat target entropy" },
  { key: "num_gpu", label: "num_gpu", hint: "layers to offload to GPU" },
  { key: "num_thread", label: "num_thread", hint: "CPU threads" },
];

interface OllamaOptionsProps {
  options: OllamaOptions | undefined;
  onChange: <K extends keyof OllamaOptions>(key: K, value: OllamaOptions[K]) => void;
  /** The model's maximum context length, when known — shown on num_ctx. */
  maxContext?: number | null | undefined;
  disabled?: boolean;
}

/** "3 set", or "model defaults" — what a group of Ollama options holds. */
export function ollamaOptionsSummary(options: OllamaOptions | undefined): ReactNode {
  const count = Object.keys(options ?? {}).length;
  return count > 0 ? <span className="count">{count} set</span> : <span className="dim">model defaults</span>;
}

/** Every Ollama generation option; empty means "the model's default". A
 * folding group of its own for the pipeline's defaults. */
export function OllamaOptionsForm(props: OllamaOptionsProps) {
  const count = Object.keys(props.options ?? {}).length;
  return (
    <details className="options" open={count > 0}>
      <summary>Ollama options {ollamaOptionsSummary(props.options)}</summary>
      <OllamaOptionFields {...props} />
    </details>
  );
}

/** The fields alone — a node's settings put them in a Section. */
export function OllamaOptionFields(props: OllamaOptionsProps) {
  const o = props.options ?? {};
  const set = props.onChange;

  return (
    <div className="field-stack">
      {NUMERIC_OPTIONS.map((opt) => (
        <Field
          key={opt.key}
          label={opt.label}
          hint={
            opt.key === "num_ctx" && props.maxContext
              ? `${opt.hint} (model max ${props.maxContext.toLocaleString("en-US")})`
              : opt.hint
          }
        >
          <NumberField
            value={o[opt.key]}
            disabled={props.disabled}
            ariaLabel={opt.label}
            onChange={(v) => set(opt.key, v)}
          />
        </Field>
      ))}
      <Field label="mirostat" hint="0 off · 1 · 2 (Mirostat 2.0)">
        <select
          value={o.mirostat === undefined ? "" : String(o.mirostat)}
          disabled={props.disabled}
          onChange={(e) => set("mirostat", e.target.value === "" ? undefined : (Number(e.target.value) as 0 | 1 | 2))}
        >
          <option value="">default</option>
          <option value="0">0 — off</option>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>
      </Field>
      <Field label="format" hint="json forces valid JSON output">
        <select
          value={o.format ?? ""}
          disabled={props.disabled}
          onChange={(e) => set("format", e.target.value === "" ? undefined : (e.target.value as "json"))}
        >
          <option value="">text</option>
          <option value="json">json</option>
        </select>
      </Field>
      <Field label="keep_alive" hint='keep loaded: "5m", "1h", 0 = unload'>
        <input
          type="text"
          value={o.keep_alive === undefined ? "" : String(o.keep_alive)}
          placeholder="default"
          disabled={props.disabled}
          onChange={(e) => {
            const v = e.target.value.trim();
            set("keep_alive", v === "" ? undefined : /^-?\d+$/.test(v) ? Number(v) : v);
          }}
        />
      </Field>
      <Field label="stop" hint="comma-separated stop sequences">
        <input
          type="text"
          value={(o.stop ?? []).join(",")}
          placeholder="none"
          disabled={props.disabled}
          onChange={(e) => {
            const parts = e.target.value.split(",").filter((s) => s !== "");
            set("stop", parts.length ? parts : undefined);
          }}
        />
      </Field>
    </div>
  );
}
```

## Menu
- MenuButton: button + dropdown menu with ARIA menu keyboard contract; `align` start/end; keeps itself on screen (menuShift).

### `web/src/ui/Menu.tsx`

```tsx
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

/** How far to move a menu sideways, in px, so all of it is on screen. It
 * opens along its button's `align` edge; where that would run past the
 * window, it moves in to `margin` px from the edge — and when it's wider
 * than the window, its left edge (where the labels start) stays in view. */
export function menuShift(
  button: { left: number; right: number },
  menuWidth: number,
  windowWidth: number,
  align: "start" | "end",
  margin = 8
): number {
  const natural = align === "end" ? button.right - menuWidth : button.left;
  const fitted = Math.max(margin, Math.min(natural, windowWidth - margin - menuWidth));
  return fitted - natural;
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
  const menu = useRef<HTMLDivElement>(null);
  // Sideways move that keeps the open menu on screen (see menuShift) —
  // measured before it's painted, so it never shows cut off first.
  const [shift, setShift] = useState(0);
  const id = useId();

  useLayoutEffect(() => {
    const at = button.current?.getBoundingClientRect();
    const width = menu.current?.offsetWidth;
    if (!open || !at || !width) return;
    setShift(menuShift(at, width, document.documentElement.clientWidth, align));
  }, [open, align]);

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
        <div
          ref={menu}
          className={align === "end" ? "menu align-end" : "menu"}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          role="menu"
          id={`${id}-menu`}
          aria-labelledby={`${id}-button`}
          onKeyDown={onMenuKeyDown}
        >
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
```

## Dialogs
- In-app confirm / prompt / form dialogs (`<dialog>`), with inline validation.

### `web/src/ui/Dialogs.tsx`

```tsx
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  /** Returns an error message to show inline, or null when the value is OK. */
  validate?: (value: string) => string | null;
}

export interface FormField {
  name: string;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  /** Makes it a select with these choices instead of a text box. */
  options?: { value: string; label: string }[];
  /** An empty optional text field is fine and skips `validate`. */
  optional?: boolean;
  /** Returns an error message to show inline, or null when the value is OK. */
  validate?: (value: string) => string | null;
}

interface FormOptions {
  title: string;
  body?: ReactNode;
  fields: FormField[];
  confirmLabel?: string;
}

export interface Dialogs {
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Resolves to the entered text, or null when cancelled. */
  prompt(options: PromptOptions): Promise<string | null>;
  /** Several fields at once; resolves to each field's trimmed value by
   * name, or null when cancelled. */
  form(options: FormOptions): Promise<Record<string, string> | null>;
}

type Request =
  | ({ kind: "confirm"; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: "form"; resolve: (values: Record<string, string> | null) => void } & FormOptions);

const DialogContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const dialogs = useContext(DialogContext);
  if (!dialogs) throw new Error("useDialogs() needs a <DialogProvider> above it");
  return dialogs;
}

/** In-app replacements for window.confirm/prompt: styled like the app,
 * with inline validation, built on <dialog>.showModal() (focus trap,
 * Escape to cancel, inert background). */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const dialogs = useMemo<Dialogs>(() => {
    const form = (options: FormOptions) =>
      new Promise<Record<string, string> | null>((resolve) => setRequest({ kind: "form", resolve, ...options }));
    return {
      confirm: (options) => new Promise((resolve) => setRequest({ kind: "confirm", resolve, ...options })),
      form,
      prompt: async ({ label, initial, validate, ...rest }) => {
        const values = await form({
          ...rest,
          fields: [
            {
              name: "value",
              label,
              ...(initial !== undefined ? { initial } : {}),
              ...(validate ? { validate } : {}),
            },
          ],
        });
        return values?.value ?? null;
      },
    };
  }, []);
  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {request && <DialogView key={request.title} request={request} onDone={() => setRequest(null)} />}
    </DialogContext.Provider>
  );
}

function fieldError(field: FormField, value: string): string | null {
  if (field.options) return null;
  if (value === "") return field.optional ? null : "required";
  return field.validate?.(value) ?? null;
}

function DialogView({ request, onDone }: { request: Request; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const fields = request.kind === "form" ? request.fields : [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.initial ?? f.options?.[0]?.value ?? ""]))
  );
  const errors = fields.map((f) => fieldError(f, (values[f.name] ?? "").trim()));
  const invalid = errors.some((e) => e !== null);
  /** Why the confirm button is disabled: the first field's problem — for
   * an empty one, its name without the explanation ("Name (the file…)"). */
  const blocked = fields
    .map((f, i) => (errors[i] === "required" ? `Fill in “${f.label.split(/ \(| — /)[0]}” first` : errors[i]))
    .find((e): e is string => Boolean(e));
  const settled = useRef(false);

  const finish = (confirmed: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (request.kind === "confirm") request.resolve(confirmed);
    else
      request.resolve(
        confirmed ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])) : null
      );
    ref.current?.close();
    onDone();
  };

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="app-dialog"
      aria-labelledby="app-dialog-title"
      onCancel={(e) => {
        e.preventDefault(); // Escape
        finish(false);
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) finish(true);
        }}
      >
        <h2 id="app-dialog-title">{request.title}</h2>
        {request.body && <div className="dialog-body">{request.body}</div>}
        {fields.map((field, i) => {
          const value = values[field.name] ?? "";
          const error = errors[i];
          const set = (v: string) => setValues((current) => ({ ...current, [field.name]: v }));
          return (
            <label className="field" key={field.name}>
              <span className="field-label">{field.label}</span>
              {field.options ? (
                <select value={value} onChange={(e) => set(e.target.value)}>
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  autoFocus={i === 0}
                  value={value}
                  placeholder={field.placeholder}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => set(e.target.value)}
                />
              )}
              {/* "required" is what the disabled button already says — no need to shout it */}
              {error && value.trim() !== "" ? (
                <span className="field-error">{error}</span>
              ) : (
                field.hint && <span className="field-hint">{field.hint}</span>
              )}
            </label>
          );
        })}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={() => finish(false)}>
            Cancel
          </button>
          <button
            type="submit"
            autoFocus={request.kind === "confirm"}
            className={request.kind === "confirm" && request.danger ? "danger-solid" : ""}
            disabled={invalid}
            title={blocked}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
```

## icons
- The few drawn icons: GearIcon, AutoLayoutIcon.

### `web/src/ui/icons.tsx`

```tsx
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
```

## DisplaySettings
- "Aa" popover: theme (System/Light/Dark) and text size.

### `web/src/ui/DisplaySettings.tsx`

```tsx
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
            canvas zoom, which fits to the text size — zoomed out, they show just their id and model at this size.
          </p>
        </div>
      )}
    </div>
  );
}
```

## ServerStatus
- API / Ollama status lights in the top bar, and the outage notice.

### `web/src/ui/ServerStatus.tsx`

```tsx
import { useState } from "react";
import type { ProviderModels } from "@llm-pipeline/client";

type Health = "ok" | "down" | "unknown";

/** One health light with its name beside it — "offline" is spelled out,
 * so the state doesn't rest on the dot's color alone. */
function Indicator({ label, health, detail }: { label: string; health: Health; detail: string }) {
  return (
    <span className={`indicator ${health}`} title={detail}>
      <span className={`status-dot ${health === "ok" ? "online" : health === "down" ? "offline" : ""}`} aria-hidden="true" />
      {label}
      {health === "down" ? " offline" : <span className="visually-hidden">{health === "ok" ? " online" : " checking"}</span>}
    </span>
  );
}

/**
 * The header's health lights: the pipeline API, and Ollama — the one
 * model provider the server actually checks (cloud models come from an
 * allowlist). Both are re-checked every 15 s.
 */
export function ServerStatus(props: {
  baseUrl: string;
  online: boolean | null;
  /** Ollama as GET /v1/models last reported it; undefined until known. */
  ollama: ProviderModels | undefined;
  readOnly: boolean;
}) {
  const { baseUrl, online, ollama } = props;
  return (
    <div className="status" role="group" aria-label="Server status">
      <Indicator
        label="API"
        health={online === null ? "unknown" : online ? "ok" : "down"}
        detail={online === null ? `checking ${baseUrl}…` : online ? `${baseUrl} is reachable` : `can't reach ${baseUrl}`}
      />
      {ollama && (
        <Indicator
          label="Ollama"
          health={ollama.reachable ? "ok" : "down"}
          detail={ollama.reachable ? "Ollama is reachable" : (ollama.error ?? "Ollama isn't reachable")}
        />
      )}
      {props.readOnly && <span className="chip-status">read-only</span>}
    </div>
  );
}

/** A provider the open pipeline needs is down: says what that means for
 * it, with a way to check again right away instead of waiting for the
 * next poll. Goes away by itself once the provider is back. */
export function OutageNotice({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="notice warn" role="alert">
      <span>{message}</span>
      <button
        type="button"
        className="link"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          try {
            await onRetry();
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? "checking…" : "Retry"}
      </button>
    </div>
  );
}
```

## AddNodeMenu
- "+ Add node" button and popover palette (blank node, presets) on the canvas.

### `web/src/editor/AddNodeMenu.tsx`

```tsx
import { useEffect, useId, useRef, useState } from "react";
import type { NodePreset } from "@llm-pipeline/client";
import { NODE_DRAG_TYPE } from "./PipelineCanvas";

function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Everything a preset carries, for its tooltip. */
function summary(p: NodePreset): string {
  return [
    `${p.model.provider}:${p.model.name}${p.model.temperature !== undefined ? ` · temperature ${p.model.temperature}` : ""}`,
    p.model.options && Object.keys(p.model.options).length > 0
      ? `options: ${Object.entries(p.model.options)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
          .join(" ")}`
      : null,
    p.system_prompt ? `system: ${excerpt(p.system_prompt)}` : null,
    p.prompt_template !== undefined ? `prompt: ${excerpt(p.prompt_template)}` : "prompt: not saved (keeps the node's own)",
    p.include_history === false ? "doesn't see the conversation history" : null,
    p.strip_reasoning === true ? "strips <think> reasoning" : p.strip_reasoning === false ? "keeps <think> reasoning" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Things to put on the canvas: a blank LLM node, or a node from a
 * preset. Drag onto the canvas, or click to add (below the selected node,
 * connected to it). */
function Palette(props: {
  editable: boolean;
  presets: NodePreset[];
  onAdd: (presetName: string | undefined) => void;
  /** An item was dropped on the canvas — not a drag that was cancelled. */
  onDropped: () => void;
  onDeletePreset: (name: string) => void;
}) {
  const { editable, presets, onAdd, onDropped, onDeletePreset } = props;
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shown = query
    ? presets.filter((p) =>
        [p.name, p.description, p.model.name, p.system_prompt, p.prompt_template].some((t) =>
          t?.toLowerCase().includes(query)
        )
      )
    : presets;

  const item = (label: string, detail: string, preset: NodePreset | undefined, tags: string[] = []) => (
    <button
      type="button"
      key={preset?.name ?? "__blank"}
      className="palette-item"
      draggable={editable}
      disabled={!editable}
      title={
        editable
          ? `${preset ? `${summary(preset)}\n\n` : ""}drag onto the canvas, or click to add`
          : "editing is disabled on this server"
      }
      onDragStart={(e) => {
        e.dataTransfer.setData(NODE_DRAG_TYPE, preset?.name ?? "");
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={(e) => {
        // "none" when the drag was cancelled (Esc, or dropped off the canvas).
        if (e.dataTransfer.dropEffect !== "none") onDropped();
      }}
      onClick={() => onAdd(preset?.name)}
    >
      <span className="palette-label">{label}</span>
      <span className="palette-detail">{detail}</span>
      {tags.length > 0 && (
        <span className="palette-meta">
          {tags.map((t) => (
            <span className="palette-tag" key={t}>
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );

  return (
    <nav className="palette" aria-label="Node palette">
      {item("LLM node", "a model call with a prompt", undefined)}
      <h3>Presets</h3>
      {presets.length === 0 ? (
        <p className="dim">
          Select a node and use <strong>Save as preset</strong> to keep its model, prompts and settings — then add it
          to any pipeline from here.
        </p>
      ) : (
        <>
          {presets.length > 5 && (
            <input
              type="search"
              className="palette-filter"
              placeholder="filter presets…"
              aria-label="Filter presets"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {shown.length === 0 && <p className="dim">No preset matches “{filter.trim()}”.</p>}
          {shown.map((p) => (
            <div className="palette-row" key={p.name}>
              {item(
                p.name,
                p.description || `${p.model.provider}:${p.model.name}`,
                p,
                [
                  p.description ? p.model.name : null,
                  p.model.temperature !== undefined ? `T ${p.model.temperature}` : null,
                  p.include_history === false ? "no history" : null,
                  p.strip_reasoning ? "strips reasoning" : null,
                ].filter((t): t is string => t !== null)
              )}
              {editable && (
                <button
                  type="button"
                  className="ghost icon palette-remove"
                  aria-label={`Remove the preset ${p.name}`}
                  title="Remove this preset"
                  onClick={() => onDeletePreset(p.name)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </nav>
  );
}

/**
 * "+ Add node" in the canvas corner: a popover with a blank LLM node and
 * the saved presets. Click one to add it below the selected node (connected
 * to it), or drag it onto the canvas. It closes once a node is added, on
 * Escape, or on a click elsewhere — and stays open during a drag, since
 * removing what's being dragged can cancel the drop.
 */
export function AddNodeMenu(props: {
  editable: boolean;
  presets: NodePreset[];
  onAdd: (presetName: string | undefined) => void;
  onDeletePreset: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      // Confirming a preset's removal (a dialog) is still using the menu.
      if (!wrapper.current?.contains(target) && !target.closest?.("dialog")) setOpen(false);
    };
    // Escape closes the menu wherever focus is — not every browser focuses a
    // button it clicks — and only the menu: caught on window in the capture
    // phase, before App's Esc ("stop the run") hears it. An open dialog
    // (removing a preset) gets its own Escape.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div
      className="add-node-menu"
      ref={wrapper}
      // The menu sits on the canvas, which takes drops: a drag let go over
      // the menu is refused here (no preventDefault) rather than adding a
      // node underneath it.
      onDragOver={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
    >
      <button
        ref={button}
        type="button"
        className="ghost"
        aria-expanded={open}
        aria-controls={`${id}-palette`}
        disabled={!props.editable}
        title={props.editable ? "Add a node: blank, or from a preset" : "Add node — editing is disabled on this server"}
        onClick={() => setOpen((o) => !o)}
      >
        + Add node
      </button>
      {open && (
        // nowheel/nopan: scrolling or dragging in here doesn't move the canvas.
        <div className="add-node-popover nowheel nopan" id={`${id}-palette`}>
          <Palette
            editable={props.editable}
            presets={props.presets}
            onAdd={(presetName) => {
              props.onAdd(presetName);
              setOpen(false);
            }}
            onDropped={() => setOpen(false)}
            onDeletePreset={props.onDeletePreset}
          />
        </div>
      )}
    </div>
  );
}
```

## CanvasLegend
- "?" legend popover in the canvas corner.

### `web/src/editor/CanvasLegend.tsx`

```tsx
import { useEffect, useId, useRef, useState } from "react";

/**
 * "?" in a corner of the canvas: what its colors, lines and marks mean,
 * next to the drawing it explains. A disclosure — the button shows and
 * hides the legend; Escape or a click elsewhere hides it too.
 */
export function CanvasLegend() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      className="canvas-legend"
      ref={wrapper}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation(); // not also "stop the run" (App's Esc)
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="ghost icon"
        aria-expanded={open}
        aria-controls={`${id}-legend`}
        aria-label="Legend"
        title="What the canvas shows"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <div className="legend-panel" id={`${id}-legend`} role="region" aria-label="Legend">
          <h3>Nodes</h3>
          <ul className="legend">
            <li>
              <span className="swatch status-running" /> running
            </li>
            <li>
              <span className="swatch status-complete" /> done — ✓ when zoomed out
            </li>
            <li>
              <span className="swatch status-failed" /> failed — ✕ when zoomed out
            </li>
            <li>
              <span className="output-badge in-legend">output</span> the pipeline&apos;s answer comes from it
            </li>
            <li>
              <span className="swatch problem" /> dashed: invalid (red) or a warning (amber)
            </li>
          </ul>
          <h3>Edges</h3>
          <ul className="legend">
            <li>
              <span className="line plain" /> depends on — drag from a node&apos;s bottom dot to another&apos;s top dot
            </li>
            <li>
              <span className="line branch" /> branch route
            </li>
            <li>
              <span className="line loop" /> loop
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
```

## LlmNode
- A node card on the canvas: id, model, temperature, live status, output badge.

### `web/src/editor/LlmNode.tsx`

```tsx
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { compactCount, describeUsage } from "@llm-pipeline/client";
import type { NodeExecutionStatus } from "@llm-pipeline/client";
import { LOOP_IN_HANDLE, LOOP_OUT_HANDLE } from "./conversion";
import type { LlmFlowNode } from "./conversion";
import { formatDuration } from "../format";

const STATUS_LABEL: Record<NodeExecutionStatus, string> = {
  "not-started": "idle",
  running: "running",
  complete: "done",
  failed: "failed",
};

/** One LLM step on the canvas: its id, model and temperature, and — while
 * a run is in progress — whether the server says it is running right now.
 * Zoomed out, CSS shows only the id, model and a status mark (see
 * "Zoomed-out cards" in style.css). */
function LlmNodeView({ data, selected }: NodeProps<LlmFlowNode>) {
  const classes = [
    "llm-node",
    `status-${data.status}`,
    selected ? "selected" : "",
    data.problem ? `problem-${data.problem}` : "",
  ].join(" ");
  const usage = describeUsage(data.usage);
  const tokens =
    usage?.contextShort ??
    (data.usage?.prompt_tokens != null ? `${compactCount(data.usage.prompt_tokens)} tok` : null);

  return (
    <div className={classes} data-testid={`node-${data.nodeId}`}>
      <Handle type="target" position={Position.Top} />
      {/* On the card's top edge, so it takes no room from the id. */}
      {data.isOutput && (
        <span className="output-badge" title="An output node: the pipeline's answer comes from the first one that ran">
          output
        </span>
      )}
      <div className="llm-node-head">
        <span className="llm-node-id" title={data.nodeId}>
          {data.nodeId}
        </span>
        {/* Nothing before a run: "idle" on every card says nothing. */}
        {data.status !== "not-started" && (
          <span className={`status-pill status-${data.status}`}>
            {data.status === "running" && <span className="pulse-dot" aria-hidden="true" />}
            <span className="status-label">
              {data.status === "complete" && data.replayed ? "reused" : STATUS_LABEL[data.status]}
            </span>
          </span>
        )}
      </div>
      <div className="llm-node-model" title={data.model}>
        {data.model}
      </div>
      {data.liveText && (
        <div className="llm-node-live" aria-live="off">
          <span>{data.liveText}</span>
        </div>
      )}
      <div className="llm-node-meta">
        <span>T={data.temperature ?? "default"}</span>
        {data.optionCount > 0 && <span>{data.optionCount} opt</span>}
        {data.hasSystemPrompt && <span>system</span>}
        {data.status === "complete" && data.durationMs !== undefined && !data.replayed && (
          <span>{formatDuration(data.durationMs)}</span>
        )}
        {usage && tokens && (
          <span
            className={`meta-usage level-${usage.level ?? "ok"}`}
            title={[usage.summary, usage.warning].filter(Boolean).join("\n\n")}
          >
            {usage.level === "full" ? "⚠ " : ""}
            {tokens}
          </span>
        )}
        {data.problem === "error" && <span className="meta-error">invalid</span>}
        {data.problem === "warning" && <span className="meta-warn">model?</span>}
      </div>
      <Handle type="source" position={Position.Bottom} />
      {/* Loop back-edges leave and re-enter on the right, so a loop draws as
          a bracket beside the nodes instead of overlapping the downward
          edge between them. Not connectable: loops are edited in the
          inspector. */}
      <Handle
        type="source"
        id={LOOP_OUT_HANDLE}
        position={Position.Right}
        isConnectable={false}
        className="loop-handle"
        style={{ top: "65%" }}
      />
      <Handle
        type="target"
        id={LOOP_IN_HANDLE}
        position={Position.Right}
        isConnectable={false}
        className="loop-handle"
        style={{ top: "35%" }}
      />
    </div>
  );
}

export const LlmNode = memo(LlmNodeView);
```

## MessageEntry
- One trace entry: what a node received (system + prompt) and replied, with status pill.

### `web/src/run/MessageEntry.tsx`

```tsx
import { useEffect, useRef } from "react";
import { describeUsage } from "@llm-pipeline/client";
import type { RunLogEntry } from "@llm-pipeline/client";
import { formatDuration } from "../format";

const STATUS_LABEL: Record<RunLogEntry["status"], string> = {
  running: "running",
  complete: "done",
  failed: "failed",
  stopped: "stopped",
};

/** A message block that stays scrolled to the newest text while it grows. */
function Block({ text, live }: { text: string; live?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [text, live]);
  return (
    <pre className={`message-text${live ? " live" : ""}`} ref={ref}>
      {text}
      {live && <span className="cursor" aria-hidden="true" />}
    </pre>
  );
}

/** What one node received (system prompt + rendered prompt) and what it
 * replied, for one execution in one run. */
export function MessageEntry(props: {
  entry: RunLogEntry;
  isOutput?: boolean;
  /** Shows the node id as a link (whole-run view) instead of plain text. */
  onSelectNode?: (nodeId: string) => void;
  showNodeId?: boolean;
  /** Offered on the latest run's entries: run it again from this node. */
  onRerun?: () => void;
}) {
  const { entry, onSelectNode } = props;
  const running = entry.status === "running";
  const usage = describeUsage(entry.usage);
  return (
    <article className={`message-entry status-${entry.status}`}>
      <header className="message-head">
        {props.showNodeId !== false &&
          (onSelectNode ? (
            <button type="button" className="link message-node" onClick={() => onSelectNode(entry.nodeId)}>
              {entry.nodeId}
            </button>
          ) : (
            <span className="message-node">{entry.nodeId}</span>
          ))}
        {props.isOutput && (
          <span className="tag-mini" title="An output node: the pipeline's answer comes from the first one that ran">
            output
          </span>
        )}
        <span className="dim">{entry.modelName}</span>
        {entry.iteration > 1 && (
          <span className="tag-mini" title="this node ran again because of a loop">
            iteration {entry.iteration}
          </span>
        )}
        {entry.attempt > 1 && <span className="tag-mini warn">retry {entry.attempt}</span>}
        {entry.replayed && (
          <span className="tag-mini" title="a re-run reused this output from the run before — no model call">
            reused
          </span>
        )}
        {props.onRerun && (
          <button type="button" className="link" onClick={props.onRerun} title="run the latest message again from this node">
            ↻ re-run from here
          </button>
        )}
        <span className={`status-pill status-${entry.status === "complete" ? "complete" : entry.status === "running" ? "running" : "failed"}`}>
          {running && <span className="pulse-dot" aria-hidden="true" />}
          {STATUS_LABEL[entry.status]}
          {entry.durationMs !== null ? ` · ${formatDuration(entry.durationMs)}` : ""}
        </span>
      </header>
      {usage?.summary && (
        <p className={`message-usage level-${usage.level ?? "ok"}`} title={usage.level === "near" ? (usage.warning ?? "") : undefined}>
          {usage.summary}
        </p>
      )}
      {usage?.level === "full" && <p className="problem error">{usage.warning}</p>}
      {entry.system && (
        <section className="message-part">
          <h4>system</h4>
          <Block text={entry.system} />
        </section>
      )}
      <section className="message-part">
        <h4>received</h4>
        {entry.prompt !== null ? (
          <Block text={entry.prompt} />
        ) : (
          <p className="dim">not reported by the server</p>
        )}
      </section>
      <section className="message-part">
        <h4>replied</h4>
        {running && !entry.output ? (
          <p className="dim">waiting for the first tokens…</p>
        ) : entry.status !== "complete" && !entry.output ? (
          <p className="dim">no reply</p>
        ) : (
          <Block text={entry.output} live={running} />
        )}
      </section>
    </article>
  );
}
```
