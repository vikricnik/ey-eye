import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { compactCount, describeUsage } from "@llm-pipeline/client";
import type { NodeExecutionStatus } from "@llm-pipeline/client";
import { LOOP_IN_HANDLE, LOOP_OUT_HANDLE } from "./conversion";
import type { LlmFlowNode } from "./conversion";
import { formatDuration } from "../format";

const STATUS_LABEL: Record<NodeExecutionStatus, string> = {
  "not-started": "idle",
  running: "running",
  complete: "done",
  failed: "failed",
};

/** One LLM step on the canvas: its id, model and temperature, and — while
 * a run is in progress — whether the server says it is running right now.
 * Zoomed out, CSS shows only the id, model and a status mark (see
 * "Zoomed-out cards" in style.css). */
function LlmNodeView({ data, selected }: NodeProps<LlmFlowNode>) {
  const classes = [
    "llm-node",
    `status-${data.status}`,
    selected ? "selected" : "",
    data.problem ? `problem-${data.problem}` : "",
  ].join(" ");
  const usage = describeUsage(data.usage);
  const tokens =
    usage?.contextShort ??
    (data.usage?.prompt_tokens != null ? `${compactCount(data.usage.prompt_tokens)} tok` : null);

  return (
    <div className={classes} data-testid={`node-${data.nodeId}`}>
      <Handle type="target" position={Position.Top} />
      {/* On the card's top edge, so it takes no room from the id. */}
      {data.isOutput && (
        <span className="output-badge" title="An output node: the pipeline's answer comes from the first one that ran">
          output
        </span>
      )}
      <div className="llm-node-head">
        <span className="llm-node-id" title={data.nodeId}>
          {data.nodeId}
        </span>
        {/* Nothing before a run: "idle" on every card says nothing. */}
        {data.status !== "not-started" && (
          <span className={`status-pill status-${data.status}`}>
            {data.status === "running" && <span className="pulse-dot" aria-hidden="true" />}
            <span className="status-label">
              {data.status === "complete" && data.replayed ? "reused" : STATUS_LABEL[data.status]}
            </span>
          </span>
        )}
      </div>
      <div className="llm-node-model" title={data.model}>
        {data.model}
      </div>
      {data.liveText && (
        <div className="llm-node-live" aria-live="off">
          <span>{data.liveText}</span>
        </div>
      )}
      <div className="llm-node-meta">
        <span>T={data.temperature ?? "default"}</span>
        {data.optionCount > 0 && <span>{data.optionCount} opt</span>}
        {data.hasSystemPrompt && <span>system</span>}
        {data.status === "complete" && data.durationMs !== undefined && !data.replayed && (
          <span>{formatDuration(data.durationMs)}</span>
        )}
        {usage && tokens && (
          <span
            className={`meta-usage level-${usage.level ?? "ok"}`}
            title={[usage.summary, usage.warning].filter(Boolean).join("\n\n")}
          >
            {usage.level === "full" ? "⚠ " : ""}
            {tokens}
          </span>
        )}
        {data.problem === "error" && <span className="meta-error">invalid</span>}
        {data.problem === "warning" && <span className="meta-warn">model?</span>}
      </div>
      <Handle type="source" position={Position.Bottom} />
      {/* Loop back-edges leave and re-enter on the right, so a loop draws as
          a bracket beside the nodes instead of overlapping the downward
          edge between them. Not connectable: loops are edited in the
          inspector. */}
      <Handle
        type="source"
        id={LOOP_OUT_HANDLE}
        position={Position.Right}
        isConnectable={false}
        className="loop-handle"
        style={{ top: "65%" }}
      />
      <Handle
        type="target"
        id={LOOP_IN_HANDLE}
        position={Position.Right}
        isConnectable={false}
        className="loop-handle"
        style={{ top: "35%" }}
      />
    </div>
  );
}

export const LlmNode = memo(LlmNodeView);
