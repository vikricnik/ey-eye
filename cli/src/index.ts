import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import {
  PipelineClient,
  PipelineApiError,
  buildGraphModel,
  createGraphViewState,
  appendNodeText,
  applyStreamEvent,
  applyStreamError,
  applyStreamStopped,
  RequestCancelledError,
} from "@llm-pipeline/client";
import {
  formatAskResponse,
  formatPreview,
  formatHealth,
  formatPipelineList,
  formatPipelineDetail,
  contextWarnings,
  nodeStats,
} from "./formatter.js";
import { renderGraphText } from "./graphRenderer.js";
import { EDIT_HELP, draftDiagram, handleEditCommand } from "./editCommands.js";
import { LineInput } from "./input.js";
import type { EditContext } from "./editCommands.js";
import type {
  AskOptions,
  ConversationTurn,
  RequestOptions,
  GraphModel,
  GraphViewState,
  NodeOutput,
} from "@llm-pipeline/client";

const BASE_URL = process.env.PIPELINE_BASE_URL ?? "http://localhost:8000";
const API_KEY = process.env.PIPELINE_API_KEY; // only needed if the server has API_KEYS configured

function helpText(activePipeline: string): string {
  return `
${chalk.bold("Commands:")}
  ${chalk.yellow("/help")}              show this help
  ${chalk.yellow("/health")}            show server info and available pipelines
  ${chalk.yellow("/pipelines")}         list available pipelines
  ${chalk.yellow("/pipeline")}          show the active pipeline's DAG diagram (nodes + edges)
  ${chalk.yellow("/use <name>")}         switch pipelines (clears conversation history)
  ${chalk.yellow("/verbose")}           toggle showing every node's output vs. just the final answer
  ${chalk.yellow("/stream")}            toggle live diagram updates as the pipeline runs, instead of waiting
  ${chalk.yellow("/reset")}             clear conversation history (start fresh)
  ${chalk.yellow("/rerun <node>")}       run the last message again from <node> — the nodes before it
                      reuse their outputs; the new answer replaces the last one
  ${chalk.yellow("/preview <node> [message]")}  what <node> would receive: for [message], or else the
                      last message with the last run's outputs (uses your draft while editing)
  ${chalk.yellow("/exit")}              quit (also: Ctrl+D, or Ctrl+C at the prompt — during a run, Ctrl+C stops the run)
${EDIT_HELP}
Currently using pipeline: ${chalk.blue(activePipeline)}

Anything else you type is sent to the active pipeline as a prompt, with prior
turns in this session included as conversation context.
`;
}

/** What a run leaves behind: its answer for the conversation (when it
 * finished) and each node's latest output (for a failed run, the nodes
 * that finished) — what /rerun and /preview reuse. */
interface RunResult {
  turn?: ConversationTurn;
  outputs: Record<string, string>;
}

/** The last run of the active pipeline, as /rerun resends it. */
interface LastRun {
  prompt: string;
  history: ConversationTurn[];
  outputs: Record<string, string>;
}

/** Fetches a pipeline's structure and builds its GraphModel — cached by
 * the caller so a streaming run doesn't need to re-fetch it (User Story
 * 3's independent test explicitly requires this). Returns undefined (and
 * prints an inline error marker, per FR-015) on failure rather than
 * throwing, since a failed structure fetch shouldn't block the pipeline
 * switch/startup that triggered it — /pipeline and streaming just fall
 * back to having no diagram to show. */
async function loadGraph(client: PipelineClient, name: string): Promise<GraphModel | undefined> {
  try {
    const detail = await client.getPipelineDetail(name);
    return buildGraphModel(detail);
  } catch (err) {
    printError(err);
    return undefined;
  }
}

async function main(): Promise<void> {
  const client = new PipelineClient(BASE_URL, API_KEY);
  let verbose = false;
  let streaming = false;
  let activePipeline: string;
  let activeGraph: GraphModel | undefined;
  const history: ConversationTurn[] = [];
  let lastRun: LastRun | undefined;

  console.log(chalk.bold.cyan("\nLLM Pipeline CLI"));
  console.log(chalk.gray(`connected to ${BASE_URL}`));
  console.log(chalk.gray('type "/help" for commands, "/exit" to quit\n'));

  try {
    const health = await client.checkHealth();
    activePipeline = health.default_pipeline_name;
    console.log(formatHealth(health));
    console.log();
    console.log(chalk.gray(`Using pipeline "${activePipeline}" — switch with /use <name>\n`));
    activeGraph = await loadGraph(client, activePipeline);
  } catch (err) {
    printError(err);
    console.log(
      chalk.yellow("Continuing anyway — you can still try prompts once the server is up.\n")
    );
    activePipeline = "simple-local"; // best-effort fallback if the server was unreachable at startup
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const input = new LineInput(rl, stdout);

  // Ctrl+C stops the run in progress; at the prompt it quits. (readline
  // reports it for a terminal; piped input gets the process signal.)
  let running: AbortController | undefined;
  const onInterrupt = () => {
    if (running) {
      running.abort();
      return;
    }
    console.log(chalk.gray("\ngoodbye"));
    rl.close();
    process.exit(0);
  };
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);
  const stoppable = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    running = controller;
    try {
      return await work(controller.signal);
    } finally {
      if (running === controller) running = undefined;
    }
  };

  const editCtx: EditContext = {
    client,
    input,
    stoppable,
    session: undefined,
    activePipeline: () => activePipeline,
    defaultPipeline: async () => (await client.checkHealth()).default_pipeline_name,
    switchPipeline: async (name: string) => {
      if (name !== activePipeline) {
        history.length = 0;
        lastRun = undefined;
      }
      activePipeline = name;
      activeGraph = await loadGraph(client, name);
    },
  };

  /** Runs `prompt` with the conversation `before` it; a finished run's
   * answer follows `before` in the history (for a re-run, that replaces the
   * answer it re-ran). */
  const sendMessage = async (prompt: string, before: ConversationTurn[], options: AskOptions = {}) => {
    const result = await stoppable((signal) =>
      streaming
        ? handlePromptStreaming(client, prompt, activePipeline, activeGraph, verbose, before, { ...options, signal })
        : handlePrompt(client, prompt, activePipeline, verbose, before, { ...options, signal })
    );
    if (!result) return;
    lastRun = { prompt, history: before, outputs: result.outputs };
    if (result.turn) history.splice(0, history.length, ...before, result.turn);
  };

  while (true) {
    const session = editCtx.session;
    const label = session
      ? `${session.draft.name} ✎${session.dirty ? "*" : ""}`
      : activePipeline;
    const line = await input.ask(chalk.bold.green(`(${label}) › `));
    if (line === null) break; // Ctrl+D, or the end of piped input
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed === "/exit") {
      break;
    }

    if (trimmed === "/help") {
      console.log(helpText(activePipeline));
      continue;
    }

    if (trimmed === "/verbose") {
      verbose = !verbose;
      console.log(chalk.gray(`verbose mode: ${verbose ? "on" : "off"}\n`));
      continue;
    }

    if (trimmed === "/stream") {
      streaming = !streaming;
      console.log(chalk.gray(`streaming mode: ${streaming ? "on" : "off"}\n`));
      continue;
    }

    if (trimmed === "/reset") {
      history.length = 0;
      lastRun = undefined;
      console.log(chalk.gray("conversation history cleared\n"));
      continue;
    }

    if (trimmed === "/health") {
      try {
        const health = await client.checkHealth();
        console.log(formatHealth(health));
        console.log();
      } catch (err) {
        printError(err);
      }
      continue;
    }

    if (trimmed === "/pipelines") {
      try {
        const { pipelines } = await client.listPipelines();
        console.log(formatPipelineList(pipelines));
        console.log();
      } catch (err) {
        printError(err);
      }
      continue;
    }

    if (trimmed === "/rerun" || trimmed.startsWith("/rerun ")) {
      const node = trimmed.slice("/rerun".length).trim();
      if (!node) {
        console.log(chalk.yellow("usage: /rerun <node>") + "\n");
      } else if (!lastRun) {
        console.log(chalk.yellow("nothing to re-run yet — send a message first") + "\n");
      } else {
        if (editCtx.session?.dirty) {
          console.log(chalk.yellow(`! re-running the saved "${activePipeline}" — /save to use your edits`));
        }
        console.log(chalk.gray(`↻ re-running "${lastRun.prompt}" from ${node}`));
        const previous = lastRun;
        await sendMessage(previous.prompt, previous.history, {
          rerun: { from_node: node, outputs: previous.outputs },
        });
      }
      continue;
    }

    if (trimmed === "/preview" || trimmed.startsWith("/preview ")) {
      const [node, ...words] = trimmed.slice("/preview".length).trim().split(/\s+/).filter(Boolean);
      if (!node) {
        console.log(chalk.yellow("usage: /preview <node> [message]") + "\n");
        continue;
      }
      const message = words.join(" ");
      try {
        const definition =
          editCtx.session?.draft ?? (await client.getPipelineDefinition(activePipeline)).definition;
        const preview = await client.previewPrompt({
          definition,
          node_id: node,
          prompt: message || lastRun?.prompt || "",
          history: message ? history : (lastRun?.history ?? []),
          outputs: lastRun?.outputs ?? {},
        });
        console.log(formatPreview(node, preview, message ? "your message" : lastRun ? "the last message" : null));
      } catch (err) {
        printError(err);
      }
      continue;
    }

    if (await handleEditCommand(editCtx, trimmed)) {
      continue;
    }

    if (trimmed === "/pipeline" && editCtx.session) {
      console.log(chalk.bold.cyan(`${editCtx.session.draft.name} (draft)`));
      console.log(draftDiagram(editCtx.session).join("\n"));
      console.log();
      continue;
    }

    if (trimmed === "/pipeline") {
      try {
        const detail = await client.getPipelineDetail(activePipeline);
        console.log(formatPipelineDetail(detail));
        console.log();
      } catch (err) {
        printError(err);
      }
      continue;
    }

    if (trimmed.startsWith("/use ")) {
      const requestedName = trimmed.slice("/use ".length).trim();
      if (!requestedName) {
        console.log(chalk.yellow('usage: /use <pipeline-name> (see "/pipelines" for options)\n'));
        continue;
      }
      if (editCtx.session?.dirty) {
        const answer = await input.ask(
          chalk.yellow(`discard unsaved changes to "${editCtx.session.draft.name}"? [y/N] `)
        );
        if (!(answer ?? "").trim().toLowerCase().startsWith("y")) continue;
      }
      editCtx.session = undefined;
      try {
        // Confirm the pipeline actually exists before switching — fails
        // clearly now rather than on the next prompt.
        const detail = await client.getPipelineDetail(requestedName);
        activePipeline = requestedName;
        activeGraph = buildGraphModel(detail);
        history.length = 0; // different pipeline = different context; don't carry old turns forward
        lastRun = undefined;
        console.log(chalk.gray(`switched to pipeline "${activePipeline}" — conversation history cleared\n`));
      } catch (err) {
        activeGraph = undefined;
        printError(err);
      }
      continue;
    }

    // A mistyped command (e.g. "/sav") shouldn't be sent to the model as a
    // prompt. Only bare "/word" shapes count — "/usr/bin/…" still goes through.
    if (/^\/[a-z][a-z-]*(\s|$)/.test(trimmed)) {
      console.log(chalk.yellow(`unknown command ${trimmed.split(/\s+/, 1)[0]} — see /help`) + "\n");
      continue;
    }

    if (editCtx.session?.dirty) {
      console.log(
        chalk.yellow(`! running the saved "${activePipeline}" — /save to run your unsaved edits`)
      );
    }

    await sendMessage(trimmed, history.slice());
  }

  rl.close();
  console.log(chalk.gray("goodbye"));
}

async function handlePrompt(
  client: PipelineClient,
  prompt: string,
  pipelineName: string,
  verbose: boolean,
  history: ConversationTurn[],
  options: AskOptions & RequestOptions = {}
): Promise<RunResult | undefined> {
  const spinner = startSpinner("thinking");
  const startedAt = Date.now();

  try {
    const response = await client.ask(prompt, pipelineName, history, options);
    const elapsedMs = Date.now() - startedAt;
    stopSpinner(spinner);
    console.log();
    console.log(formatAskResponse(response, verbose, elapsedMs));
    console.log();
    // Only the final answer (the output_node's result) is kept as context
    // for the next turn — intermediate node outputs aren't carried forward.
    // Remembered node outputs travel with the turn (the pipeline's history.remember).
    return {
      turn: { prompt, final_answer: response.final_answer, outputs: response.remembered ?? {} },
      outputs: Object.fromEntries(
        Object.values(response.node_outputs).map((node) => [node.node_id, node.output])
      ),
    };
  } catch (err) {
    stopSpinner(spinner);
    if (err instanceof RequestCancelledError) {
      console.log(chalk.yellow("■ stopped") + chalk.gray(" — nothing was added to the conversation") + "\n");
    } else {
      printError(err);
    }
    return undefined;
  }
}

/** Wraps any caught value into a PipelineApiError so applyStreamError()
 * always has a `.message`/`.details` to read. */
function toApiError(err: unknown): PipelineApiError {
  if (err instanceof PipelineApiError) return err;
  return new PipelineApiError(err instanceof Error ? err.message : String(err));
}

/**
 * Redraws the live graph diagram in place: erases exactly the lines the
 * previous call printed (tracked in `printedLines`), then prints `lines`
 * fresh. On a terminal resize mid-run, a partial cursor-relative clear
 * based on the OLD (stale) line count would be wrong — wrapping at the
 * new width means the previous content may no longer occupy that many
 * terminal rows — so a resize instead triggers a full screen clear
 * (`console.clear()`) and starts the tracked count over from zero.
 */
class DiagramRedraw {
  private printedLines = 0;
  private resized = false;
  private readonly onResize = (): void => {
    this.resized = true;
  };

  start(): void {
    stdout.on("resize", this.onResize);
  }

  stop(): void {
    stdout.off("resize", this.onResize);
  }

  private lastFrame: string[] = [];

  async print(lines: string[]): Promise<void> {
    await this.erase();
    for (const line of lines) {
      console.log(line);
    }
    this.printedLines = lines.length;
    this.lastFrame = lines;
  }

  /** Prints `text` permanently above the redraw region: erases the region,
   * prints the text, then redraws the last frame below it — so the next
   * redraw can't overwrite it. */
  async printAbove(text: string): Promise<void> {
    await this.erase();
    console.log(text);
    await this.print(this.lastFrame);
  }

  private async erase(): Promise<void> {
    if (this.resized) {
      console.clear();
      this.printedLines = 0;
      this.resized = false;
    } else if (this.printedLines > 0) {
      const out = new readline.Readline(stdout);
      await out.moveCursor(0, -this.printedLines).clearScreenDown().commit();
      this.printedLines = 0;
    }
  }
}

/**
 * Streaming variant. When the active pipeline's structure is known
 * (`graph`), redraws its diagram in place — live per-node status, taken
 * branch route, loop progress, and any connection error (FR-009–FR-012,
 * FR-015) — instead of the old scrolling per-event log; falls back to
 * that plain log when the structure never loaded, so streaming still
 * degrades gracefully rather than showing nothing. Verbose node output
 * text prints permanently ABOVE the diagram's redraw region so it isn't
 * erased by the next redraw.
 */
const TOKEN_REDRAW_MS = 125;

/** One "▸ node: …newest text" line per node that is generating right now,
 * shown under the live diagram. */
function liveTextLines(state: GraphViewState, texts: Record<string, string>): string[] {
  const width = Math.max(40, (stdout.columns || 80) - 2);
  const lines: string[] = [];
  for (const [nodeId, status] of Object.entries(state.nodeStatus)) {
    const text = texts[nodeId];
    if (status !== "running" || !text) continue;
    const flat = text.replace(/\s+/g, " ").trim();
    const room = Math.max(10, width - nodeId.length - 4);
    const tail = flat.length > room ? "…" + flat.slice(-(room - 1)) : flat;
    lines.push(chalk.cyan("▸ ") + chalk.bold(nodeId) + chalk.gray(": ") + tail);
  }
  return lines;
}

async function handlePromptStreaming(
  client: PipelineClient,
  prompt: string,
  pipelineName: string,
  graph: GraphModel | undefined,
  verbose: boolean,
  history: ConversationTurn[],
  options: AskOptions & RequestOptions = {}
): Promise<RunResult> {
  const startedAt = Date.now();
  console.log();

  let finalAnswer: string | undefined;
  let remembered: Record<string, string> = {};
  let completedNodes: NodeOutput[] = [];
  const outputs: Record<string, string> = {};
  // No inferred "running" at the start: the server sends a node_start event
  // for each node the moment it actually begins.
  let state: GraphViewState | undefined = graph ? createGraphViewState(graph) : undefined;
  // Text each running node's model has written so far (node_token events).
  let texts: Record<string, string> = {};
  let lastTokenRedraw = 0;
  const frame = (current: GraphViewState): string[] => [
    ...renderGraphText(graph!, current),
    ...liveTextLines(current, texts),
  ];
  const redraw = new DiagramRedraw();
  redraw.start();
  if (graph && state) {
    await redraw.print(frame(state));
  }

  try {
    for await (const event of client.askStream(prompt, pipelineName, history, options)) {
      texts = appendNodeText(texts, event);
      if (event.type === "node_token") {
        // Tokens arrive far faster than a terminal should repaint.
        if (graph && state && Date.now() - lastTokenRedraw >= TOKEN_REDRAW_MS) {
          lastTokenRedraw = Date.now();
          await redraw.print(frame(state));
        }
        continue;
      }

      if (graph && state) {
        state = applyStreamEvent(state, event);
      }

      if (event.type === "node_complete") {
        outputs[event.data.node.node_id] = event.data.node.output;
        if (verbose) {
          const { node } = event.data;
          const text = chalk.green("✓ ") + chalk.bold(node.node_id) + " " + nodeStats(node) + `\n  ${node.output}\n`;
          if (graph && state) await redraw.printAbove(text);
          else console.log(text);
        }
      } else if (event.type === "done") {
        finalAnswer = event.data.final_answer;
        remembered = event.data.remembered ?? {};
        completedNodes = Object.values(event.data.node_outputs);
      }

      if (graph && state) {
        await redraw.print(frame(state));
      } else if (event.type === "node_start") {
        // No structure loaded — fall back to a plain progress log.
        console.log(chalk.yellow("◐ ") + chalk.bold(event.data.node_id) + chalk.gray(" running…"));
      } else if (event.type === "node_complete") {
        console.log(chalk.green("✓ ") + chalk.bold(event.data.node.node_id));
      } else if (event.type === "loop_iteration") {
        console.log(
          chalk.gray(`↻ ${event.data.loop_id} — starting iteration ${event.data.iteration}`)
        );
      }
    }
  } catch (err) {
    const stopped = err instanceof RequestCancelledError;
    if (graph && state) {
      state = stopped ? applyStreamStopped(state) : applyStreamError(state, toApiError(err));
      await redraw.print(frame(state));
    }
    redraw.stop();
    if (stopped) {
      // The nodes that finished count as the last run: /rerun <node> picks up from there.
      console.log(
        chalk.yellow("\n■ stopped") +
          chalk.gray(" — nothing was added to the conversation; /rerun <node> continues from a node") +
          "\n"
      );
    } else {
      printError(err);
    }
    return { outputs };
  }

  redraw.stop();

  const elapsedMs = Date.now() - startedAt;
  console.log();
  console.log(chalk.bold.cyan("Final answer"));
  console.log(finalAnswer ?? chalk.yellow("(stream ended without a final answer)"));
  console.log(chalk.gray(`(${(elapsedMs / 1000).toFixed(1)}s total)`));
  for (const warning of contextWarnings(completedNodes)) console.log(warning);
  console.log();

  return finalAnswer === undefined
    ? { outputs }
    : { turn: { prompt, final_answer: finalAnswer, outputs: remembered }, outputs };
}

function printError(err: unknown): void {
  if (err instanceof PipelineApiError) {
    console.log(chalk.red(`error: ${err.message}`));
    if (err.exceptionUID) {
      console.log(chalk.gray(`  (reference id: ${err.exceptionUID} — include this if reporting the issue)`));
    }
  } else if (err instanceof Error) {
    console.log(chalk.red(`unexpected error: ${err.message}`));
  } else {
    console.log(chalk.red(`unexpected error: ${String(err)}`));
  }
  console.log();
}

// Intentionally NOT async/await: this is a pure animation frame ticker with
// no I/O or awaitable work inside it — setInterval is the correct tool here,
// not a stand-in for something that should be a promise.
function startSpinner(label: string): NodeJS.Timeout {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  return setInterval(() => {
    stdout.write(`\r${chalk.gray(frames[i % frames.length])} ${chalk.gray(label)}...`);
    i++;
  }, 80);
}

function stopSpinner(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  stdout.write("\r\x1b[K"); // clear the spinner line
}

// Top-level await (supported here since package.json has "type": "module"
// and we're targeting Node 22+) — this is the async/await-native equivalent
// of the old `main().catch(...)` promise-chain pattern.
try {
  await main();
} catch (err) {
  console.error(chalk.red("fatal error:"), err);
  process.exit(1);
}
