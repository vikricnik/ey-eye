import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import {
  PipelineClient,
  PipelineApiError,
  buildGraphModel,
  createGraphViewState,
  applyStreamEvent,
  applyStreamError,
} from "@llm-pipeline/client";
import {
  formatAskResponse,
  formatHealth,
  formatPipelineList,
  formatPipelineDetail,
} from "./formatter.js";
import { renderGraphText } from "./graphRenderer.js";
import type { ConversationTurn, GraphModel, GraphViewState } from "@llm-pipeline/client";

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
  ${chalk.yellow("/exit")}              quit (also: Ctrl+C or Ctrl+D)

Currently using pipeline: ${chalk.blue(activePipeline)}

Anything else you type is sent to the active pipeline as a prompt, with prior
turns in this session included as conversation context.
`;
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

  rl.on("SIGINT", () => {
    console.log(chalk.gray("\ngoodbye"));
    rl.close();
    process.exit(0);
  });

  while (true) {
    const input = await rl.question(chalk.bold.green(`(${activePipeline}) › `));
    const trimmed = input.trim();

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
      try {
        // Confirm the pipeline actually exists before switching — fails
        // clearly now rather than on the next prompt.
        const detail = await client.getPipelineDetail(requestedName);
        activePipeline = requestedName;
        activeGraph = buildGraphModel(detail);
        history.length = 0; // different pipeline = different context; don't carry old turns forward
        console.log(chalk.gray(`switched to pipeline "${activePipeline}" — conversation history cleared\n`));
      } catch (err) {
        activeGraph = undefined;
        printError(err);
      }
      continue;
    }

    if (streaming) {
      await handlePromptStreaming(client, trimmed, activePipeline, activeGraph, verbose, history);
    } else {
      await handlePrompt(client, trimmed, activePipeline, verbose, history);
    }
  }

  rl.close();
  console.log(chalk.gray("goodbye"));
}

async function handlePrompt(
  client: PipelineClient,
  prompt: string,
  pipelineName: string,
  verbose: boolean,
  history: ConversationTurn[]
): Promise<void> {
  const spinner = startSpinner("thinking");
  const startedAt = Date.now();

  try {
    const response = await client.ask(prompt, pipelineName, history);
    const elapsedMs = Date.now() - startedAt;
    stopSpinner(spinner);
    console.log();
    console.log(formatAskResponse(response, verbose, elapsedMs));
    console.log();
    // Only the final answer (the output_node's result) is kept as context
    // for the next turn — intermediate node outputs aren't carried forward.
    history.push({ prompt, final_answer: response.final_answer });
  } catch (err) {
    stopSpinner(spinner);
    printError(err);
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

  async print(lines: string[]): Promise<void> {
    if (this.resized) {
      console.clear();
      this.printedLines = 0;
      this.resized = false;
    } else if (this.printedLines > 0) {
      const out = new readline.Readline(stdout);
      await out.moveCursor(0, -this.printedLines).clearScreenDown().commit();
      this.printedLines = 0;
    }
    for (const line of lines) {
      console.log(line);
    }
    this.printedLines = lines.length;
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
async function handlePromptStreaming(
  client: PipelineClient,
  prompt: string,
  pipelineName: string,
  graph: GraphModel | undefined,
  verbose: boolean,
  history: ConversationTurn[]
): Promise<void> {
  const startedAt = Date.now();
  console.log();

  let finalAnswer: string | undefined;
  let state: GraphViewState | undefined = graph ? createGraphViewState(graph, { running: true }) : undefined;
  const redraw = new DiagramRedraw();
  redraw.start();
  if (graph && state) {
    await redraw.print(renderGraphText(graph, state));
  }

  try {
    for await (const event of client.askStream(prompt, pipelineName, history)) {
      if (graph && state) {
        state = applyStreamEvent(state, event);
      }

      if (event.type === "node_complete") {
        if (verbose) {
          const { node } = event.data;
          const seconds = (node.duration_ms / 1000).toFixed(1);
          console.log(
            chalk.green("✓ ") +
              chalk.bold(node.node_id) +
              chalk.gray(` (${node.model_name}, ${seconds}s)`)
          );
          console.log(`  ${node.output}\n`);
        }
      } else if (event.type === "done") {
        finalAnswer = event.data.final_answer;
      }

      if (graph && state) {
        await redraw.print(renderGraphText(graph, state));
      } else if (event.type === "node_complete") {
        // No structure loaded — fall back to the plain completion log.
        console.log(chalk.green("✓ ") + chalk.bold(event.data.node.node_id));
      } else if (event.type === "loop_iteration") {
        console.log(
          chalk.gray(`↻ ${event.data.loop_id} — starting iteration ${event.data.iteration}`)
        );
      }
    }
  } catch (err) {
    if (graph && state) {
      state = applyStreamError(state, toApiError(err));
      await redraw.print(renderGraphText(graph, state));
    }
    redraw.stop();
    printError(err);
    return;
  }

  redraw.stop();

  const elapsedMs = Date.now() - startedAt;
  console.log();
  console.log(chalk.bold.cyan("Final answer"));
  console.log(finalAnswer ?? chalk.yellow("(stream ended without a final answer)"));
  console.log(chalk.gray(`(${(elapsedMs / 1000).toFixed(1)}s total)`));
  console.log();

  if (finalAnswer !== undefined) {
    history.push({ prompt, final_answer: finalAnswer });
  }
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
