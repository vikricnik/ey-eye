import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { PipelineClient, PipelineApiError } from "./apiClient.js";
import {
  formatAskResponse,
  formatHealth,
  formatPipelineList,
  formatPipelineDetail,
} from "./formatter.js";
import type { ConversationTurn } from "./types.js";

const BASE_URL = process.env.PIPELINE_BASE_URL ?? "http://localhost:8000";
const API_KEY = process.env.PIPELINE_API_KEY; // only needed if the server has API_KEYS configured

function helpText(activePipeline: string): string {
  return `
${chalk.bold("Commands:")}
  ${chalk.yellow("/help")}              show this help
  ${chalk.yellow("/health")}            show server info and available pipelines
  ${chalk.yellow("/pipelines")}         list available pipelines
  ${chalk.yellow("/pipeline")}          show the active pipeline's DAG (nodes + edges)
  ${chalk.yellow("/use <name>")}         switch pipelines (clears conversation history)
  ${chalk.yellow("/verbose")}           toggle showing every node's output vs. just the final answer
  ${chalk.yellow("/reset")}             clear conversation history (start fresh)
  ${chalk.yellow("/exit")}              quit (also: Ctrl+C or Ctrl+D)

Currently using pipeline: ${chalk.blue(activePipeline)}

Anything else you type is sent to the active pipeline as a prompt, with prior
turns in this session included as conversation context.
`;
}

async function main(): Promise<void> {
  const client = new PipelineClient(BASE_URL, API_KEY);
  let verbose = false;
  let activePipeline: string;
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
        await client.getPipelineDetail(requestedName);
        activePipeline = requestedName;
        history.length = 0; // different pipeline = different context; don't carry old turns forward
        console.log(chalk.gray(`switched to pipeline "${activePipeline}" — conversation history cleared\n`));
      } catch (err) {
        printError(err);
      }
      continue;
    }

    await handlePrompt(client, trimmed, activePipeline, verbose, history);
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

function printError(err: unknown): void {
  if (err instanceof PipelineApiError) {
    console.log(chalk.red(`error: ${err.message}`));
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
