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
    <div class="candidate ${isOutputNode ? "winner" : ""}">
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
