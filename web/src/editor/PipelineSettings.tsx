import { useId } from "react";
import { modelWithIdentity, modelWithOption, setOutput, setPipelineSetting } from "@llm-pipeline/client";
import type { NodeModelConfig, PipelineDefinition, PipelineSection, PipelineSections } from "@llm-pipeline/client";
import { CommitInput, Field, ModelPicker, NumberField, OllamaOptionsForm, useModelLimits, withTemperature } from "./fields";
import { Section } from "./Section";
import { defaultsSummary, executionSummary, historySummary, outputSummary, routingSummary } from "./pipelineSummaries";
import type { Edit, InspectorProps } from "./Inspector";

// The pipeline's own settings — the Pipeline section of the left panel.

// The server's built-in history defaults (pipeline_config/schema.py), shown
// as the starting text of the format fields.
const DEFAULT_TURN_TEMPLATE =
  "User: {{ prompt }}\n{% for node, text in outputs.items() %}{{ node }}: {{ text }}\n{% endfor %}Assistant: {{ final_answer }}";
const DEFAULT_SUMMARY_PROMPT =
  "Summarize this conversation briefly. Keep names, facts, decisions and open questions; drop small talk.\n\n{{ history }}";

/** Name and description, then Output, Execution, Conversation history,
 * Defaults for all nodes and Routing as foldable sections. */
export function PipelineSettings(props: InspectorProps) {
  const { doc, editable, onEdit, onSelect, validation } = props;
  const def = doc.definition;
  const onlyOutputHint = useId();
  const exec = def.execution ?? {};
  const setExec = (key: keyof NonNullable<PipelineDefinition["execution"]>, value: number | undefined) =>
    onEdit(
      (d) => {
        const execution = { ...(d.execution ?? {}) };
        if (value === undefined) delete execution[key];
        else execution[key] = value;
        return { ...d, execution };
      },
      `pipeline:execution:${key}`
    );
  const outputs = def.output_nodes;

  return (
    <div className="inspector-body">
      <header className="inspector-title">
        <h2>{def.name}</h2>
      </header>
      {validation.status === "invalid" && (
        <p className="problem error">
          {validation.message}
          {validation.nodeId && (
            <>
              {" "}
              <button type="button" className="link" onClick={() => onSelect({ kind: "node", id: validation.nodeId! })}>
                show {validation.nodeId}
              </button>
            </>
          )}
        </p>
      )}
      {validation.status === "valid" &&
        [...validation.modelIssues, ...validation.warnings].map((issue) => (
          <p className="problem warn" key={issue.message}>
            {issue.message}
          </p>
        ))}

      <section>
        {doc.baseRevision === null && (
          <Field label="Name" hint="the file name: pipelines/<name>.yaml">
            <CommitInput value={def.name} disabled={!editable} onCommit={(v) => v && onEdit((d) => ({ ...d, name: v }))} />
          </Field>
        )}
        <Field label="Description">
          <textarea
            rows={2}
            value={def.description ?? ""}
            disabled={!editable}
            onChange={(e) => onEdit((d) => ({ ...d, description: e.target.value }), "pipeline:description")}
          />
        </Field>
      </section>

      {/* Foldable like a node's settings; ids are prefixed because open/closed
          states are remembered in one list shared with node sections. */}
      <Section id="pipeline-output" title="Output" defaultOpen summary={outputSummary(outputs)}>
        <p className="dim">The first listed node that actually ran provides the answer.</p>
        {def.nodes.map((n) => {
          const only = outputs.length === 1 && outputs[0] === n.id;
          return (
            <label className="check" key={n.id}>
              <input
                type="checkbox"
                checked={outputs.includes(n.id)}
                disabled={!editable || only}
                aria-describedby={only ? onlyOutputHint : undefined}
                onChange={(e) =>
                  onEdit((d) => setOutput(d, e.target.checked ? [...outputs, n.id] : outputs.filter((o) => o !== n.id)))
                }
              />
              {n.id}
            </label>
          );
        })}
        {outputs.length === 1 && editable && (
          <p className="field-hint" id={onlyOutputHint}>
            {outputs[0]} is the only output node — a pipeline needs at least one, so mark another before unmarking it.
          </p>
        )}
      </Section>

      <Section id="pipeline-execution" title="Execution" defaultOpen={false} summary={executionSummary(def.execution)}>
        <div className="field-stack">
          <Field label="timeout (s)" hint="per model call">
            <NumberField value={exec.model_timeout_seconds} disabled={!editable} onChange={(v) => setExec("model_timeout_seconds", v)} />
          </Field>
          <Field label="run time limit (s)" hint="for the whole run, retries and loops included (empty: no limit)">
            <NumberField
              value={exec.run_timeout_seconds}
              placeholder="no limit"
              disabled={!editable}
              onChange={(v) => setExec("run_timeout_seconds", v)}
            />
          </Field>
          <Field label="parallel model calls" hint="max nodes running at once (empty: no limit)">
            <NumberField
              value={exec.max_concurrency}
              placeholder="no limit"
              disabled={!editable}
              onChange={(v) => setExec("max_concurrency", v)}
            />
          </Field>
          <Field label="retries" hint="extra attempts on failure">
            <NumberField value={exec.max_retries} disabled={!editable} onChange={(v) => setExec("max_retries", v)} />
          </Field>
          <Field label="retry backoff (s)">
            <NumberField value={exec.retry_backoff_seconds} disabled={!editable} onChange={(v) => setExec("retry_backoff_seconds", v)} />
          </Field>
        </div>
      </Section>

      <HistorySettings {...props} />
      <NodeDefaultsSettings {...props} />

      {((def.branches ?? []).length > 0 || (def.loops ?? []).length > 0) && (
        <Section
          id="pipeline-routing"
          title="Routing"
          defaultOpen={false}
          summary={routingSummary((def.branches ?? []).length, (def.loops ?? []).length)}
        >
          <ul className="dep-list">
            {(def.branches ?? []).map((b) => (
              <li key={b.id}>
                branch <b>{b.id}</b> after{" "}
                <button type="button" className="link" onClick={() => onSelect({ kind: "node", id: b.from })}>
                  {b.from}
                </button>
              </li>
            ))}
            {(def.loops ?? []).map((l) => (
              <li key={l.id}>
                loop <b>{l.id}</b> after{" "}
                <button type="button" className="link" onClick={() => onSelect({ kind: "node", id: l.from })}>
                  {l.from}
                </button>{" "}
                → {l.back_to}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <p className="dim tip">Select a node to configure its model, temperature, prompts and Ollama options.</p>
    </div>
  );
}


/** Edits one pipeline-wide setting (see setPipelineSetting). */
function usePipelineSetter(onEdit: Edit) {
  return <S extends PipelineSection, K extends keyof PipelineSections[S]>(
    section: S,
    key: K,
    value: PipelineSections[S][K],
    coalesce = true
  ) =>
    onEdit(
      (d) => setPipelineSetting(d, section, key, value),
      coalesce ? `pipeline:${section}.${String(key)}` : undefined
    );
}

/** How earlier conversation turns reach the nodes. */
function HistorySettings(props: InspectorProps) {
  const { doc, editable, onEdit, models } = props;
  const def = doc.definition;
  const history = def.history ?? {};
  const set = usePipelineSetter(onEdit);
  const remember = history.remember ?? [];
  const summaryLimits = useModelLimits(history.summarize?.model);

  return (
    <Section id="pipeline-history" title="Conversation history" defaultOpen summary={historySummary(history)}>
      <p className="dim">
        Earlier turns reach nodes through <code>{"{{ conversation }}"}</code> (earlier turns, then the new
        message) and <code>{"{{ history }}"}</code> (earlier turns only); <code>{"{{ message }}"}</code> is the new
        message alone. Nodes can opt out in their settings.
      </p>
      <div className="field-stack">
        <Field label="turns kept" hint="most recent turns sent verbatim; 0 turns history off">
          <NumberField
            value={history.max_turns}
            placeholder="6"
            disabled={!editable}
            onChange={(v) => set("history", "max_turns", v)}
          />
        </Field>
        <Field label="character budget" hint="oldest turns go first (empty: no limit)">
          <NumberField
            value={history.max_chars}
            placeholder="no limit"
            disabled={!editable}
            onChange={(v) => set("history", "max_chars", v)}
          />
        </Field>
      </div>
      <Field label="Intro line" hint="first line of the history inside {{ conversation }}">
        <input
          type="text"
          value={history.intro ?? "Conversation so far:"}
          disabled={!editable}
          onChange={(e) => set("history", "intro", e.target.value)}
        />
      </Field>
      <Field
        label="Turn format"
        hint="how each earlier turn is written — {{ prompt }}, {{ final_answer }}, and remembered outputs as {{ outputs.<node> }}"
      >
        <textarea
          className="prompt"
          rows={3}
          spellCheck={false}
          value={history.turn_template ?? DEFAULT_TURN_TEMPLATE}
          disabled={!editable}
          onChange={(e) => set("history", "turn_template", e.target.value)}
        />
      </Field>
      {editable && history.turn_template !== undefined && history.turn_template !== DEFAULT_TURN_TEMPLATE && (
        <button type="button" className="ghost small" onClick={() => set("history", "turn_template", undefined, false)}>
          reset format
        </button>
      )}

      <Field label="Remember with each turn" hint="besides the final answer; usable in the turn format">
        <div className="check-list">
          {def.nodes.map((n) => (
            <label className="check" key={n.id}>
              <input
                type="checkbox"
                checked={remember.includes(n.id)}
                disabled={!editable}
                onChange={(e) =>
                  set(
                    "history",
                    "remember",
                    e.target.checked ? [...remember, n.id] : remember.filter((r) => r !== n.id),
                    false
                  )
                }
              />
              {n.id}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Summarize turns that don't fit" hint="one extra model call per message once the chat is long; otherwise they're dropped">
        <ModelPicker
          model={history.summarize?.model}
          models={models}
          limits={summaryLimits}
          emptyOption="off — drop them"
          disabled={!editable}
          onRefresh={props.onRefreshModels}
          onChange={(identity) =>
            onEdit((d) => {
              const summarize = d.history?.summarize;
              const model = identity ? modelWithIdentity(summarize?.model, identity) : undefined;
              return setPipelineSetting(d, "history", "summarize", model ? { ...summarize, model } : undefined);
            })
          }
        />
      </Field>
      {history.summarize && (
        <Field label="Summary prompt" hint="must include {{ history }} — the turns being condensed">
          <textarea
            className="prompt"
            rows={3}
            spellCheck={false}
            value={history.summarize.prompt ?? DEFAULT_SUMMARY_PROMPT}
            disabled={!editable}
            onChange={(e) => {
              const prompt = e.target.value;
              onEdit((d) => {
                const summarize = d.history?.summarize;
                return summarize ? setPipelineSetting(d, "history", "summarize", { ...summarize, prompt }) : d;
              }, "pipeline:history.summarize.prompt");
            }}
          />
        </Field>
      )}
    </Section>
  );
}

/** Settings every node inherits unless it sets its own. */
function NodeDefaultsSettings(props: InspectorProps) {
  const { doc, editable, onEdit, models } = props;
  const defaults = doc.definition.defaults ?? {};
  const set = usePipelineSetter(onEdit);
  /** A change to the default model — its temperature or options. */
  const tuneDefaultModel = (change: (model: NodeModelConfig) => NodeModelConfig, key: string) =>
    onEdit(
      (d) => (d.defaults?.model ? setPipelineSetting(d, "defaults", "model", change(d.defaults.model)) : d),
      `pipeline:defaults.${key}`
    );
  const limits = useModelLimits(defaults.model);

  return (
    <Section id="pipeline-defaults" title="Defaults for all nodes" defaultOpen={false} summary={defaultsSummary(defaults)}>
      <p className="dim">Nodes use these unless they set their own.</p>
      <Field label="Model" hint="nodes without their own model use it; others inherit its temperature and Ollama options">
        <ModelPicker
          model={defaults.model}
          models={models}
          limits={limits}
          emptyOption="none — every node sets its own"
          disabled={!editable}
          onRefresh={props.onRefreshModels}
          onChange={(identity) =>
            onEdit((d) =>
              setPipelineSetting(d, "defaults", "model", identity ? modelWithIdentity(d.defaults?.model, identity) : undefined)
            )
          }
        />
      </Field>
      {defaults.model && (
        <Field label="Temperature" hint="for nodes that don't set one">
          <NumberField
            value={defaults.model.temperature}
            placeholder="0.2"
            disabled={!editable}
            onChange={(v) => tuneDefaultModel((m) => withTemperature(m, v), "temperature")}
          />
        </Field>
      )}
      <Field label="System prompt" hint="for nodes without their own">
        <textarea
          className="prompt"
          rows={3}
          value={defaults.system_prompt ?? ""}
          disabled={!editable}
          onChange={(e) => set("defaults", "system_prompt", e.target.value || undefined)}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={defaults.strip_reasoning ?? false}
          disabled={!editable}
          onChange={(e) => set("defaults", "strip_reasoning", e.target.checked || undefined, false)}
        />
        strip &lt;think&gt; reasoning from outputs (qwen3, deepseek-r1 …)
      </label>
      {defaults.model?.provider === "ollama" && (
        <OllamaOptionsForm
          options={defaults.model.options}
          maxContext={limits?.context_length}
          disabled={!editable}
          onChange={(key, value) => tuneDefaultModel((m) => modelWithOption(m, key, value), `options.${key}`)}
        />
      )}
    </Section>
  );
}
