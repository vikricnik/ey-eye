import { useEffect, useRef, useState } from "react";
import type { ConversationTurn, PipelineDefinition, PreviewPromptResponse } from "@llm-pipeline/client";
import { client } from "../config";
import { errorText } from "../format";

/** The last message, the conversation before it and its node outputs —
 * what a re-run would start from. Null before the first run. */
export interface PreviewContext {
  prompt: string;
  history: ConversationTurn[];
  outputs: Record<string, string>;
}

const DEBOUNCE_MS = 400;

/**
 * What a node would receive, rendered by the server exactly as a run
 * renders it — for the last message (so it matches a re-run), or with
 * placeholders before the first run. Follows the draft as it's edited;
 * fetched only while open.
 */
export function PromptPreview(props: {
  definition: PipelineDefinition;
  nodeId: string;
  context: PreviewContext | null;
}) {
  const { definition, nodeId, context } = props;
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PreviewPromptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const preview = await client.previewPrompt({
          definition,
          node_id: nodeId,
          prompt: context?.prompt ?? "",
          history: context?.history ?? [],
          outputs: context?.outputs ?? {},
        });
        if (mine !== seq.current) return;
        setResult(preview);
        setError(null);
      } catch (err) {
        if (mine === seq.current) setError(errorText(err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, definition, nodeId, context]);

  return (
    <details className="prompt-preview" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Preview{" "}
        <span className="dim">
          {context ? "— the last message, with its outputs" : "— with placeholders until the first run"}
          {loading ? " · rendering…" : ""}
        </span>
      </summary>
      {error && <p className="problem error">{error}</p>}
      {result && (
        <div className="prompt-preview-body">
          {result.missing.length > 0 && (
            <p className="field-hint">
              No output yet from {result.missing.join(", ")} — shown as placeholders.
            </p>
          )}
          {result.system && (
            <section className="message-part">
              <h4>system</h4>
              <pre className="message-text">{result.system}</pre>
            </section>
          )}
          <section className="message-part">
            <h4>prompt · {result.prompt.length.toLocaleString("en-US")} characters</h4>
            <pre className="message-text">{result.prompt}</pre>
          </section>
        </div>
      )}
    </details>
  );
}
