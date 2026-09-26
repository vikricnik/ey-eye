import type { Interface } from "node:readline";

/** Where the CLI reads its lines from. */
export interface LineSource {
  /** The next line, after showing `prompt`; null once the input has ended
   * (Ctrl+D, or the end of piped input). */
  ask(prompt: string): Promise<string | null>;
  /** Hands the terminal to another program (an $EDITOR) and back. */
  pause(): void;
  resume(): void;
}

/**
 * Lines from readline, the same whether typed or piped. readline's
 * question() only sees a line that arrives while it's waiting, so lines
 * piped in (or typed ahead) while a command was still running were lost,
 * and asking again after the input ended threw ERR_USE_AFTER_CLOSE. Here
 * every line is queued until asked for, and the end of input is an answer
 * (null) rather than an error.
 */
export class LineInput implements LineSource {
  private readonly queued: string[] = [];
  private waiting: ((line: string | null) => void) | undefined;
  private ended = false;

  constructor(
    private readonly rl: Interface,
    private readonly output: NodeJS.WritableStream
  ) {
    rl.on("line", (line) => {
      const waiting = this.waiting;
      if (waiting) {
        this.waiting = undefined;
        waiting(line);
      } else {
        this.queued.push(line);
      }
    });
    rl.on("close", () => {
      this.ended = true;
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.(null);
    });
  }

  ask(prompt: string): Promise<string | null> {
    const next = this.queued.shift();
    if (next !== undefined) {
      // Show it after its prompt, as if it had been typed just now.
      this.output.write(`${prompt}${next}\n`);
      return Promise.resolve(next);
    }
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }

  pause(): void {
    this.rl.pause();
  }

  resume(): void {
    this.rl.resume();
  }
}
