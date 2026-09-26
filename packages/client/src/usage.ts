import type { NodeUsage } from "./types.js";

/** How full a node's prompt left the model's context window. "full": the
 * prompt reached the window, so Ollama — which silently drops the start of
 * a longer prompt — probably cut some of it off. */
export type ContextLevel = "ok" | "near" | "full";

const NEAR = 0.8;
const FULL = 0.95;
/** More characters per token than English text ever averages: a prompt
 * with more than this many characters per token of context can't have
 * fit, whatever the token count says afterwards. */
const GENEROUS_CHARS_PER_TOKEN = 5;

export interface UsageView {
  /** "3,900 in · 120 out", or null when no counts were reported. */
  tokens: string | null;
  tokensPerSecond: number | null;
  /** Prompt tokens / context window, when both are known. */
  contextRatio: number | null;
  level: ContextLevel | null;
  /** Compact, for node cards: "3.9k/4.1k ctx". */
  contextShort: string | null;
  /** One line with everything: tokens, speed, context. */
  summary: string;
  /** Why the context level matters, for near/full; null otherwise. */
  warning: string | null;
}

const exact = (n: number) => n.toLocaleString("en-US");

/** 950 → "950", 3900 → "3.9k", 12000 → "12k", 131072 → "131k". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? Number(k.toFixed(1)) : Math.round(k)}k`;
}

/** A node's usage, formatted the same way by every client. */
export function describeUsage(usage: NodeUsage | null | undefined): UsageView | null {
  if (!usage) return null;
  const { prompt_tokens: prompt, completion_tokens: completion, generation_ms: ms, context_window: window } = usage;
  const chars = usage.prompt_chars ?? null;
  const counts = [
    prompt !== null ? `${exact(prompt)} in` : null,
    completion !== null ? `${exact(completion)} out` : null,
  ].filter((part): part is string => part !== null);
  const tokens = counts.length > 0 ? counts.join(" · ") : null;
  const tokensPerSecond = completion !== null && ms !== null && ms > 0 ? completion / (ms / 1000) : null;
  const contextRatio = prompt !== null && window !== null && window > 0 ? prompt / window : null;
  // Ollama counts tokens after cutting a prompt that didn't fit — often to
  // about half the window — so the length sent is checked too.
  const leastTokens = chars !== null ? chars / GENEROUS_CHARS_PER_TOKEN : 0;
  const tooLong = window !== null && window > 0 && leastTokens > window;
  const level: ContextLevel | null =
    contextRatio === null
      ? null
      : tooLong || contextRatio >= FULL
        ? "full"
        : contextRatio >= NEAR || (window !== null && leastTokens > NEAR * window)
          ? "near"
          : "ok";

  const contextText =
    window === null
      ? null
      : contextRatio === null
        ? `context ${exact(window)}`
        : tooLong
          ? `context ${exact(window)} (prompt cut off)`
          : `context ${exact(window)} (${Math.round(contextRatio * 100)}% used)`;
  const summary = [
    tokens,
    tokensPerSecond !== null ? `${tokensPerSecond.toFixed(tokensPerSecond < 10 ? 1 : 0)} tok/s` : null,
    contextText,
  ]
    .filter(Boolean)
    .join(" · ");

  const used = prompt !== null && window !== null ? `${exact(prompt)} of ${exact(window)} tokens` : "";
  const warning = tooLong
    ? `The prompt (${exact(chars!)} characters) doesn't fit the model's context window of ${exact(window!)} ` +
      `tokens: Ollama cut it to ${exact(prompt!)} tokens, dropping the start. Raise num_ctx, or shorten the ` +
      "prompt or history."
    : level === "full"
      ? `The prompt filled the model's context window (${used}). Ollama drops the start of a longer ` +
        "prompt, so part of it was probably cut off — raise num_ctx, or shorten the prompt or history."
      : level === "near"
        ? `The prompt used ${Math.round(contextRatio! * 100)}% of the model's context window (${used}).`
        : null;

  return {
    tokens,
    tokensPerSecond,
    contextRatio,
    level,
    contextShort:
      prompt !== null && window !== null ? `${compactCount(prompt)}/${compactCount(window)} ctx` : null,
    summary,
    warning,
  };
}
