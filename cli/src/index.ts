import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { PipelineClient, PipelineApiError } from "./apiClient.js";
import { formatAskResponse, formatHealth } from "./formatter.js";
import type { ConversationTurn } from "./types.js";

const BASE_URL = process.env.PIPELINE_BASE_URL ?? "http://localhost:8000";

const HELP_TEXT = `
${chalk.bold("Commands:")}
  ${chalk.yellow("/help")}     show this help
  ${chalk.yellow("/health")}   show current pipeline configuration
  ${chalk.yellow("/verbose")}  toggle showing all candidates vs. just the final answer
  ${chalk.yellow("/reset")}    clear conversation history (start fresh)
  ${chalk.yellow("/exit")}     quit (also: Ctrl+C or Ctrl+D)

Anything else you type is sent to the pipeline as a prompt, with prior turns
in this session included as conversation context.
`;

async function main(): Promise<void> {
  const client = new PipelineClient(BASE_URL);
  let verbose = false;
  const history: ConversationTurn[] = [];

  console.log(chalk.bold.cyan("\nLLM Pipeline CLI"));
  console.log(chalk.gray(`connected to ${BASE_URL}`));
  console.log(chalk.gray('type "/help" for commands, "/exit" to quit\n'));

  try {
    const health = await client.checkHealth();
    console.log(formatHealth(health));
    console.log();
  } catch (err) {
    printError(err);
    console.log(
      chalk.yellow("Continuing anyway — you can still try prompts once the server is up.\n")
    );
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on("SIGINT", () => {
    console.log(chalk.gray("\ngoodbye"));
    rl.close();
    process.exit(0);
  });

  while (true) {
    const input = await rl.question(chalk.bold.green("› "));
    const trimmed = input.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed === "/exit") {
      break;
    }

    if (trimmed === "/help") {
      console.log(HELP_TEXT);
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

    await handlePrompt(client, trimmed, verbose, history);
  }

  rl.close();
  console.log(chalk.gray("goodbye"));
}

async function handlePrompt(
  client: PipelineClient,
  prompt: string,
  verbose: boolean,
  history: ConversationTurn[]
): Promise<void> {
  const spinner = startSpinner("thinking");

  try {
    const response = await client.ask(prompt, history);
    stopSpinner(spinner);
    console.log();
    console.log(formatAskResponse(response, verbose));
    console.log();
    // Only the winning answer is kept as context for the next turn — the
    // candidates that lost the judge vote are dropped from memory.
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
