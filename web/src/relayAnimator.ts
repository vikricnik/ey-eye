/**
 * Renders and animates the pipeline-stage indicator track.
 *
 * Unlike the old fixed route/generate/validate/judge design, a DAG pipeline's
 * node list varies per pipeline (3 parallel roots for consensus-qa, 4 nodes
 * in a diamond shape for code-review-pipeline, etc.) — so stages are built
 * dynamically from whatever node list the active pipeline actually has,
 * fetched via GET /pipelines/{name} before a request starts.
 */
export class RelayAnimator {
  private container: HTMLElement;
  private stageIds: string[] = [];
  private timer: number | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Rebuilds the visual track for a new pipeline's node list. Call this
   * whenever the active pipeline changes, before the first request runs. */
  setStages(stageIds: string[]): void {
    this.stageIds = stageIds;
    this.container.innerHTML = "";

    stageIds.forEach((id, index) => {
      const stage = document.createElement("div");
      stage.className = "relay-stage";
      stage.dataset.stage = id;
      stage.innerHTML = `<span class="dot"></span><span>${this.escapeHtml(id)}</span>`;
      this.container.appendChild(stage);

      if (index < stageIds.length - 1) {
        const line = document.createElement("div");
        line.className = "relay-line";
        this.container.appendChild(line);
      }
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  private stageEl(stageId: string): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(`[data-stage="${CSS.escape(stageId)}"]`);
  }

  private reset(): void {
    this.container.querySelectorAll(".relay-stage").forEach((el) => {
      el.classList.remove("active", "complete");
    });
  }

  /**
   * Starts a best-effort visual pace through the current stage list.
   * This is client-side pacing only — the API returns a single JSON
   * response rather than streamed per-node progress events, and with an
   * arbitrary DAG shape (unlike the old fixed 4 tiers) there's no way to
   * know real parallel-vs-sequential timing from the client side alone.
   *
   * Once the last stage is reached, it stays "active" (and thus pulsing via
   * the CSS `infinite` keyframe) indefinitely, for however long the actual
   * request takes — never demoted back to "complete" while still waiting,
   * which was a real bug in an earlier version of this animator.
   */
  start(): void {
    this.reset();
    if (this.stageIds.length === 0) {
      return;
    }

    let i = 0;
    const total = this.stageIds.length;

    const advance = (): void => {
      if (i > 0 && i < total) {
        const prev = this.stageEl(this.stageIds[i - 1]!);
        prev?.classList.remove("active");
        prev?.classList.add("complete");
      }

      if (i < total) {
        const current = this.stageEl(this.stageIds[i]!);
        current?.classList.add("active");
        i++;
      }
      // Once i === total, this is a no-op forever — the last stage keeps
      // pulsing until finish() is called.
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
