import type { AskResponse, Candidate, ValidatorVote } from "./types";

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderVoteRow(vote: ValidatorVote): string {
  const icon = vote.is_valid ? "✓" : "✗";
  const feedback = vote.feedback
    ? `<span>— ${escapeHtml(vote.feedback.slice(0, 90))}</span>`
    : "";
  return `
    <div class="vote-row">
      <span>${icon}</span>
      <span class="vname">${escapeHtml(vote.validator_name)}</span>
      ${feedback}
    </div>
  `;
}

function renderCandidate(candidate: Candidate, winningModel: string): string {
  const isWinner = candidate.model_name === winningModel;
  const votesHtml = candidate.votes.map(renderVoteRow).join("");

  return `
    <div class="candidate ${isWinner ? "winner" : ""}">
      <div class="candidate-header">
        <span class="model-name">${escapeHtml(candidate.model_name)}</span>
        <span class="badge ${candidate.is_valid ? "valid" : "invalid"}">
          ${candidate.is_valid ? "valid" : "invalid"}
        </span>
        ${isWinner ? '<span class="badge winner-badge">chosen</span>' : ""}
      </div>
      <div class="candidate-answer">${escapeHtml(candidate.answer)}</div>
      ${votesHtml ? `<div class="votes">${votesHtml}</div>` : ""}
    </div>
  `;
}

export function renderTurn(
  transcript: HTMLElement,
  prompt: string,
  response: AskResponse,
  verbose: boolean
): void {
  const turn = document.createElement("div");
  turn.className = "turn";

  const showCandidates = verbose && response.candidates.length > 1;
  const candidatesHtml = showCandidates
    ? `
      <div class="candidates">
        <div class="candidates-label">All candidates (${response.candidates.length})</div>
        ${response.candidates.map((c) => renderCandidate(c, response.winning_model)).join("")}
      </div>
    `
    : "";

  turn.innerHTML = `
    <div class="turn-prompt"><span class="marker">›</span><span>${escapeHtml(prompt)}</span></div>
    <div class="turn-response">
      <div class="turn-meta">
        <span class="tag">category: <b>${escapeHtml(response.category)}</b></span>
        <span class="tag">winner: <b>${escapeHtml(response.winning_model)}</b></span>
        <span class="tag">router: <b>${escapeHtml(response.router_model)}</b></span>
        <span class="tag">judge: <b>${escapeHtml(response.judge_model)}</b></span>
      </div>
      <div class="final-answer">${escapeHtml(response.final_answer)}</div>
      ${candidatesHtml}
    </div>
  `;

  transcript.appendChild(turn);
  transcript.scrollTop = transcript.scrollHeight;
}

export function renderError(transcript: HTMLElement, prompt: string, message: string): void {
  const turn = document.createElement("div");
  turn.className = "turn";
  turn.innerHTML = `
    <div class="turn-prompt"><span class="marker">›</span><span>${escapeHtml(prompt)}</span></div>
    <div class="error-banner">error: ${escapeHtml(message)}</div>
  `;
  transcript.appendChild(turn);
  transcript.scrollTop = transcript.scrollHeight;
}
