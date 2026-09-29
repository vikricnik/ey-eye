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
        <button type="button" className="ghost" onClick={props.onRefresh} title="Refresh model list">
          ↻
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

/** Every Ollama generation option; empty means "the model's default". */
export function OllamaOptionsForm(props: {
  options: OllamaOptions | undefined;
  onChange: <K extends keyof OllamaOptions>(key: K, value: OllamaOptions[K]) => void;
  /** The model's maximum context length, when known — shown on num_ctx. */
  maxContext?: number | null | undefined;
  disabled?: boolean;
}) {
  const o = props.options ?? {};
  const set = props.onChange;
  const count = Object.keys(o).length;

  return (
    <details className="options" open={count > 0}>
      <summary>
        Ollama options {count > 0 ? <span className="count">{count} set</span> : <span className="dim">model defaults</span>}
      </summary>
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
    </details>
  );
}
