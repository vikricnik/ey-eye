import chalk from "chalk";
import type { AskResponse, Candidate, ValidatorVote, HealthResponse } from "./types.js";

const DIVIDER = chalk.gray("─".repeat(60));

export function formatHealth(health: HealthResponse): string {
  const lines: string[] = [
    chalk.bold.cyan("Pipeline configuration"),
    `${chalk.gray("execution mode:")}        ${chalk.yellow(health.execution_mode)}`,
    `${chalk.gray("generation collab:")}     ${chalk.yellow(health.generation_collaboration)}`,
    `${chalk.gray("validation mode:")}       ${chalk.yellow(health.validation_mode)}`,
    `${chalk.gray("validation quorum:")}     ${chalk.yellow(String(health.validation_quorum))}`,
    `${chalk.gray("validation concurrency:")} ${chalk.yellow(health.validation_concurrency)}`,
    `${chalk.gray("max history turns:")}     ${chalk.yellow(String(health.max_history_turns))}`,
    `${chalk.gray("router model:")}          ${chalk.blue(health.router_model)}`,
    `${chalk.gray("judge model:")}           ${chalk.blue(health.judge_model)}`,
    "",
    chalk.bold.cyan("Generators by category"),
    ...Object.entries(health.generators_by_category).map(
      ([cat, models]) => `  ${chalk.yellow(cat)}: ${models.map((m) => chalk.blue(m)).join(", ")}`
    ),
    "",
    chalk.bold.cyan("Validators by category"),
    ...Object.entries(health.validators_by_category).map(
      ([cat, models]) => `  ${chalk.yellow(cat)}: ${models.map((m) => chalk.blue(m)).join(", ")}`
    ),
  ];
  return lines.join("\n");
}

function formatVote(vote: ValidatorVote): string {
  const icon = vote.is_valid ? chalk.green("✓") : chalk.red("✗");
  const feedback = vote.feedback ? chalk.gray(` — ${truncate(vote.feedback, 80)}`) : "";
  return `    ${icon} ${chalk.white(vote.validator_name)}${feedback}`;
}

function formatCandidate(candidate: Candidate, isWinner: boolean): string {
  const lines: string[] = [];

  const statusIcon = candidate.is_valid ? chalk.green("VALID") : chalk.red("INVALID");
  const winnerTag = isWinner ? chalk.bold.magenta("  ← chosen by judge") : "";
  const header = `${chalk.bold.blue(candidate.model_name)}  [${statusIcon}]${winnerTag}`;
  lines.push(header);

  lines.push(chalk.gray("  answer:"));
  lines.push(indent(candidate.answer, 4));

  if (candidate.feedback) {
    lines.push(chalk.gray(`  feedback: ${truncate(candidate.feedback, 100)}`));
  }

  if (candidate.votes.length > 0) {
    lines.push(chalk.gray("  validator votes:"));
    for (const vote of candidate.votes) {
      lines.push(formatVote(vote));
    }
  }

  return lines.join("\n");
}

export function formatAskResponse(response: AskResponse, verbose: boolean): string {
  const sections: string[] = [];

  sections.push(
    `${chalk.gray("category:")} ${chalk.yellow(response.category)}   ` +
      `${chalk.gray("winner:")} ${chalk.bold.blue(response.winning_model)}`
  );
  sections.push(
    `${chalk.gray("router:")} ${chalk.blue(response.router_model)}   ` +
      `${chalk.gray("judge:")} ${chalk.blue(response.judge_model)}`
  );
  sections.push(DIVIDER);

  sections.push(chalk.bold.green("Final answer"));
  sections.push(response.final_answer);

  if (verbose && response.candidates.length > 1) {
    sections.push(DIVIDER);
    sections.push(chalk.bold.cyan(`All candidates (${response.candidates.length})`));
    for (const candidate of response.candidates) {
      const isWinner = candidate.model_name === response.winning_model;
      sections.push("");
      sections.push(formatCandidate(candidate, isWinner));
    }
  }

  return sections.join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}
