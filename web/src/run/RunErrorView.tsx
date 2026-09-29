import type { ReactNode } from "react";
import { explainRunFailure } from "./runFailure";
import type { RunError } from "./runFailure";

/** `text` with its `backticked` parts set as code. */
function withCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/**
 * A failed run. A failure people can act on is explained in plain words
 * with what to do next; either way the server's own message and the
 * reference id follow — the id is what to quote in a bug report.
 */
export function RunErrorView({ error, actions }: { error: RunError; actions?: ReactNode }) {
  const explained = explainRunFailure(error);
  const reference = error.requestId ? `reference id: ${error.requestId}` : null;
  return (
    <div className="error-banner">
      {explained ? (
        <>
          <p className="error-summary">{explained.summary}</p>
          <p className="error-hint">{withCode(explained.hint)}</p>
          <p className="error-ref">
            {error.message}
            {reference ? ` · ${reference}` : ""}
          </p>
        </>
      ) : (
        <>
          <p>error: {error.message}</p>
          {reference && <p className="error-ref">{reference}</p>}
        </>
      )}
      {actions && <div className="turn-actions">{actions}</div>}
    </div>
  );
}
