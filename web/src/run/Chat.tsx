import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import type { ConversationTurn, NodeOutput, RunLogEntry, StreamDoneEvent } from "@llm-pipeline/client";
import { formatDuration, formatWhen } from "../format";
import { RunErrorView } from "./RunErrorView";
import type { RunError } from "./runFailure";
import type { ConversationSummary } from "./runHistory";

export interface Turn {
  id: number;
  pipeline: string;
  prompt: string;
  /** The conversation this message was sent with — what a re-run resends. */
  history: ConversationTurn[];
  /** Set on a re-run: the node it started from. */
  rerunFrom?: string;
  status: "running" | "done" | "error" | "stopped";
  nodeOutputs: NodeOutput[];
  /** Every node execution in this run: what it received and replied. */
  log: RunLogEntry[];
  result?: StreamDoneEvent;
  elapsedMs?: number;
  error?: RunError;
}

function NodeCard({ node, isOutput }: { node: NodeOutput; isOutput: boolean }) {
  return (
    <div className={`candidate ${isOutput ? "winner" : ""}`}>
      <div className="candidate-header">
        <span className="model-name">{node.node_id}</span>
        <span className="badge">{node.model_name}</span>
        <span className="badge">{formatDuration(node.duration_ms)}</span>
        {isOutput && <span className="badge winner-badge">output node</span>}
      </div>
      <div className="candidate-answer">{node.output}</div>
    </div>
  );
}

function TurnView(props: { turn: Turn; verbose: boolean; pendingAnswer?: string | undefined; actions?: ReactNode }) {
  const { turn, verbose, pendingAnswer, actions } = props;
  const result = turn.result;
  return (
    <div className="turn">
      <div className="turn-prompt">
        <span className="marker">{turn.rerunFrom ? "↻" : "›"}</span>
        <span>{turn.prompt}</span>
        {turn.rerunFrom && <span className="tag-mini">re-run from {turn.rerunFrom}</span>}
      </div>
      {turn.status === "stopped" ? (
        <div className="stopped-banner">
          stopped — nothing from this run was added to the conversation
          {turn.nodeOutputs.length > 0 ? ` (${turn.nodeOutputs.length} node(s) had finished)` : ""}
          {actions && <div className="turn-actions">{actions}</div>}
        </div>
      ) : turn.status === "error" ? (
        <RunErrorView error={turn.error ?? { message: "the run failed" }} actions={actions} />
      ) : (
        <div className="turn-response">
          <div className="turn-meta">
            {result ? (
              <>
                <span className="tag">output node: <b>{result.output_node}</b></span>
                <span className="tag">took: <b>{formatDuration(turn.elapsedMs ?? 0)}</b></span>
                {Object.entries(result.loop_iterations).map(([id, n]) => (
                  <span className="tag" key={id}>
                    {id}: <b>{n}× looped</b>
                  </span>
                ))}
              </>
            ) : (
              <span className="tag">running… {turn.nodeOutputs.length} node(s) done</span>
            )}
          </div>
          {verbose && turn.nodeOutputs.length > 0 && (
            <div className="candidates">
              <div className="candidates-label">Node outputs ({turn.nodeOutputs.length})</div>
              {turn.nodeOutputs.map((n, i) => (
                <NodeCard key={`${n.node_id}-${i}`} node={n} isOutput={result?.output_node === n.node_id} />
              ))}
            </div>
          )}
          <div className={result || pendingAnswer ? "final-answer" : "final-answer final-answer-pending"}>
            {result?.final_answer ?? pendingAnswer}
            {!result && pendingAnswer && <span className="cursor" aria-hidden="true" />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Chat tab: which conversation this is (saved in this browser — pick
 * an earlier one, start a new one or delete this one) and its transcript.
 * Node status on the canvas updates live from the same runs.
 */
export function Chat(props: {
  turns: Turn[];
  running: boolean;
  /** The output node's text so far, while the latest turn is running. */
  pendingAnswer?: string | undefined;
  verbose: boolean;
  onVerbose: (verbose: boolean) => void;
  /** This pipeline's saved conversations, most recent first. */
  conversations: ConversationSummary[];
  currentConversation: string;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewConversation: () => void;
  /** Sends the latest run again as it was, when it failed or was stopped;
   * unset while it can't be (see App). */
  onRetry?: (() => void) | undefined;
  /** Why Retry is disabled right now (the Run button's reason). */
  retryDisabledReason: string | null;
  /** Puts a message back in the message box, to change it before sending. */
  onEditMessage: (prompt: string) => void;
}) {
  const transcript = useRef<HTMLDivElement>(null);
  const current = props.conversations.find((c) => c.id === props.currentConversation);
  const last = props.turns.at(-1);
  const recoverable = last && (last.status === "error" || last.status === "stopped") && !props.running;
  const actions = recoverable ? (
    <>
      {props.onRetry && (
        <button
          type="button"
          className="link"
          disabled={props.retryDisabledReason !== null}
          title={
            props.retryDisabledReason ??
            (last.rerunFrom ? `Re-run from ${last.rerunFrom} again` : "Send this message again")
          }
          onClick={props.onRetry}
        >
          Retry
        </button>
      )}
      {!last.rerunFrom && (
        <button
          type="button"
          className="link"
          title="Put this message back in the box below, to change it before sending"
          onClick={() => props.onEditMessage(last.prompt)}
        >
          Edit message
        </button>
      )}
    </>
  ) : undefined;

  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.turns, props.pendingAnswer]);

  return (
    <section className="chat" aria-label="Chat">
      <div className="conversation-bar">
        <select
          aria-label="Conversation"
          value={current ? current.id : ""}
          disabled={props.running}
          onChange={(e) => {
            if (e.target.value) props.onOpenConversation(e.target.value);
          }}
        >
          {!current && <option value="">new conversation</option>}
          {props.conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} · {c.turnCount} run{c.turnCount === 1 ? "" : "s"} · {formatWhen(c.updatedAt)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost small"
          disabled={props.running || props.turns.length === 0}
          onClick={props.onNewConversation}
          title="Start over — this conversation stays in the list"
        >
          + new
        </button>
        {current && (
          <button
            type="button"
            className="ghost icon small"
            aria-label="Delete this conversation"
            title="Delete this conversation"
            disabled={props.running}
            onClick={() => props.onDeleteConversation(current.id)}
          >
            ✕
          </button>
        )}
      </div>
      <div className="transcript" ref={transcript}>
        {props.turns.length === 0 ? (
          <div className="empty-state">
            Type a message below and press <span className="accent">Enter</span> — nodes light up on the canvas as
            the server runs them. Conversations are kept in this browser.
          </div>
        ) : (
          props.turns.map((t, i) => (
            <TurnView
              key={t.id}
              turn={t}
              verbose={props.verbose}
              pendingAnswer={i === props.turns.length - 1 && t.status === "running" ? props.pendingAnswer : undefined}
              actions={t === last ? actions : undefined}
            />
          ))
        )}
      </div>
      <label className="toggle chat-options">
        <input type="checkbox" checked={props.verbose} onChange={(e) => props.onVerbose(e.target.checked)} />
        show every node&apos;s output
      </label>
    </section>
  );
}

export interface ComposerHandle {
  /** Puts `text` in the box and focuses it, ready to change and send. */
  fill(text: string): void;
}

/** The message box, at the bottom of the panel on every tab but Tests
 * (whose Run buttons run test cases). Its button says Send, so "Run"
 * means one thing on screen. */
export function Composer(props: {
  running: boolean;
  /** The pipeline has unsaved changes: sending saves it first, since runs
   * execute what's saved on the server. */
  saveFirst: boolean;
  disabledReason: string | null;
  onSubmit: (prompt: string) => void;
  /** Stops the run in progress. */
  onStop: () => void;
  ref?: Ref<ComposerHandle>;
}) {
  const [prompt, setPrompt] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    props.ref,
    () => ({
      fill(text) {
        setPrompt(text);
        requestAnimationFrame(() => {
          box.current?.focus();
          box.current?.setSelectionRange(text.length, text.length);
        });
      },
    }),
    []
  );
  const submit = () => {
    const text = prompt.trim();
    if (!text || props.running || props.disabledReason) return;
    setPrompt("");
    props.onSubmit(text);
  };

  return (
    <div className="composer">
      <div className="input-row">
        <textarea
          ref={box}
          rows={2}
          aria-label="Message"
          placeholder={props.disabledReason ?? "Type a message…  (Enter to send, Shift+Enter for a new line)"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {props.running ? (
          <button type="button" className="danger" onClick={props.onStop} title="Stop the run (Esc)">
            <span className="btn-spinner stop-spinner" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={!prompt.trim() || props.disabledReason !== null}
            title={
              props.saveFirst
                ? "Save the pipeline, then send — runs use what's saved on the server"
                : "Send the message (Enter)"
            }
            onClick={submit}
          >
            {props.saveFirst ? "Save & send" : "Send"}
          </button>
        )}
      </div>
    </div>
  );
}
