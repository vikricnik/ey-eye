import { PipelineApiError } from "@llm-pipeline/client";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** What to show for a failed request: the server's own message when there is one. */
export function errorText(err: unknown): string {
  if (err instanceof PipelineApiError) return err.serverMessage ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** "just now", "5 min ago", "3 h ago", "yesterday", else the date. */
export function formatWhen(timestamp: number, now: number = Date.now()): string {
  const minutes = Math.round((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return new Date(timestamp).toLocaleDateString();
}

/** A comma-separated list as typed into a field — undefined when empty,
 * so the setting can be removed rather than saved as []. */
export function parseList(text: string): string[] | undefined {
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
