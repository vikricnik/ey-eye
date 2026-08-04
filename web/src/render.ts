import type { AskResponse, NodeOutput } from "@llm-pipeline/client";

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderNode(nodeId: string, node: NodeOutput, isOutputNode: boolean): string {
  return `
    <div class="candidate ${isOutputNode ? "winner" : ""}" data-node-id="${escapeHtml(nodeId)}">
      <div class="candidate-header">
        <span class="model-name">${escapeHtml(nodeId)}</span>
        <span class="badge valid">${escapeHtml(node.model_name)}</span>
        <span class="badge valid">${formatDuration(node.duration_ms)}</span>
        ${isOutputNode ? '<span class="badge winner-badge">output node</span>' : ""}
      </div>
      <div class="candidate-answer">${escapeHtml(node.output)}</div>
    </div>
  `;
}

export function renderTurn(
  transcript: HTMLElement,
  prompt: string,
  response: AskResponse,
  verbose: boolean,
  elapsedMs: number
): void {
  const turn = document.createElement("div");
  turn.className = "turn";

  const nodeIds = Object.keys(response.node_outputs);
  const nodesHtml =
    verbose && nodeIds.length > 0
      ? `
        <div class="candidates">
          <div class="candidates-label">Node outputs (${nodeIds.length})</div>
          ${nodeIds
            .map((id) =>
              renderNode(id, response.node_outputs[id]!, id === response.output_node)
            )
            .join("")}
        </div>
      `
      : "";

  const loopIds = Object.keys(response.loop_iterations);
  const loopTags = loopIds
    .map(
      (id) =>
        `<span class="tag">${escapeHtml(id)}: <b>${response.loop_iterations[id]}× looped</b></span>`
    )
    .join("");

  turn.innerHTML = `
    <div class="turn-prompt"><span class="marker">›</span><span>${escapeHtml(prompt)}</span></div>
    <div class="turn-response">
      <div class="turn-meta">
        <span class="tag">pipeline: <b>${escapeHtml(response.pipeline_name)}</b></span>
        <span class="tag">output node: <b>${escapeHtml(response.output_node)}</b></span>
        <span class="tag">took: <b>${escapeHtml(formatDuration(elapsedMs))}</b></span>
        ${loopTags}
      </div>
      <div class="final-answer">${escapeHtml(response.final_answer)}</div>
      ${nodesHtml}
    </div>
  `;

  transcript.appendChild(turn);
  transcript.scrollTop = transcript.scrollHeight;
}

export interface StreamingTurnHandle {
  /** Appends one node's output card immediately — called per node_complete event. */
  addNodeOutput(nodeId: string, node: NodeOutput): void;
  /** Fills in the summary (pipeline/output node/timing/final answer) and marks
   * the winning candidate card — called once, when the `done` event arrives. */
  finish(response: AskResponse, elapsedMs: number): void;
}

/**
 * Streaming counterpart to renderTurn(): creates the turn's DOM immediately
 * (prompt + an empty "running…" placeholder) and returns handles to update
 * it incrementally as SSE events arrive, rather than building the whole
 * thing in one shot from a complete AskResponse. Node output cards appear
 * the moment each node_complete event arrives (when verbose is on) — the
 * summary/final-answer section is filled in once, at finish().
 */
export function beginStreamingTurn(
  transcript: HTMLElement,
  prompt: string,
  verbose: boolean
): StreamingTurnHandle {
  const turn = document.createElement("div");
  turn.className = "turn";
  turn.innerHTML = `
    <div class="turn-prompt"><span class="marker">›</span><span>${escapeHtml(prompt)}</span></div>
    <div class="turn-response">
      <div class="turn-meta turn-meta-pending"><span class="tag">running…</span></div>
      <div class="final-answer final-answer-pending"></div>
      ${
        verbose
          ? '<div class="candidates"><div class="candidates-label">Node outputs</div></div>'
          : ""
      }
    </div>
  `;
  transcript.appendChild(turn);
  transcript.scrollTop = transcript.scrollHeight;

  const candidatesEl = turn.querySelector<HTMLElement>(".candidates");
  const metaEl = turn.querySelector<HTMLElement>(".turn-meta")!;
  const answerEl = turn.querySelector<HTMLElement>(".final-answer")!;

  return {
    addNodeOutput(nodeId: string, node: NodeOutput): void {
      if (!candidatesEl) return; // verbose is off — nothing to append
      const wrapper = document.createElement("div");
      // isOutputNode is unknown until finish() — every card starts
      // un-highlighted and the winning one gets upgraded retroactively.
      wrapper.innerHTML = renderNode(nodeId, node, false);
      candidatesEl.appendChild(wrapper.firstElementChild!);
      transcript.scrollTop = transcript.scrollHeight;
    },

    finish(response: AskResponse, elapsedMs: number): void {
      const loopIds = Object.keys(response.loop_iterations);
      const loopTags = loopIds
        .map(
          (id) =>
            `<span class="tag">${escapeHtml(id)}: <b>${response.loop_iterations[id]}× looped</b></span>`
        )
        .join("");

      metaEl.className = "turn-meta";
      metaEl.innerHTML = `
        <span class="tag">pipeline: <b>${escapeHtml(response.pipeline_name)}</b></span>
        <span class="tag">output node: <b>${escapeHtml(response.output_node)}</b></span>
        <span class="tag">took: <b>${escapeHtml(formatDuration(elapsedMs))}</b></span>
        ${loopTags}
      `;

      answerEl.className = "final-answer";
      answerEl.textContent = response.final_answer;

      if (candidatesEl) {
        const winner = candidatesEl.querySelector<HTMLElement>(
          `[data-node-id="${CSS.escape(response.output_node)}"]`
        );
        if (winner) {
          winner.classList.add("winner");
          const header = winner.querySelector(".candidate-header");
          if (header && !header.querySelector(".winner-badge")) {
            const badge = document.createElement("span");
            badge.className = "badge winner-badge";
            badge.textContent = "output node";
            header.appendChild(badge);
          }
        }
      }

      transcript.scrollTop = transcript.scrollHeight;
    },
  };
}

export function renderError(
  transcript: HTMLElement,
  prompt: string,
  message: string,
  exceptionUID?: string
): void {
  const turn = document.createElement("div");
  turn.className = "turn";
  const refLine = exceptionUID
    ? `<div class="error-ref">reference id: ${escapeHtml(exceptionUID)}</div>`
    : "";
  turn.innerHTML = `
    <div class="turn-prompt"><span class="marker">›</span><span>${escapeHtml(prompt)}</span></div>
    <div class="error-banner">error: ${escapeHtml(message)}${refLine}</div>
  `;
  transcript.appendChild(turn);
  transcript.scrollTop = transcript.scrollHeight;
}
