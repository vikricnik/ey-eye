/**
 * `/set <node>.<field> <value>` and `/pset <setting> <value>`: typed-in paths
 * and values, turned into the shared client's typed edits (setNodeProperty,
 * setNodeModel, setPipelineSetting, …). The shorthands (`temperature`,
 * `system`, `deps`, …), the words that clear a field (`unset`) or inherit
 * the default model (`default`), and reading a value from text all live
 * here: they are how this command line reads, not part of a pipeline.
 */

import {
  DraftError,
  findNode,
  modelWithIdentity,
  renameNode,
  setNodeModel,
  setNodeProperty,
  setPipelineSetting,
  updateNodeModel,
} from "@llm-pipeline/client";
import type {
  NodeConfig,
  NodeModelConfig,
  NodeProperty,
  PipelineDefinition,
  PipelineSection,
} from "@llm-pipeline/client";

/** Shorthands for node fields, mapped to where they live. */
const NODE_ALIASES: Record<string, string> = {
  temperature: "model.temperature",
  provider: "model.provider",
  system: "system_prompt",
  prompt: "prompt_template",
  deps: "depends_on",
  after: "depends_on",
  history: "include_history",
  reasoning: "strip_reasoning",
};

/** The node settings a path may name, besides `id` and `model.*`. */
const NODE_PROPERTIES: ReadonlySet<string> = new Set<NodeProperty>([
  "type",
  "depends_on",
  "system_prompt",
  "prompt_template",
  "include_history",
  "strip_reasoning",
  "labels",
  "layout",
]);

const SECTIONS: ReadonlySet<string> = new Set<PipelineSection>(["execution", "defaults", "history"]);

/** Model values meaning "none of its own": a node inherits the pipeline
 * default; a pipeline-wide model (default, summarizer) is removed. */
const NO_MODEL = new Set(["", "default", "inherit", "unset"]);

export function resolveNodeFieldPath(path: string): string[] {
  const aliased = NODE_ALIASES[path] ?? (path.startsWith("options.") ? `model.${path}` : path);
  const segments = aliased.split(".").filter(Boolean);
  if (segments.length === 0) throw new DraftError("empty field path");
  return segments;
}

/** `/set <node>.<path> <value>` — `value` as coerceFieldValue() read it. */
export function setNodeFieldByPath(
  def: PipelineDefinition,
  id: string,
  path: string,
  value: unknown
): PipelineDefinition {
  const [head, ...rest] = resolveNodeFieldPath(path);
  if (head === "id" && rest.length === 0) return renameNode(def, id, String(value));
  if (head === "model") {
    if (rest.length > 0) return updateNodeModel(def, id, (model) => setIn(model, rest, value) as NodeModelConfig);
    if (typeof value !== "string") throw new DraftError("model takes a 'provider:model' identity");
    return setNodeModel(def, id, modelFromInput(findNode(def, id).model, value));
  }
  if (!head || !NODE_PROPERTIES.has(head)) {
    throw new DraftError(`nodes have no field '${path}' — see /help for the fields /set takes`);
  }
  const key = head as NodeProperty;
  const next = rest.length > 0 ? emptyToUndefined(setIn(findNode(def, id)[key], rest, value)) : value;
  // The user typed the value; the server validates it like any other edit.
  return setNodeProperty(def, id, key, next as NodeConfig[NodeProperty]);
}

/** `/pset <setting> <value>` — `description`, `execution.*`, `defaults.*`
 * or `history.*`; `defaults.temperature` and `defaults.options.*` are the
 * default model's. */
export function setPipelineSettingByPath(def: PipelineDefinition, path: string, value: unknown): PipelineDefinition {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 1 && segments[0] === "description") {
    const { description: _old, ...rest } = def;
    return value === undefined ? rest : { ...rest, description: String(value) };
  }
  const [section, key, ...rest] = segments;
  if (!section || !SECTIONS.has(section) || !key) {
    throw new DraftError(`unknown pipeline setting '${path}' (use description, execution.*, defaults.*, history.*)`);
  }
  if (section === "defaults" && (key === "temperature" || key === "options")) {
    const model = def.defaults?.model;
    if (!model) throw new DraftError("set defaults.model first");
    return setPipelineSetting(def, "defaults", "model", setIn(model, [key, ...rest], value) as NodeModelConfig);
  }
  const current = (def[section as PipelineSection] as Record<string, unknown> | undefined)?.[key];
  const next =
    [key, ...rest].at(-1) === "model" && typeof value === "string"
      ? modelFromInput(getIn(current, rest) as NodeModelConfig | undefined, value)
      : value;
  const setting = rest.length > 0 ? emptyToUndefined(setIn(current, rest, next)) : next;
  // Section and key are only known at run time; the server validates them.
  return setPipelineSetting(def, section as PipelineSection, key as never, setting as never);
}

function modelFromInput(current: NodeModelConfig | undefined, identity: string): NodeModelConfig | undefined {
  return NO_MODEL.has(identity.trim()) ? undefined : modelWithIdentity(current, identity);
}

function getIn(target: unknown, path: string[]): unknown {
  return path.reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], target);
}

/** `target` with the value at `path` set — or removed, with `undefined` —
 * dropping the containers that leaves empty. */
function setIn(target: unknown, path: string[], value: unknown): unknown {
  const [head, ...rest] = path;
  const obj: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  if (rest.length === 0) {
    if (value === undefined) delete obj[head!];
    else obj[head!] = value;
    return obj;
  }
  const child = emptyToUndefined(setIn(obj[head!], rest, value));
  if (child === undefined) delete obj[head!];
  else obj[head!] = child;
  return obj;
}

function emptyToUndefined(value: unknown): unknown {
  const empty = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  return empty ? undefined : value;
}

const NUMERIC_FIELDS = new Set([
  "temperature",
  "top_p",
  "top_k",
  "tfs_z",
  "repeat_penalty",
  "repeat_last_n",
  "seed",
  "mirostat",
  "mirostat_eta",
  "mirostat_tau",
  "num_ctx",
  "num_predict",
  "num_gpu",
  "num_thread",
  "x",
  "y",
  "model_timeout_seconds",
  "max_history_turns",
  "max_retries",
  "retry_backoff_seconds",
  "max_iterations",
  "max_chars",
  "max_concurrency",
]);
const LIST_FIELDS = new Set(["depends_on", "stop", "remember"]);
const BOOLEAN_FIELDS = new Set(["include_history", "strip_reasoning"]);

/**
 * Converts a typed-in string into the value a field expects: numbers for
 * numeric settings, comma-separated lists for depends_on/stop, and
 * `unset`/`null`/`-` to clear the field. keep_alive stays a string unless
 * it is a plain integer (Ollama accepts both "5m" and 300).
 */
export function coerceFieldValue(path: string, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "unset" || trimmed === "null" || trimmed === "-") return undefined;
  const leaf = resolveNodeFieldPath(path).at(-1)!;
  if (LIST_FIELDS.has(leaf)) {
    return trimmed === "" ? [] : trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (NUMERIC_FIELDS.has(leaf)) {
    const n = Number(trimmed);
    if (trimmed === "" || Number.isNaN(n)) throw new DraftError(`'${leaf}' needs a number, got '${raw}'`);
    return n;
  }
  if (BOOLEAN_FIELDS.has(leaf)) {
    const lower = trimmed.toLowerCase();
    if (["true", "yes", "on", "1"].includes(lower)) return true;
    if (["false", "no", "off", "0"].includes(lower)) return false;
    if (lower === "inherit" || lower === "default") return undefined;
    throw new DraftError(`'${leaf}' is on or off, got '${raw}'`);
  }
  if (leaf === "keep_alive" && /^-?\d+$/.test(trimmed)) return Number(trimmed);
  return raw;
}
