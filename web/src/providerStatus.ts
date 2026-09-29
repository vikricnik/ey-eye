import { effectiveModel } from "@llm-pipeline/client";
import type { ModelsResponse, PipelineDefinition, ProviderModels } from "@llm-pipeline/client";

// What an unreachable model provider means for the open pipeline. The
// server checks Ollama on every GET /v1/models (a failure is never
// cached); cloud providers are listed from an allowlist and always report
// reachable.

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  copilot: "Copilot",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** The providers a run of this pipeline calls: each node's model (its own
 * or the pipeline default) and the history summarizer's. */
export function providersUsed(definition: PipelineDefinition): Set<string> {
  const used = new Set<string>();
  for (const node of definition.nodes) {
    const model = effectiveModel(definition, node);
    if (model) used.add(model.provider);
  }
  const summarizer = definition.history?.summarize?.model;
  if (summarizer) used.add(summarizer.provider);
  return used;
}

export interface RunOutage {
  /** Providers the pipeline calls that the server reports unreachable. */
  unreachable: ProviderModels[];
  /** Every model the pipeline calls is on one of them, so a run can only
   * fail. With other providers still up, a run may get through (a branch
   * may never reach the nodes that would fail), so it isn't blocked. */
  blocksRun: boolean;
}

/** Null until the models are known, and while every provider the
 * pipeline uses is reachable. */
export function runOutage(definition: PipelineDefinition, models: ModelsResponse | null): RunOutage | null {
  if (!models) return null;
  const used = providersUsed(definition);
  const unreachable = models.providers.filter((p) => !p.reachable && used.has(p.provider));
  if (unreachable.length === 0) return null;
  const blocksRun = [...used].every((provider) => unreachable.some((p) => p.provider === provider));
  return { unreachable, blocksRun };
}

/** The notice shown above the workspace. */
export function outageMessage(outage: RunOutage): string {
  const causes = outage.unreachable
    .map((p) => p.error ?? `${providerLabel(p.provider)} isn't reachable`)
    .join("; ");
  const several = outage.unreachable.length > 1;
  return outage.blocksRun
    ? `${causes} — this pipeline can't run until ${several ? "they're" : "it's"} back.`
    : `${causes} — the nodes that use ${several ? "them" : "it"} will fail.`;
}

/** Why Run is disabled, when the outage leaves nothing to run with. */
export function runBlockedReason(outage: RunOutage | null): string | null {
  if (!outage?.blocksRun) return null;
  const names = outage.unreachable.map((p) => providerLabel(p.provider));
  return names.length > 1
    ? `${names.join(" and ")} are unreachable — start them to run`
    : `${names[0]} is unreachable — start it to run`;
}
