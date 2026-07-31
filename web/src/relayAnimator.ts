const STAGES = ["route", "generate", "validate", "judge"] as const;
type Stage = (typeof STAGES)[number];

export class RelayAnimator {
  private timer: number | null = null;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  private stageEl(stage: Stage): HTMLElement {
    const el = this.container.querySelector<HTMLElement>(`[data-stage="${stage}"]`);
    if (!el) {
      throw new Error(`Relay stage element not found: ${stage}`);
    }
    return el;
  }

  private reset(): void {
    this.container.querySelectorAll(".relay-stage").forEach((el) => {
      el.classList.remove("active", "complete");
    });
  }

  /**
   * Starts a best-effort visual pace through the pipeline stages.
   * This is client-side pacing only — the API returns a single JSON
   * response rather than streamed per-stage progress events.
   *
   * Bug fix: the previous version demoted the *last* stage from "active"
   * back to "complete" on the tick right after reaching it, which stripped
   * its pulsing CSS class and froze the whole animation after ~4 ticks
   * (5.6s) — well before most real LLM requests finish. Now, once the last
   * stage is reached, it's left "active" (and thus pulsing) indefinitely,
   * for however long the actual request takes.
   */
  start(): void {
    this.reset();
    let i = 0;

    const advance = (): void => {
      // Only demote a *previous* stage while we're still advancing through
      // them — never touch the last stage once we've arrived at it.
      if (i > 0 && i < STAGES.length) {
        const prev = this.stageEl(STAGES[i - 1]!);
        prev.classList.remove("active");
        prev.classList.add("complete");
      }

      if (i < STAGES.length) {
        const current = this.stageEl(STAGES[i]!);
        current.classList.add("active");
        i++;
      }
      // Once i === STAGES.length, this function is a no-op on every
      // subsequent tick — the last stage keeps its "active" class (and
      // keeps pulsing via the CSS `infinite` keyframe) until finish() runs.
    };

    advance();
    this.timer = window.setInterval(advance, 1400);
  }

  /** Snaps all stages to "complete" the moment the real response arrives. */
  finish(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.container.querySelectorAll(".relay-stage").forEach((el) => {
      el.classList.remove("active");
      el.classList.add("complete");
    });
    window.setTimeout(() => this.reset(), 900);
  }
}
