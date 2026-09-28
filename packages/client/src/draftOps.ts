import type {
  BranchConfig,
  BranchRoute,
  EvalCase,
  EvalExpectation,
  ExpectationKind,
  LoopConfig,
  ExecutionConfig,
  HistoryConfig,
  NodeConfig,
  NodeDefaults,
  NodeLayout,
  NodeModelConfig,
  NodePreset,
  OllamaOptions,
  PipelineDefinition,
  ProviderType,
  TestsConfig,
} from "./types.js";
import { PROVIDERS } from "./types.js";

/**
 * Pure, immutable edit operations on a PipelineDefinition draft — the one
 * implementation both the web editor's reducer and the CLI's edit commands
 * call, so "remove a node" or "rename a node" means the same thing in both.
 *
 * Deliberately NO semantic validation here (cycles, dangling references,
 * template references…): the server's validator is the single source of
 * truth for that, and clients show what it reports. These functions only
 * keep the draft's own cross-references consistent when the user edits it
 * (e.g. renaming a node also renames it everywhere it is referenced).
 */

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What the server accepts as a saved node's (preset's) name. */
export const PRESET_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

export function nodeIds(def: PipelineDefinition): string[] {
  return def.nodes.map((n) => n.id);
}

export function findNode(def: PipelineDefinition, id: string): NodeConfig {
  const node = def.nodes.find((n) => n.id === id);
  if (!node) throw new DraftError(`no node '${id}' (nodes: ${nodeIds(def).join(", ") || "none"})`);
  return node;
}

export function outputCandidates(def: PipelineDefinition): string[] {
  return Array.isArray(def.output_node) ? def.output_node : [def.output_node];
}

/** "provider:model", e.g. "ollama:gemma3:12b" (model names may contain ':'). */
export function modelIdentity(model: NodeModelConfig | undefined): string {
  return model ? `${model.provider}:${model.model}` : "(no model)";
}

const DEFAULT_TEMPERATURE = 0.2;

/** The model a node runs with once pipeline defaults apply — for display.
 * Mirrors the server's rules (pipeline_config/effective.py): no own model →
 * the default model; an own model inherits the default temperature if it
 * sets none and, when both are Ollama, the Ollama options it doesn't set. */
export function effectiveModel(def: PipelineDefinition, node: NodeConfig): NodeModelConfig | undefined {
  const fallback = def.defaults?.model;
  const base = node.model ?? fallback;
  if (!base) return undefined;
  const temperature = base.temperature ?? fallback?.temperature ?? DEFAULT_TEMPERATURE;
  let options = base.options;
  if (node.model && fallback && node.model.provider === "ollama" && fallback.provider === "ollama" && fallback.options) {
    options = { ...fallback.options, ...(node.model.options ?? {}) };
  }
  return { ...base, temperature, ...(options ? { options } : {}) };
}

/** True when the node has no model of its own and uses the pipeline default. */
export function inheritsModel(node: NodeConfig): boolean {
  return node.model === undefined;
}

/** Parses "provider:model". A bare name with no known provider prefix is
 * taken as an Ollama model ("gemma3:12b" -> ollama / gemma3:12b). */
export function parseModelIdentity(identity: string): { provider: ProviderType; model: string } {
  const trimmed = identity.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon);
    if ((PROVIDERS as readonly string[]).includes(prefix)) {
      const model = trimmed.slice(colon + 1);
      if (!model) throw new DraftError(`missing model name in '${identity}'`);
      return { provider: prefix as ProviderType, model };
    }
  }
  if (!trimmed) throw new DraftError("model name is empty");
  return { provider: "ollama", model: trimmed };
}

/** A node id not used yet: `base`, then `base_2`, `base_3`, … */
export function uniqueNodeId(def: PipelineDefinition, base = "node"): string {
  const taken = new Set(nodeIds(def));
  const clean = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1") || "node";
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) {
    const candidate = `${clean}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function checkNodeId(id: string): void {
  if (!NODE_ID_PATTERN.test(id)) {
    throw new DraftError(
      `invalid node id '${id}' — use a letter or '_' followed by letters, digits or '_'`
    );
  }
}

function mapNode(
  def: PipelineDefinition,
  id: string,
  update: (node: NodeConfig) => NodeConfig
): PipelineDefinition {
  findNode(def, id);
  return { ...def, nodes: def.nodes.map((n) => (n.id === id ? update(n) : n)) };
}

// ---------------------------------------------------------------------------
// Whole-pipeline operations
// ---------------------------------------------------------------------------

/** A new one-node pipeline — the smallest definition the server accepts.
 * Its node is a blank "answer" node, or a copy of a saved node. */
export function newDefinition(name: string, model: NodeModelConfig, preset?: NodePreset): PipelineDefinition {
  const empty: PipelineDefinition = { name, description: "", version: 1, nodes: [], output_node: "" };
  const { definition, id } = addNode(empty, {
    ...(preset ? { preset } : { id: "answer", model }),
    layout: { x: 0, y: 0 },
  });
  return { ...definition, output_node: id };
}

export function setOutput(def: PipelineDefinition, ids: string | string[]): PipelineDefinition {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) throw new DraftError("at least one output node is required");
  for (const id of list) findNode(def, id);
  return { ...def, output_node: list.length === 1 ? list[0]! : list };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface AddNodeOptions {
  id?: string;
  after?: string[];
  model?: NodeModelConfig;
  layout?: { x: number; y: number };
  preset?: NodePreset;
}

/** Adds an llm_call node. With `after`, it depends on those nodes and its
 * starting prompt references each of their outputs. Returns the new id. */
export function addNode(
  def: PipelineDefinition,
  opts: AddNodeOptions = {}
): { definition: PipelineDefinition; id: string } {
  const id = opts.id ?? uniqueNodeId(def, opts.preset?.name ?? "node");
  checkNodeId(id);
  if (def.nodes.some((n) => n.id === id)) throw new DraftError(`node '${id}' already exists`);
  const after = opts.after ?? [];
  for (const dep of after) findNode(def, dep);

  // With a pipeline default model, a new node simply inherits it; without
  // one it copies another node's model so it's runnable straight away.
  const fallbackModel = def.nodes.find((n) => n.model)?.model;
  const model = opts.model ?? (def.defaults?.model ? undefined : (fallbackModel ?? { provider: "ollama", model: "llama3" }));
  const refs = after.map((dep) => `{{ ${dep}.output }}`).join("\n\n");
  let node: NodeConfig = {
    id,
    depends_on: [...after],
    ...(model
      ? {
          model: {
            provider: model.provider,
            model: model.model,
            ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
          },
        }
      : {}),
    prompt_template: refs ? `{{ input }}\n\n${refs}` : "{{ input }}",
    ...(opts.layout ? { layout: opts.layout } : {}),
  };
  if (opts.preset) node = fitSavedPrompt(def, presetApplied(node, opts.preset), opts.preset);
  return { definition: { ...def, nodes: [...def.nodes, node] }, id };
}

/**
 * Copies a node — model, prompts, every setting and its inputs — under a
 * new id (`answer` → `answer_2`). The copy runs in parallel with the
 * original: same depends_on, nothing depends on it yet, and branches,
 * loops and output settings stay with the original. Placed beside the
 * original unless `layout` says where.
 */
export function duplicateNode(
  def: PipelineDefinition,
  id: string,
  opts: { id?: string; layout?: NodeLayout } = {}
): { definition: PipelineDefinition; id: string } {
  const original = findNode(def, id);
  const newId = opts.id ?? uniqueNodeId(def, id.replace(/_\d+$/, ""));
  checkNodeId(newId);
  if (def.nodes.some((n) => n.id === newId)) throw new DraftError(`node '${newId}' already exists`);
  const layout = opts.layout ?? (original.layout ? { x: original.layout.x + 260, y: original.layout.y } : undefined);
  const { layout: _dropped, ...settings } = clone(original);
  const copy: NodeConfig = { ...settings, id: newId, ...(layout ? { layout } : {}) };
  const at = def.nodes.indexOf(original) + 1;
  return { definition: { ...def, nodes: [...def.nodes.slice(0, at), copy, ...def.nodes.slice(at)] }, id: newId };
}

/** `route` without `id` among its targets — gone entirely when that was
 * its only target, and a plain id again when one target is left. */
function withoutTarget(route: BranchRoute, id: string): BranchRoute[] {
  if (typeof route.to === "string") return route.to === id ? [] : [route];
  const left = route.to.filter((t) => t !== id);
  if (left.length === 0) return [];
  return [{ ...route, to: left.length === 1 ? left[0]! : left }];
}

/** Removes a node and every structural reference to it: other nodes'
 * depends_on, branch routes / branches from it, loops touching it, and
 * output candidates. Template text referencing it is left alone — the
 * server's validation then points at exactly those prompts to fix. */
export function removeNode(def: PipelineDefinition, id: string): PipelineDefinition {
  findNode(def, id);
  if (def.nodes.length === 1) throw new DraftError("a pipeline needs at least one node");

  const nodes = def.nodes
    .filter((n) => n.id !== id)
    .map((n) =>
      n.depends_on?.includes(id) ? { ...n, depends_on: n.depends_on.filter((d) => d !== id) } : n
    );
  const branches = (def.branches ?? [])
    .filter((b) => b.from !== id)
    .map((b) => ({ ...b, routes: b.routes.flatMap((r) => withoutTarget(r, id)) }))
    .filter((b) => b.routes.length > 0);
  const loops = (def.loops ?? []).filter(
    (l) => l.from !== id && l.back_to !== id && l.exit_to !== id
  );

  let outputs = outputCandidates(def).filter((o) => o !== id);
  if (outputs.length === 0) {
    // Fall back to a sink (a node nothing depends on), so the draft keeps
    // a plausible output instead of an empty one.
    const dependedOn = new Set(nodes.flatMap((n) => n.depends_on ?? []));
    const sink = [...nodes].reverse().find((n) => !dependedOn.has(n.id)) ?? nodes[nodes.length - 1]!;
    outputs = [sink.id];
  }

  return {
    ...def,
    nodes,
    ...(def.branches ? { branches } : {}),
    ...(def.loops ? { loops } : {}),
    ...(def.history?.remember
      ? { history: { ...def.history, remember: def.history.remember.filter((r) => r !== id) } }
      : {}),
    output_node: outputs.length === 1 ? outputs[0]! : outputs,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrites template references to `oldId` — `{{ oldId.output }}` and
 * `oldId is defined` guards — to `newId`. */
export function renameTemplateRefs(template: string, oldId: string, newId: string): string {
  const pattern = new RegExp(
    `\\b${escapeRegExp(oldId)}\\b(?=\\s*\\.\\s*output\\b|\\s+is\\s+(?:not\\s+)?defined\\b)`,
    "g"
  );
  return template.replace(pattern, newId);
}

/** Renames a node everywhere it's referenced: dependencies, templates,
 * branches, loops and output candidates. */
export function renameNode(def: PipelineDefinition, oldId: string, newId: string): PipelineDefinition {
  findNode(def, oldId);
  if (oldId === newId) return def;
  checkNodeId(newId);
  if (def.nodes.some((n) => n.id === newId)) throw new DraftError(`node '${newId}' already exists`);
  const swap = (id: string): string => (id === oldId ? newId : id);

  return {
    ...def,
    nodes: def.nodes.map((n) => ({
      ...n,
      id: swap(n.id),
      ...(n.depends_on ? { depends_on: n.depends_on.map(swap) } : {}),
      prompt_template: renameTemplateRefs(n.prompt_template, oldId, newId),
    })),
    ...(def.branches
      ? {
          branches: def.branches.map((b) => ({
            ...b,
            from: swap(b.from),
            routes: b.routes.map((r) => ({ ...r, to: typeof r.to === "string" ? swap(r.to) : r.to.map(swap) })),
          })),
        }
      : {}),
    ...(def.loops
      ? {
          loops: def.loops.map((l) => ({
            ...l,
            from: swap(l.from),
            back_to: swap(l.back_to),
            exit_to: swap(l.exit_to),
          })),
        }
      : {}),
    ...(def.history?.remember ? { history: { ...def.history, remember: def.history.remember.map(swap) } } : {}),
    output_node: Array.isArray(def.output_node) ? def.output_node.map(swap) : swap(def.output_node),
  };
}

/** Adds `from` to `to`'s depends_on (drawing an edge from -> to). */
export function connect(def: PipelineDefinition, from: string, to: string): PipelineDefinition {
  findNode(def, from);
  if (from === to) throw new DraftError(`node '${from}' can't depend on itself`);
  return mapNode(def, to, (n) =>
    n.depends_on?.includes(from) ? n : { ...n, depends_on: [...(n.depends_on ?? []), from] }
  );
}

export function disconnect(def: PipelineDefinition, from: string, to: string): PipelineDefinition {
  return mapNode(def, to, (n) => ({ ...n, depends_on: (n.depends_on ?? []).filter((d) => d !== from) }));
}

export function moveNode(def: PipelineDefinition, id: string, x: number, y: number): PipelineDefinition {
  return mapNode(def, id, (n) => ({ ...n, layout: { x: Math.round(x), y: Math.round(y) } }));
}

// ---------------------------------------------------------------------------
// Settings — typed: what a field is called and what it takes are checked at
// compile time. (The CLI turns its typed-in `/set node.field value` paths
// into these; see cli/src/fieldPaths.ts.)
// ---------------------------------------------------------------------------

/** A model block switched to another "provider:model" — a model picker's
 * value — keeping its temperature, and its Ollama options only while it
 * stays on Ollama (the server rejects options for other providers). */
export function modelWithIdentity(current: NodeModelConfig | undefined, identity: string): NodeModelConfig {
  const { provider, model } = parseModelIdentity(identity);
  const keepOptions = provider === "ollama" && current?.options;
  return {
    provider,
    model,
    ...(current?.temperature !== undefined ? { temperature: current.temperature } : {}),
    ...(keepOptions ? { options: current!.options } : {}),
  };
}

/** A model block with one Ollama option set (or, with `undefined`, cleared);
 * an emptied options block is dropped. */
export function modelWithOption<K extends keyof OllamaOptions>(
  model: NodeModelConfig,
  key: K,
  value: OllamaOptions[K]
): NodeModelConfig {
  const { options: current, ...rest } = model;
  const options = withField(current ?? {}, key, value);
  return Object.keys(options).length > 0 ? { ...rest, options } : rest;
}

/** A node's settings besides its id (renameNode() updates every reference
 * to it) and its model (setNodeModel() / updateNodeModel()). */
export type NodeProperty = Exclude<keyof NodeConfig, "id" | "model">;

/** Sets (or, with `undefined`, clears) one of a node's settings. A required
 * one, like `prompt_template`, can't be cleared. */
export function setNodeProperty<K extends NodeProperty>(
  def: PipelineDefinition,
  id: string,
  key: K,
  value: NodeConfig[K]
): PipelineDefinition {
  return mapNode(def, id, (node) => withField(node, key, value));
}

/** Gives a node its own model, or — with `undefined` — makes it use the
 * pipeline's default model (which it then needs). */
export function setNodeModel(
  def: PipelineDefinition,
  id: string,
  model: NodeModelConfig | undefined
): PipelineDefinition {
  if (model === undefined) {
    if (!def.defaults?.model) throw new DraftError("the pipeline has no default model to inherit");
    return mapNode(def, id, ({ model: _dropped, ...rest }) => rest);
  }
  return mapNode(def, id, (n) => ({ ...n, model }));
}

/** Changes a node's own model — its temperature, options, … A node that
 * uses the pipeline default has none to change: give it one first. */
export function updateNodeModel(
  def: PipelineDefinition,
  id: string,
  change: (model: NodeModelConfig) => NodeModelConfig
): PipelineDefinition {
  return mapNode(def, id, (node) => {
    if (!node.model) {
      throw new DraftError(`node '${id}' uses the pipeline's default model — give it a model of its own first`);
    }
    return { ...node, model: change(node.model) };
  });
}

/** The pipeline-wide settings, by section. */
export interface PipelineSections {
  execution: ExecutionConfig;
  defaults: NodeDefaults;
  history: HistoryConfig;
}

export type PipelineSection = keyof PipelineSections;

/** Sets (or, with `undefined`, clears) one pipeline-wide setting, e.g.
 * `setPipelineSetting(def, "history", "max_chars", 4000)`. An emptied
 * section is dropped. */
export function setPipelineSetting<S extends PipelineSection, K extends keyof PipelineSections[S]>(
  def: PipelineDefinition,
  section: S,
  key: K,
  value: PipelineSections[S][K]
): PipelineDefinition {
  const settings = withField((def[section] ?? {}) as PipelineSections[S], key, value);
  const { [section]: _old, ...rest } = def;
  return (Object.keys(settings).length > 0 ? { ...rest, [section]: settings } : rest) as PipelineDefinition;
}

/** `target` with `key` set to `value`, or removed when `value` is undefined
 * — so a cleared setting is gone, not present as `undefined`. */
function withField<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): T {
  const next = { ...target };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** The node takes the saved node's configuration: model, system prompt,
 * history and reasoning settings — unset ones back to their defaults — and
 * its prompt, when it saved one. Id, inputs and position stay. */
function presetApplied(node: NodeConfig, preset: NodePreset): NodeConfig {
  const { system_prompt: _s, include_history: _h, strip_reasoning: _r, ...rest } = node;
  return {
    ...rest,
    model: clone(preset.model),
    ...(preset.system_prompt !== undefined ? { system_prompt: preset.system_prompt } : {}),
    ...(preset.prompt_template !== undefined ? { prompt_template: preset.prompt_template } : {}),
    ...(preset.include_history === false ? { include_history: false } : {}),
    ...(preset.strip_reasoning !== undefined ? { strip_reasoning: preset.strip_reasoning } : {}),
  };
}

/** Node ids a template reads: `{{ x.output }}` references, and names
 * only checked with `x is defined` (loop back-references). */
export function templateNodeRefs(template: string): { outputs: Set<string>; guarded: Set<string> } {
  const outputs = new Set([...template.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*output\b/g)].map((m) => m[1]!));
  const guarded = new Set([...template.matchAll(/\b([A-Za-z_]\w*)\s+is\s+(?:not\s+)?defined\b/g)].map((m) => m[1]!));
  return { outputs, guarded };
}

/**
 * Fits a saved node's prompt into this pipeline. A saved prompt still
 * names the nodes it was written for (`{{ draft.output }}`):
 * - when it names exactly one node this pipeline doesn't have, and the
 *   node has exactly one input the prompt doesn't use yet, the reference
 *   is pointed at that input;
 * - every referenced node that exists becomes an input (except loop
 *   back-references guarded by `is defined`, which must not).
 * Anything still unresolved is left for the server's validation to point
 * at.
 */
function fitSavedPrompt(def: PipelineDefinition, node: NodeConfig, preset: NodePreset): NodeConfig {
  if (preset.prompt_template === undefined) return node;
  const existing = new Set(nodeIds(def).filter((id) => id !== node.id));
  const deps = node.depends_on ?? [];
  let template = node.prompt_template;
  let refs = templateNodeRefs(template);
  const named = new Set([...refs.outputs, ...refs.guarded]);
  const missing = [...named].filter((r) => r !== node.id && !existing.has(r));
  const unusedInputs = deps.filter((d) => !named.has(d));
  if (missing.length === 1 && unusedInputs.length === 1) {
    template = renameTemplateRefs(template, missing[0]!, unusedInputs[0]!);
    refs = templateNodeRefs(template);
  }
  const wired = [...refs.outputs].filter((r) => existing.has(r) && !refs.guarded.has(r) && !deps.includes(r));
  return { ...node, prompt_template: template, depends_on: [...deps, ...wired] };
}

/** Gives a node a saved node's configuration (see presetApplied), fitting
 * a saved prompt to the node's inputs. The node keeps no link to the saved
 * node — later edits to it don't affect this pipeline. */
export function applyPreset(def: PipelineDefinition, id: string, preset: NodePreset): PipelineDefinition {
  return mapNode(def, id, (n) => fitSavedPrompt(def, presetApplied(n, preset), preset));
}

/**
 * A saved node (preset) capturing everything a node runs with, so it
 * behaves the same in any pipeline: the model it really uses (a pipeline
 * default it inherits is written out), its system prompt (or the pipeline
 * default's), its prompt, and its history and reasoning settings.
 */
export function presetFromNode(
  def: PipelineDefinition,
  id: string,
  name: string,
  opts: { description?: string; includePrompt?: boolean } = {}
): NodePreset {
  const node = findNode(def, id);
  if (!PRESET_NAME_PATTERN.test(name)) {
    throw new DraftError(`invalid name '${name}' — use letters, digits, '-' and '_'`);
  }
  const model = effectiveModel(def, node);
  if (!model) throw new DraftError(`node '${id}' has no model to save`);
  const systemPrompt = node.system_prompt ?? def.defaults?.system_prompt;
  const stripReasoning = node.strip_reasoning ?? (def.defaults?.strip_reasoning ? true : undefined);
  const description = opts.description?.trim();
  return {
    name,
    ...(description ? { description } : {}),
    model: clone(model),
    ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    ...(opts.includePrompt !== false ? { prompt_template: node.prompt_template } : {}),
    ...(node.include_history === false ? { include_history: false } : {}),
    ...(stripReasoning !== undefined ? { strip_reasoning: stripReasoning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Branches and loops (edited as whole records by the web inspector)
// ---------------------------------------------------------------------------

export function upsertBranch(def: PipelineDefinition, branch: BranchConfig, previousId?: string): PipelineDefinition {
  const key = previousId ?? branch.id;
  const existing = def.branches ?? [];
  const found = existing.some((b) => b.id === key);
  return {
    ...def,
    branches: found ? existing.map((b) => (b.id === key ? branch : b)) : [...existing, branch],
  };
}

export function removeBranch(def: PipelineDefinition, id: string): PipelineDefinition {
  return { ...def, branches: (def.branches ?? []).filter((b) => b.id !== id) };
}

export function upsertLoop(def: PipelineDefinition, loop: LoopConfig, previousId?: string): PipelineDefinition {
  const key = previousId ?? loop.id;
  const existing = def.loops ?? [];
  const found = existing.some((l) => l.id === key);
  return {
    ...def,
    loops: found ? existing.map((l) => (l.id === key ? loop : l)) : [...existing, loop],
  };
}

export function removeLoop(def: PipelineDefinition, id: string): PipelineDefinition {
  return { ...def, loops: (def.loops ?? []).filter((l) => l.id !== id) };
}

// ---------------------------------------------------------------------------
// Test cases (the pipeline's `tests` block)
// ---------------------------------------------------------------------------

export const EXPECTATION_KINDS: readonly ExpectationKind[] = ["contains", "not_contains", "check", "judge"];

export function testCases(def: PipelineDefinition): EvalCase[] {
  return def.tests?.cases ?? [];
}

/** Which kind an expectation is, and its value. */
export function expectationParts(expectation: EvalExpectation): { kind: ExpectationKind; value: string } {
  const kind = EXPECTATION_KINDS.find((k) => expectation[k] !== undefined) ?? "contains";
  return { kind, value: expectation[kind] ?? "" };
}

export function makeExpectation(kind: ExpectationKind, value: string): EvalExpectation {
  return { [kind]: value };
}

/** Keeps the tests block minimal: no empty case list, and no block at all
 * for a pipeline without tests. */
function withTests(def: PipelineDefinition, tests: TestsConfig): PipelineDefinition {
  const { tests: _old, ...rest } = def;
  const { cases, ...others } = tests;
  const kept: TestsConfig = cases && cases.length > 0 ? { ...others, cases } : others;
  return Object.keys(kept).length === 0 ? rest : { ...rest, tests: kept };
}

/** A name no case uses yet: "case 1", "case 2", … */
export function uniqueCaseName(def: PipelineDefinition, base = "case"): string {
  const taken = new Set(testCases(def).map((c) => c.name));
  for (let i = 1; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Adds a case, or replaces the one named `previousName` (renaming it). */
export function upsertTestCase(def: PipelineDefinition, testCase: EvalCase, previousName?: string): PipelineDefinition {
  const name = testCase.name.trim();
  if (!name) throw new DraftError("a test case needs a name");
  const cases = testCases(def);
  const key = previousName ?? name;
  if (name !== key && cases.some((c) => c.name === name)) throw new DraftError(`a test case named '${name}' exists`);
  const clean: EvalCase = { ...testCase, name };
  if (clean.expect && clean.expect.length === 0) delete clean.expect;
  const found = cases.some((c) => c.name === key);
  const next = found ? cases.map((c) => (c.name === key ? clean : c)) : [...cases, clean];
  return withTests(def, { ...def.tests, cases: next });
}

export function removeTestCase(def: PipelineDefinition, name: string): PipelineDefinition {
  return withTests(def, { ...def.tests, cases: testCases(def).filter((c) => c.name !== name) });
}

/** Sets the model that grades `judge` expectations, or — with
 * `undefined` — removes the judge. */
export function setTestJudge(def: PipelineDefinition, model: NodeModelConfig | undefined): PipelineDefinition {
  const { judge, ...tests } = def.tests ?? {};
  if (model === undefined) return withTests(def, tests);
  return withTests(def, { ...tests, judge: { ...judge, model } });
}
