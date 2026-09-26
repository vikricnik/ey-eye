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
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
