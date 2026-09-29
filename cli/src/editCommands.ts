import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin } from "node:process";
import chalk from "chalk";
import {
  DraftError,
  PipelineApiError,
  RequestCancelledError,
  addNode,
  applyPreset,
  buildGraphModel,
  connect,
  detailFromDefinition,
  disconnect,
  displayModel,
  duplicateNode,
  effectiveModel,
  expectationParts,
  makeExpectation,
  removeTestCase,
  setTestJudge,
  testCases,
  upsertTestCase,
  findNode,
  modelIdentity,
  modelWithIdentity,
  newDefinition,
  parseModelIdentity,
  presetFromNode,
  removeNode,
  setNodeProperty,
  setOutput,
} from "@llm-pipeline/client";
import type {
  CaseResult,
  EvalExpectation,
  ExpectationKind,
  NodeConfig,
  NodeModelConfig,
  NodePreset,
  PipelineClient,
  PipelineDefinition,
} from "@llm-pipeline/client";
import { renderGraphText } from "./graphRenderer.js";
import { coerceFieldValue, resolveNodeFieldPath, setNodeFieldByPath, setPipelineSettingByPath } from "./fieldPaths.js";
import type { LineSource } from "./input.js";

/**
 * Pipeline editing from the terminal: load a pipeline (or start a new
 * one) into a local draft, change nodes with /set, /prompt, /node add|rm,
 * /connect…, then /validate and /save it back to the server.
 *
 * Every mutation goes through @llm-pipeline/client's draftOps — the same
 * functions the web editor uses — and nothing is validated locally: the
 * server's validator decides, and /validate or /save shows what it says.
 */

export interface EditSession {
  draft: PipelineDefinition;
  /** Revision the draft was loaded from; null for a pipeline not saved yet. */
  baseRevision: string | null;
  dirty: boolean;
}

export interface EditContext {
  client: PipelineClient;
  input: LineSource;
  /** Runs `work` so that Ctrl+C stops it (via the signal) instead of
   * quitting the CLI. */
  stoppable: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  activePipeline: () => string;
  /** Called after a save or /edit, so runs and /pipeline use that pipeline. */
  switchPipeline: (name: string) => Promise<void>;
  /** The server's default pipeline — where to go after deleting the active one. */
  defaultPipeline: () => Promise<string>;
  session: EditSession | undefined;
}

export const EDIT_HELP = `
${chalk.bold("Editing pipelines:")}
  ${chalk.yellow("/edit [name]")}                   load a pipeline (default: the active one) into a draft
  ${chalk.yellow("/new <name> [--from <preset>]")}  start a new pipeline draft with one node (blank, or from a preset)
  ${chalk.yellow("/node")}                          list the draft's nodes
  ${chalk.yellow("/node <id>")}                     show one node's full configuration
  ${chalk.yellow("/node add <id> [--after a,b] [--model m] [--from <preset>]")}
  ${chalk.yellow("/node rm <id>")}                  remove a node (and edges/routes to it)
  ${chalk.yellow("/dup <node> [new-id]")}           duplicate a node: same settings and inputs, runs beside it
  ${chalk.yellow("/set <node>.<field> <value>")}    e.g. /set reconcile.temperature 0.3
                                    fields: model ("default" = pipeline default), temperature,
                                    system, prompt, deps, id, history (on/off), reasoning
                                    (strip on/off/inherit),
                                    options.<num_ctx|top_p|top_k|num_predict|seed|stop|
                                    repeat_penalty|keep_alive|format|mirostat|…>
                                    value "unset" clears a field
  ${chalk.yellow("/settings")}                      show pipeline-wide settings (execution, history, defaults)
  ${chalk.yellow("/settings set <setting> <value>")}  change one, e.g. /settings set history.max_chars 4000
                                    description, execution.<timeout|retries|max_concurrency|…>,
                                    history.<max_turns|intro|turn_template|max_chars|remember|
                                    summarize.model|summarize.prompt>,
                                    defaults.<model|temperature|system_prompt|strip_reasoning|options.*>
  ${chalk.yellow("/prompt <node> [system]")}        edit a prompt in $EDITOR (or type lines, end with ".")
  ${chalk.yellow("/connect <from> <to>")}           make <to> depend on <from>
  ${chalk.yellow("/disconnect <from> <to>")}
  ${chalk.yellow("/output <node>[,<node>…]")}       set the output node(s)
  ${chalk.yellow("/models")}                        models this server lets you select
  ${chalk.yellow("/validate")}                      check the draft on the server
  ${chalk.yellow("/save [name]")}                   save the draft (a new name saves a copy; comments in the file are kept)
  ${chalk.yellow("/discard")}                       drop the draft
  ${chalk.yellow("/preset")}                        list presets: a node's model, prompts and settings, reusable anywhere
  ${chalk.yellow("/preset save <node> [name] [--description text…]")}
  ${chalk.yellow("/preset show <name>")}            everything a preset carries
  ${chalk.yellow("/preset add <name> [--id x] [--after a,b]")}   add a node from it to the draft
  ${chalk.yellow("/preset apply <name> <node>")}    give a node a preset's configuration
  ${chalk.yellow("/preset rm <name>")}
  ${chalk.yellow("/test")}                          list the test cases (the draft's, or the active pipeline's)
  ${chalk.yellow("/test run [case]")}               run them all, or one — the draft as it is, no save needed
  ${chalk.yellow("/test add")}                      add a case: a message, then what its answer must satisfy
  ${chalk.yellow("/test rm <case>")}                remove a case
  ${chalk.yellow("/test judge <model|unset>")}      the model that grades "judge" expectations
  ${chalk.yellow("/compare <node> <model> [<model>…]")}  run every case as is, and with each model for <node>
  ${chalk.yellow("/import <file.yaml>")}            load a pipeline file into a draft
  ${chalk.yellow("/export <file.yaml>")}            write the draft (or active pipeline) as YAML
`;

const EDIT_COMMANDS = new Set([
  "/edit",
  "/new",
  "/node",
  "/set",
  "/settings",
  "/prompt",
  "/connect",
  "/disconnect",
  "/output",
  "/models",
  "/validate",
  "/save",
  "/discard",
  "/dup",
  "/preset",
  "/test",
  "/compare",
  "/import",
  "/export",
]);

export function isEditCommand(line: string): boolean {
  return EDIT_COMMANDS.has(line.split(/\s+/, 1)[0]!);
}

/** Splits `--flag value` pairs out of an argument list. */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[arg.slice(2)] = next;
        i++;
      } else {
        flags[arg.slice(2)] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function note(text: string): void {
  console.log(chalk.gray(text) + "\n");
}

function requireSession(ctx: EditContext): EditSession {
  if (!ctx.session) {
    throw new DraftError('no draft open — start with "/edit" or "/new <name>"');
  }
  return ctx.session;
}

function update(ctx: EditContext, draft: PipelineDefinition): void {
  const session = requireSession(ctx);
  session.draft = draft;
  session.dirty = true;
}

function formatNodesTable(def: PipelineDefinition): string {
  const outputs = new Set(def.output_nodes);
  const rows = def.nodes.map((n) => [
    (outputs.has(n.id) ? "★ " : "  ") + n.id,
    displayModel(def, n),
    String(effectiveModel(def, n)?.temperature ?? "-"),
    (n.depends_on ?? []).join(", ") || "-",
  ]);
  const header = ["  node", "model", "temp", "depends on"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [chalk.bold(line(header)), ...rows.map((r) => line(r))].join("\n");
}

function formatSettings(def: PipelineDefinition): string {
  const exec = def.execution ?? {};
  const history = def.history ?? {};
  const defaults = def.defaults ?? {};
  const row = (label: string, value: unknown) =>
    `  ${chalk.gray(label.padEnd(26))} ${value === undefined || value === "" ? chalk.gray("—") : String(value)}`;
  const options = Object.entries(defaults.model?.options ?? {})
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join("  ");
  return [
    chalk.bold.cyan("execution"),
    row("model_timeout_seconds", exec.model_timeout_seconds),
    row("max_retries", exec.max_retries),
    row("retry_backoff_seconds", exec.retry_backoff_seconds),
    row("max_concurrency", exec.max_concurrency ?? "no limit"),
    row("run_timeout_seconds", exec.run_timeout_seconds ?? "no limit"),
    chalk.bold.cyan("history"),
    row("max_turns", history.max_turns ?? 6),
    row("max_chars", history.max_chars ?? "no limit"),
    row("intro", history.intro),
    row("turn_template", history.turn_template?.replace(/\n/g, "\\n")),
    row("remember", (history.remember ?? []).join(", ")),
    row("summarize.model", history.summarize ? modelIdentity(history.summarize.model) : "off"),
    chalk.bold.cyan("defaults"),
    row("model", defaults.model ? modelIdentity(defaults.model) : "none"),
    row("temperature", defaults.model?.temperature),
    row("options", options),
    row("system_prompt", defaults.system_prompt),
    row("strip_reasoning", defaults.strip_reasoning ?? false),
  ].join("\n");
}

function formatBlock(label: string, text: string | undefined): string[] {
  if (text === undefined || text === "") return [`${chalk.gray(label)} ${chalk.gray("(none)")}`];
  return [chalk.gray(label), ...text.replace(/\n$/, "").split("\n").map((l) => "  " + l)];
}

function formatNode(def: PipelineDefinition, node: NodeConfig): string {
  const isOutput = def.output_nodes.includes(node.id);
  const model = effectiveModel(def, node);
  const options = model?.options ?? {};
  const optionText = Object.entries(options)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join("  ");
  return [
    chalk.bold.cyan(node.id) + (isOutput ? chalk.magenta("  ★ output") : ""),
    `${chalk.gray("depends on:")}  ${(node.depends_on ?? []).join(", ") || "-"}`,
    `${chalk.gray("model:")}       ${displayModel(def, node)}`,
    `${chalk.gray("temperature:")} ${model?.temperature ?? "-"}${node.model?.temperature === undefined ? chalk.gray(" (inherited)") : ""}`,
    `${chalk.gray("options:")}     ${optionText || "(model defaults)"}`,
    `${chalk.gray("history:")}     ${node.include_history === false ? "off — sees only the new message" : "on"}`,
    `${chalk.gray("reasoning:")}   ${
      (node.strip_reasoning ?? def.defaults?.strip_reasoning) ? "stripped" : "kept"
    }${node.strip_reasoning === undefined ? chalk.gray(" (pipeline default)") : ""}`,
    ...(node.labels
      ? [`${chalk.gray("labels:")}      ${node.labels.join(", ")} ${chalk.gray("— answers exactly one")}`]
      : []),
    ...formatBlock(
      node.system_prompt === undefined && def.defaults?.system_prompt ? "system prompt (pipeline default):" : "system prompt:",
      node.system_prompt ?? def.defaults?.system_prompt
    ),
    ...formatBlock("prompt template:", node.prompt_template),
  ].join("\n");
}

/** Opens `initial` in $VISUAL/$EDITOR; falls back to typing lines ending
 * with a single "." when neither is set. Returns undefined if unchanged. */
async function editText(ctx: EditContext, initial: string, label: string): Promise<string | undefined> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    const dir = mkdtempSync(join(tmpdir(), "llm-pipeline-"));
    const file = join(dir, `${label}.txt`);
    writeFileSync(file, initial);
    ctx.input.pause();
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(false);
    try {
      const result = spawnSync(editor, [file], { stdio: "inherit", shell: true });
      if (result.status !== 0) throw new DraftError(`editor exited with status ${result.status}`);
      const edited = readFileSync(file, "utf8");
      return edited === initial ? undefined : edited;
    } finally {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      ctx.input.resume();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(chalk.gray(`current ${label}:`));
  console.log(initial ? initial.replace(/\n$/, "") : chalk.gray("(empty)"));
  console.log(chalk.gray('type the new text; finish with a line containing only "." (empty = keep)'));
  const lines: string[] = [];
  while (true) {
    const line = await ctx.input.ask(chalk.gray("… "));
    if (line === null || line === ".") break;
    lines.push(line);
  }
  return lines.length === 0 ? undefined : lines.join("\n") + "\n";
}

/** For /new: the model the active pipeline already uses (a known-good
 * choice), else the first model the server lists. */
async function defaultModel(ctx: EditContext): Promise<NodeModelConfig> {
  const inUse = ctx.session?.draft.nodes.find((n) => n.model)?.model;
  if (inUse) return { ...inUse };
  try {
    const active = await ctx.client.getPipeline(ctx.activePipeline());
    const model = active.definition.nodes.find((n) => n.model)?.model;
    if (model) return { provider: model.provider, name: model.name, temperature: model.temperature ?? 0.2 };
  } catch {
    // fall through to the server's model list
  }
  try {
    const { providers } = await ctx.client.listModels();
    const first = providers.find((p) => p.provider === "ollama" && p.models.length > 0)?.models[0];
    if (first) return { provider: "ollama", name: first.name, temperature: 0.2 };
  } catch {
    // fall through to a placeholder the user can change with /set
  }
  return { provider: "ollama", name: "llama3", temperature: 0.2 };
}

async function confirm(ctx: EditContext, question: string): Promise<boolean> {
  const answer = await ctx.input.ask(chalk.yellow(`${question} [y/N] `));
  return (answer ?? "").trim().toLowerCase().startsWith("y");
}

function describeServerError(err: unknown): string {
  if (err instanceof PipelineApiError) {
    const node = typeof err.details?.node_id === "string" ? ` [node: ${err.details.node_id}]` : "";
    return (err.serverMessage ?? err.message) + node;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------

async function loadForEditing(ctx: EditContext, name: string): Promise<void> {
  const loaded = await ctx.client.getPipeline(name);
  ctx.session = {
    draft: loaded.definition,
    baseRevision: loaded.revision,
    dirty: false,
  };
  if (name !== ctx.activePipeline()) await ctx.switchPipeline(name);
  console.log(formatNodesTable(loaded.definition));
  note(
    `editing "${name}" — change it with /set, /prompt, /node add|rm, /connect; ` +
      `then /validate and /save`
  );
}

async function validateDraft(ctx: EditContext): Promise<void> {
  const session = requireSession(ctx);
  try {
    const result = await ctx.client.validatePipeline({ format: "json", definition: session.draft });
    console.log(chalk.green("✓ valid"));
    for (const issue of [...result.model_issues, ...(result.warnings ?? [])]) {
      console.log(chalk.yellow(`! ${issue.message}`));
    }
    console.log();
  } catch (err) {
    console.log(chalk.red(`✕ ${describeServerError(err)}`) + "\n");
  }
}

async function saveDraft(ctx: EditContext, newName?: string): Promise<void> {
  const session = requireSession(ctx);
  let draft = session.draft;
  let baseRevision = session.baseRevision;
  if (newName && newName !== draft.name) {
    draft = { ...draft, name: newName };
    baseRevision = null; // "save as" creates a new pipeline
  }

  try {
    const saved =
      baseRevision === null
        ? await ctx.client.createPipeline(draft)
        : await ctx.client.updatePipeline(draft, { baseRevision });
    ctx.session = { draft: saved.definition, baseRevision: saved.revision, dirty: false };
    await ctx.switchPipeline(saved.definition.name);
    console.log(chalk.green(`✓ saved "${saved.definition.name}"`) + chalk.gray(" — new runs use it"));
    if (saved.comments_preserved === false) {
      console.log(chalk.yellow("! the file's comments couldn't be kept — it was rewritten in canonical form"));
    }
    console.log();
  } catch (err) {
    console.log(chalk.red(`✕ not saved: ${describeServerError(err)}`));
    if (err instanceof PipelineApiError && err.code === "ALREADY_EXISTS") {
      console.log(chalk.gray(`  use /edit ${draft.name} to load the existing pipeline, or /save <other-name>`));
    }
    console.log();
  }
}

async function handleNodeCommand(ctx: EditContext, args: string[]): Promise<void> {
  const session = requireSession(ctx);
  const [sub, ...rest] = args;
  if (!sub) {
    console.log(formatNodesTable(session.draft) + "\n");
    return;
  }

  if (sub === "add") {
    const { positional, flags } = parseFlags(rest);
    const from = flags.from ?? flags.preset;
    const preset = from ? (await ctx.client.getPreset(from)).preset : undefined;
    const model: NodeModelConfig | undefined = flags.model
      ? { ...parseModelIdentity(flags.model), temperature: 0.2 }
      : undefined;
    const { definition, id } = addNode(session.draft, {
      ...(positional[0] ? { id: positional[0] } : {}),
      after: flags.after ? flags.after.split(",").map((s) => s.trim()).filter(Boolean) : [],
      ...(model ? { model } : {}),
      ...(preset ? { preset } : {}),
    });
    update(ctx, definition);
    return note(`added node "${id}" — /node ${id} to see it, /prompt ${id} to write its prompt`);
  }

  if (sub === "rm") {
    const id = rest[0];
    if (!id) throw new DraftError("usage: /node rm <id>");
    update(ctx, removeNode(session.draft, id));
    return note(`removed node "${id}"`);
  }

  const node = findNode(session.draft, sub);
  console.log(formatNode(session.draft, node));
  const running = effectiveModel(session.draft, node);
  if (running?.provider === "ollama") {
    try {
      const limits = await ctx.client.getModelLimits(running.name);
      const parts = [
        limits.context_length ? `max context ${limits.context_length.toLocaleString("en-US")}` : null,
        limits.parameter_size,
        limits.quantization,
      ].filter(Boolean);
      if (parts.length > 0) console.log(`${chalk.gray("model limits:")} ${parts.join(" · ")}`);
    } catch {
      // limits are a hint only (model not installed, or Ollama unreachable)
    }
  }
  console.log();
}

/** The definition tests run against: the draft while editing, else the
 * active pipeline as saved. */
async function testedDefinition(ctx: EditContext): Promise<PipelineDefinition> {
  return ctx.session?.draft ?? (await ctx.client.getPipeline(ctx.activePipeline())).definition;
}

const EXPECTATION_PREFIX: Record<string, ExpectationKind> = {
  contains: "contains",
  not: "not_contains",
  not_contains: "not_contains",
  check: "check",
  judge: "judge",
};

function formatExpectation(expectation: EvalExpectation): string {
  const { kind, value } = expectationParts(expectation);
  return `${chalk.gray(kind === "not_contains" ? "doesn't contain" : kind)} ${value}`;
}

function formatCaseResult(result: CaseResult, showAnswer: boolean): string {
  const state = result.error
    ? chalk.red("✗ error")
    : result.passed === null
      ? chalk.cyan("• answered")
      : result.passed
        ? chalk.green("✓ passed")
        : chalk.red(`✗ failed ${result.expectations.filter((e) => !e.passed).length}/${result.expectations.length}`);
  const tokens = result.prompt_tokens + result.completion_tokens;
  const lines = [
    `  ${state}  ${chalk.bold(result.case)} ${chalk.gray("·")} ${result.variant} ` +
      chalk.gray(`(${(result.duration_ms / 1000).toFixed(1)}s${tokens ? `, ${tokens.toLocaleString("en-US")} tok` : ""})`),
  ];
  if (result.error) lines.push(chalk.red(`      ${result.error}`));
  for (const e of result.expectations.filter((x) => !x.passed)) {
    lines.push(chalk.red(`      ✗ ${e.kind} ${e.expected}`) + (e.detail ? chalk.gray(` — ${e.detail.split("\n").join(" ")}`) : ""));
  }
  if (showAnswer && result.answer) {
    const answer = result.answer.replace(/\s+/g, " ").trim();
    lines.push(chalk.gray(`      ${answer.length > 160 ? `${answer.slice(0, 159)}…` : answer}`));
  }
  return lines.join("\n");
}

async function runTestCases(
  ctx: EditContext,
  cases: string[] | undefined,
  variants: { label: string; models: Record<string, NodeModelConfig> }[]
): Promise<void> {
  const definition = await testedDefinition(ctx);
  const total = (cases ?? testCases(definition)).length * (variants.length + 1);
  console.log(chalk.gray(`running ${total} case run${total === 1 ? "" : "s"} of "${definition.name}"${ctx.session?.dirty ? " (unsaved draft)" : ""}…`));
  try {
    await ctx.stoppable(async (signal) => {
    for await (const event of ctx.client.runTests({ definition, ...(cases ? { cases } : {}), variants }, { signal })) {
      if (event.type === "case_result") {
        console.log(formatCaseResult(event.data, event.data.passed === null || variants.length > 0));
      } else if (event.type === "tests_done") {
        console.log();
        for (const s of event.data.summaries) {
          const checked = s.passed + s.failed + s.errors;
          console.log(
            `  ${chalk.bold(s.variant)}: ` +
              (checked > 0 ? `${s.passed}/${checked} passed` : "no checks") +
              chalk.gray(` · ${(s.duration_ms / 1000).toFixed(1)}s · ${(s.prompt_tokens + s.completion_tokens).toLocaleString("en-US")} tok`)
          );
        }
        console.log();
      }
    }
    });
  } catch (err) {
    if (err instanceof RequestCancelledError) {
      console.log(chalk.yellow("■ stopped") + chalk.gray(" — the cases that finished are shown above") + "\n");
      return;
    }
    console.log(chalk.red(`✕ ${describeServerError(err)}`) + "\n");
  }
}

async function handleTestCommand(ctx: EditContext, args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (sub === "add") {
    const session = requireSession(ctx);
    const name = ((await ctx.input.ask(chalk.cyan("case name: "))) ?? "").trim();
    const input = ((await ctx.input.ask(chalk.cyan("message: "))) ?? "").trim();
    if (!name || !input) return note("not added — a case needs a name and a message");
    console.log(
      chalk.gray('what must the answer satisfy? one per line — "contains: …", "not: …", "check: <condition on output>", "judge: …"; empty line to finish')
    );
    const expect: EvalExpectation[] = [];
    while (true) {
      const line = ((await ctx.input.ask(chalk.cyan("  › "))) ?? "").trim();
      if (!line) break;
      const match = /^([a-z_]+)\s*:\s*(.+)$/.exec(line);
      const kind = match ? EXPECTATION_PREFIX[match[1]!] : undefined;
      if (!match || !kind) {
        console.log(chalk.yellow('    start with "contains:", "not:", "check:" or "judge:"'));
        continue;
      }
      expect.push(makeExpectation(kind, match[2]!));
    }
    update(ctx, upsertTestCase(session.draft, { name, input, expect }));
    const needsJudge = expect.some((e) => e.judge !== undefined) && !session.draft.tests?.judge;
    return note(`added test case "${name}"${needsJudge ? " — set a judge model with /test judge <model>" : ""} — /test run ${name} to run it`);
  }

  if (sub === "rm") {
    const name = rest.join(" ");
    const session = requireSession(ctx);
    if (!testCases(session.draft).some((c) => c.name === name)) throw new DraftError(`no test case named '${name}'`);
    update(ctx, removeTestCase(session.draft, name));
    return note(`removed test case "${name}"`);
  }

  if (sub === "judge") {
    const identity = rest[0];
    if (!identity) throw new DraftError("usage: /test judge <provider:model|unset>");
    const session = requireSession(ctx);
    const judge = session.draft.tests?.judge?.model;
    update(ctx, setTestJudge(session.draft, identity === "unset" ? undefined : modelWithIdentity(judge, identity)));
    return note(identity === "unset" ? "judge model removed" : `judge model: ${identity}`);
  }

  if (sub === "run") {
    const name = rest.join(" ");
    return runTestCases(ctx, name ? [name] : undefined, []);
  }

  if (sub) throw new DraftError("usage: /test [run [case] | add | rm <case> | judge <model|unset>]");
  const definition = await testedDefinition(ctx);
  const cases = testCases(definition);
  if (cases.length === 0) note("no test cases yet — /test add (while editing: /edit)");
  for (const c of cases) {
    console.log(`  ${chalk.blue(c.name)}  ${chalk.gray("›")} ${c.input}`);
    for (const e of c.expect ?? []) console.log(`      ${formatExpectation(e)}`);
  }
  if (definition.tests?.judge) console.log(chalk.gray(`  judge: ${modelIdentity(definition.tests.judge.model)}`));
  if (cases.length > 0) console.log();
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function formatPresetLine(p: NodePreset): string {
  const tags = [
    p.model.temperature !== undefined ? `T ${p.model.temperature}` : null,
    p.prompt_template === undefined ? "no prompt" : null,
    p.include_history === false ? "no history" : null,
    p.strip_reasoning ? "strips reasoning" : null,
  ].filter(Boolean);
  return (
    `  ${chalk.blue(p.name)}  ${modelIdentity(p.model)}` +
    chalk.gray(`${tags.length ? `  [${tags.join(", ")}]` : ""}${p.description ? `  — ${p.description}` : ""}`)
  );
}

function formatPreset(p: NodePreset): string {
  const options = Object.entries(p.model.options ?? {})
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join("  ");
  return [
    chalk.bold.blue(p.name) + (p.description ? chalk.gray(`  — ${p.description}`) : ""),
    `${chalk.gray("model:")}       ${modelIdentity(p.model)}`,
    `${chalk.gray("temperature:")} ${p.model.temperature ?? "-"}`,
    `${chalk.gray("options:")}     ${options || "(model defaults)"}`,
    `${chalk.gray("history:")}     ${p.include_history === false ? "off — sees only the new message" : "on"}`,
    `${chalk.gray("reasoning:")}   ${
      p.strip_reasoning === undefined ? "pipeline default" : p.strip_reasoning ? "stripped" : "kept"
    }`,
    ...formatBlock("system prompt:", p.system_prompt),
    ...(p.prompt_template === undefined
      ? [chalk.gray("prompt template: (not saved — applying keeps the node's own)")]
      : formatBlock("prompt template:", p.prompt_template)),
  ].join("\n");
}

const PRESET_USAGE =
  "usage: /preset [save <node> [name] [--description text…] | show <name> | add <name> [--id x] [--after a,b] | apply <name> <node> | rm <name>]";

/** Presets: a node's whole configuration, saved on the server to reuse in
 * any pipeline. */
async function handlePresetCommand(ctx: EditContext, args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "list") {
    const { presets } = await ctx.client.listPresets();
    if (presets.length === 0) return note("no presets yet — /preset save <node> [name] to add one");
    for (const p of presets) console.log(formatPresetLine(p));
    console.log();
    return;
  }

  if (sub === "save") {
    const session = requireSession(ctx);
    const at = rest.indexOf("--description");
    const description = at >= 0 ? rest.slice(at + 1).join(" ") : "";
    const [nodeId, name = nodeId] = at >= 0 ? rest.slice(0, at) : rest;
    if (!nodeId || !name) throw new DraftError(PRESET_USAGE);
    const preset = presetFromNode(session.draft, nodeId, name, { description });
    const { presets } = await ctx.client.listPresets();
    if (presets.some((p) => p.name === name) && !(await confirm(ctx, `replace the preset "${name}"?`))) {
      return note("not saved");
    }
    try {
      await ctx.client.savePreset(preset);
      return note(`saved "${nodeId}" as the preset "${name}" — /preset add ${name} to use it in any pipeline`);
    } catch (err) {
      console.log(chalk.red(`✕ not saved: ${describeServerError(err)}`) + "\n");
      return;
    }
  }

  if (sub === "show" && rest[0]) {
    console.log(formatPreset((await ctx.client.getPreset(rest[0])).preset) + "\n");
    return;
  }

  if (sub === "add" && rest[0]) {
    const session = requireSession(ctx);
    const { positional, flags } = parseFlags(rest);
    const { preset } = await ctx.client.getPreset(positional[0]!);
    const { definition, id } = addNode(session.draft, {
      ...(flags.id ? { id: flags.id } : {}),
      after: splitList(flags.after),
      preset,
    });
    update(ctx, definition);
    const node = findNode(definition, id);
    return note(
      `added "${id}" from the preset "${positional[0]}"` +
        ((node.depends_on ?? []).length ? ` (inputs: ${node.depends_on!.join(", ")})` : "") +
        ` — /node ${id} to see it`
    );
  }

  if (sub === "apply" && rest[0] && rest[1]) {
    const session = requireSession(ctx);
    const { preset } = await ctx.client.getPreset(rest[0]);
    update(ctx, applyPreset(session.draft, rest[1], preset));
    return note(`"${rest[1]}" now has the configuration of "${rest[0]}" (a copy — later changes to the preset won't change it)`);
  }

  if (sub === "rm" && rest[0]) {
    const name = rest[0];
    if (!(await confirm(ctx, `remove the preset "${name}"?`))) return note("not removed");
    try {
      const deleted = await ctx.client.deletePreset(name);
      return note(`removed "${name}" (pipelines using it keep their copy; recoverable: presets/${deleted.recoverable_as})`);
    } catch (err) {
      console.log(chalk.red(`✕ not removed: ${describeServerError(err)}`) + "\n");
      return;
    }
  }

  throw new DraftError(PRESET_USAGE);
}

/** /pipeline rm: deletes a pipeline after asking (the server moves it to
 * pipelines/.deleted/). Errors are printed, never thrown. */
export async function removePipeline(ctx: EditContext, name: string | undefined): Promise<void> {
  if (!name) {
    console.log(chalk.yellow("usage: /pipeline rm <name>") + "\n");
    return;
  }
  if (!(await confirm(ctx, `delete pipeline "${name}"? (it's moved to pipelines/.deleted/)`))) return note("not deleted");
  const revision = ctx.session?.draft.name === name ? (ctx.session.baseRevision ?? undefined) : undefined;
  try {
    const deleted = await ctx.client.deletePipeline(name, revision);
    if (ctx.session?.draft.name === name) ctx.session = undefined;
    if (ctx.activePipeline() === name) await ctx.switchPipeline(await ctx.defaultPipeline());
    note(`deleted "${name}" (recoverable: pipelines/${deleted.recoverable_as})`);
  } catch (err) {
    console.log(chalk.red(`✕ not deleted: ${describeServerError(err)}`) + "\n");
  }
}

/**
 * Runs one edit command. Returns false if `line` isn't an edit command.
 * DraftErrors (bad input) and server errors are printed, never thrown.
 */
export async function handleEditCommand(ctx: EditContext, line: string): Promise<boolean> {
  if (!isEditCommand(line)) return false;
  const [command, ...args] = line.split(/\s+/);

  try {
    switch (command) {
      case "/edit":
        await loadForEditing(ctx, args[0] ?? ctx.activePipeline());
        break;

      case "/new": {
        const { positional, flags } = parseFlags(args);
        const name = positional[0];
        if (!name) throw new DraftError("usage: /new <name> [--from <preset>]");
        const preset = flags.from ? (await ctx.client.getPreset(flags.from)).preset : undefined;
        ctx.session = {
          draft: newDefinition(name, await defaultModel(ctx), preset),
          baseRevision: null,
          dirty: true,
        };
        console.log(formatNodesTable(ctx.session.draft));
        note(`new pipeline "${name}" (not saved yet) — add nodes with /node add, then /save`);
        break;
      }

      case "/discard":
        if (ctx.session?.dirty && !(await confirm(ctx, "discard unsaved changes?"))) break;
        ctx.session = undefined;
        note("draft discarded");
        break;

      case "/node":
        await handleNodeCommand(ctx, args);
        break;

      case "/set": {
        const [target, ...valueParts] = args;
        const dot = target?.indexOf(".") ?? -1;
        if (!target || dot <= 0 || valueParts.length === 0) {
          throw new DraftError("usage: /set <node>.<field> <value>   e.g. /set answer.temperature 0.7");
        }
        const nodeId = target.slice(0, dot);
        const path = target.slice(dot + 1);
        const raw = line.slice(line.indexOf(target) + target.length).trim();
        const session = requireSession(ctx);
        const value = coerceFieldValue(path, raw);
        update(ctx, setNodeFieldByPath(session.draft, nodeId, path, value));
        const shown = value === undefined ? "(unset)" : JSON.stringify(value);
        note(`${nodeId}.${resolveNodeFieldPath(path).join(".")} = ${shown}`);
        break;
      }

      case "/settings": {
        const [sub, path, ...valueParts] = args;
        if (!sub) {
          console.log(formatSettings(requireSession(ctx).draft) + "\n");
          break;
        }
        if (sub !== "set" || !path || valueParts.length === 0) {
          throw new DraftError("usage: /settings set <setting> <value>   e.g. /settings set history.max_chars 4000");
        }
        const session = requireSession(ctx);
        const raw = line.slice(line.indexOf(path) + path.length).trim();
        const value = coerceFieldValue(path, raw);
        update(ctx, setPipelineSettingByPath(session.draft, path, value));
        note(`${path} = ${value === undefined ? "(unset)" : JSON.stringify(value)}`);
        break;
      }

      case "/prompt": {
        const [nodeId, which] = args;
        if (!nodeId) throw new DraftError("usage: /prompt <node> [system]");
        const session = requireSession(ctx);
        const node = findNode(session.draft, nodeId);
        const isSystem = which === "system";
        const current = (isSystem ? node.system_prompt : node.prompt_template) ?? "";
        const edited = await editText(ctx, current, isSystem ? "system-prompt" : "prompt-template");
        if (edited === undefined) {
          note("unchanged");
          break;
        }
        update(
          ctx,
          isSystem
            ? setNodeProperty(session.draft, nodeId, "system_prompt", edited.trim() === "" ? undefined : edited)
            : setNodeProperty(session.draft, nodeId, "prompt_template", edited)
        );
        note(`updated ${isSystem ? "system prompt" : "prompt template"} of "${nodeId}"`);
        break;
      }

      case "/connect":
      case "/disconnect": {
        const [from, to] = args;
        if (!from || !to) throw new DraftError(`usage: ${command} <from> <to>`);
        const session = requireSession(ctx);
        update(ctx, command === "/connect" ? connect(session.draft, from, to) : disconnect(session.draft, from, to));
        note(command === "/connect" ? `"${to}" now depends on "${from}"` : `removed ${from} → ${to}`);
        break;
      }

      case "/output": {
        if (!args[0]) throw new DraftError("usage: /output <node>[,<node>…]");
        const session = requireSession(ctx);
        update(ctx, setOutput(session.draft, args[0].split(",").map((s) => s.trim()).filter(Boolean)));
        note(`output node: ${args[0]}`);
        break;
      }

      case "/models": {
        const { providers } = await ctx.client.listModels({ refresh: true });
        for (const p of providers) {
          const status = p.reachable ? "" : chalk.red(`  (${p.error ?? "unreachable"})`);
          console.log(chalk.bold.cyan(p.provider) + status);
          for (const m of p.models) {
            const meta = [m.parameter_size, m.quantization].filter(Boolean).join(", ");
            console.log(`  ${p.provider}:${m.name}${meta ? chalk.gray(`  ${meta}`) : ""}`);
          }
        }
        console.log();
        break;
      }

      case "/validate":
        await validateDraft(ctx);
        break;

      case "/save":
        await saveDraft(ctx, args[0]);
        break;

      case "/dup": {
        const [nodeId, newId] = args;
        if (!nodeId) throw new DraftError("usage: /dup <node> [new-id]");
        const { definition, id } = duplicateNode(requireSession(ctx).draft, nodeId, newId ? { id: newId } : {});
        update(ctx, definition);
        note(`duplicated "${nodeId}" as "${id}" — same settings and inputs; /connect ${id} <node> to use its output`);
        break;
      }

      case "/preset":
        await handlePresetCommand(ctx, args);
        break;

      case "/test":
        await handleTestCommand(ctx, args);
        break;

      case "/compare": {
        const [node, ...models] = args;
        if (!node || models.length === 0) throw new DraftError("usage: /compare <node> <model> [<model>…]");
        const definition = await testedDefinition(ctx);
        findNode(definition, node);
        await runTestCases(
          ctx,
          undefined,
          models.map((identity) => ({ label: parseModelIdentity(identity).name, models: { [node]: parseModelIdentity(identity) } }))
        );
        break;
      }

      case "/import": {
        const file = args[0];
        if (!file) throw new DraftError("usage: /import <file.yaml>");
        const { definition } = await ctx.client.validatePipeline({ format: "yaml", text: readFileSync(file, "utf8") });
        let baseRevision: string | null = null;
        try {
          const existing = await ctx.client.getPipeline(definition.name);
          baseRevision = existing.revision;
          console.log(chalk.yellow(`! a pipeline named "${definition.name}" exists — /save will replace it`));
        } catch {
          // new pipeline
        }
        ctx.session = { draft: definition, baseRevision, dirty: true };
        console.log(formatNodesTable(definition));
        note(`imported "${definition.name}" from ${file} (not saved yet)`);
        break;
      }

      case "/export": {
        const file = args[0];
        if (!file) throw new DraftError("usage: /export <file.yaml>");
        const definition = ctx.session?.draft ?? (await ctx.client.getPipeline(ctx.activePipeline())).definition;
        const { yaml } = await ctx.client.validatePipeline({ format: "json", definition });
        writeFileSync(file, yaml);
        note(`wrote "${definition.name}" to ${file}`);
        break;
      }
    }
  } catch (err) {
    if (err instanceof DraftError) {
      console.log(chalk.yellow(err.message) + "\n");
    } else {
      console.log(chalk.red(`error: ${describeServerError(err)}`) + "\n");
    }
  }
  return true;
}

/** The draft's diagram, for /pipeline while editing. */
export function draftDiagram(session: EditSession): string[] {
  const graph = buildGraphModel(detailFromDefinition(session.draft));
  return renderGraphText(graph);
}
