import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  DraftError,
  applyPreset,
  disconnect,
  effectiveModel,
  findNode,
  modelIdentity,
  modelWithIdentity,
  modelWithOption,
  nodeIds,
  removeBranch,
  removeLoop,
  removeNode,
  renameNode,
  routeTargets,
  setNodeModel,
  setNodeProperty,
  setOutput,
  setPipelineSetting,
  updateNodeModel,
  upsertBranch,
  upsertLoop,
} from "@llm-pipeline/client";
import type {
  BranchConfig,
  BranchRoute,
  LoopConfig,
  ModelsResponse,
  NodeConfig,
  NodeModelConfig,
  NodePreset,
  NodeProperty,
  PipelineDefinition,
  PipelineSection,
  PipelineSections,
} from "@llm-pipeline/client";
import type { EditorDoc, Selection, ValidationState } from "./editorState";
import {
  CommitInput,
  Field,
  ModelPicker,
  NumberField,
  OllamaOptionFields,
  OllamaOptionsForm,
  ollamaOptionsSummary,
  useModelLimits,
} from "./fields";
import { Section } from "./Section";
import { useDialogs } from "../ui/Dialogs";
import { MenuButton } from "../ui/Menu";
import { PromptPreview } from "./PromptPreview";
import { parseList } from "../format";
import type { PreviewContext } from "./PromptPreview";
import { MessageEntry } from "../run/MessageEntry";
import type { Turn } from "../run/Chat";

// The server's built-in history defaults (pipeline_config/schema.py), shown
// as the starting text of the format fields.
const DEFAULT_TURN_TEMPLATE =
  "User: {{ prompt }}\n{% for node, text in outputs.items() %}{{ node }}: {{ text }}\n{% endfor %}Assistant: {{ final_answer }}";
const DEFAULT_SUMMARY_PROMPT =
  "Summarize this conversation briefly. Keep names, facts, decisions and open questions; drop small talk.\n\n{{ history }}";

/** `coalesce` names the field being edited, so continuous edits to it
 * (typing, dragging a slider) form one undo step. `removed` says what a
 * deletion removed; the app then offers to undo it. */
type Edit = (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string, removed?: string) => void;

export interface InspectorProps {
  doc: EditorDoc;
  selection: Selection | null;
  editable: boolean;
  models: ModelsResponse | null;
  presets: NodePreset[];
  /** This session's runs — the node's Trace tab shows its part of them. */
  turns: Turn[];
  validation: ValidationState;
  onEdit: Edit;
  onSelect: (selection: Selection | null) => void;
  onRefreshModels: () => void;
  /** Opens the "save as preset" dialog for a node. */
  onSaveAsPreset: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
  /** Nodes the latest run can be re-run from (empty while running). */
  rerunnable: Set<string>;
  onRerun: (nodeId: string) => void;
  /** The latest message and its outputs, for prompt previews. */
  previewContext: PreviewContext | null;
}

type NodeTab = "config" | "trace";

export function Inspector(props: InspectorProps) {
  const { doc, selection } = props;
  // Kept while moving between nodes, so you can step through each node's messages.
  const [tab, setTab] = useState<NodeTab>("config");
  const node =
    selection?.kind === "node" ? doc.definition.nodes.find((n) => n.id === selection.id) : undefined;

  // Each new selection starts at the top, where its problems are shown.
  const panel = useRef<HTMLDivElement>(null);
  const selectionKey =
    selection?.kind === "node" ? `node:${selection.id}` : selection?.kind === "edge" ? `edge:${selection.from}->${selection.to}` : "pipeline";
  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
  }, [selectionKey]);

  return (
    <div className="inspector" ref={panel}>
      {node ? (
        <NodeInspector key={node.id} node={node} tab={tab} onTab={setTab} {...props} />
      ) : selection?.kind === "edge" ? (
        <EdgeInspector from={selection.from} to={selection.to} {...props} />
      ) : (
        <PipelineInspector {...props} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "pipeline-name › node": where these settings sit, and the way back up
 * to the pipeline's own settings. */
function Breadcrumb({ pipeline, kind, onPipeline }: { pipeline: string; kind: string; onPipeline: () => void }) {
  return (
    <nav className="kicker breadcrumb" aria-label="Breadcrumb">
      <button type="button" className="link" title="The pipeline's own settings" onClick={onPipeline}>
        {pipeline}
      </button>
      <span aria-hidden="true">›</span>
      <span>{kind}</span>
    </nav>
  );
}

/** A variable a prompt template can use, and what it holds — its insert
 * button's tooltip, and a line of the template syntax. */
interface TemplateVariable {
  text: string;
  meaning: string;
}

function PromptEditor(props: {
  label: string;
  hint?: string;
  value: string;
  /** Insert buttons above the text box; none for a plain-text prompt. */
  variables: TemplateVariable[];
  disabled: boolean;
  rows: number;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Shown under the hint (the template syntax). */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxId = useId();

  const insert = (text: string) => {
    const el = ref.current;
    if (!el) return props.onChange(props.value + text);
    const start = el.selectionStart ?? props.value.length;
    const end = el.selectionEnd ?? start;
    props.onChange(props.value.slice(0, start) + text + props.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };

  // Not a <label> around it all (see Field): a label passes clicks to its
  // first control — here an insert button, so clicking the label's text
  // would insert a variable into the prompt.
  return (
    <div className="field">
      <label className="field-label" htmlFor={boxId}>
        {props.label}
      </label>
      {props.variables.length > 0 && !props.disabled && (
        <div className="chips">
          {props.variables.map((v) => (
            <button type="button" key={v.text} className="chip" title={`${v.meaning} — click to insert`} onClick={() => insert(v.text)}>
              {v.text}
            </button>
          ))}
        </div>
      )}
      <textarea
        id={boxId}
        ref={ref}
        className="prompt"
        rows={props.rows}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="field-hint">{props.hint}</span>}
      {props.children}
    </div>
  );
}

/** The whole template syntax, one line per variable — opened on demand
 * instead of a paragraph under the text box. */
function TemplateSyntax({ variables }: { variables: TemplateVariable[] }) {
  return (
    <details className="syntax">
      <summary>Template syntax</summary>
      <dl>
        {variables.map((v) => (
          <Fragment key={v.text}>
            <dt>
              <code>{v.text}</code>
            </dt>
            <dd>{v.meaning}</dd>
          </Fragment>
        ))}
        <dt>
          <code>{"{{ node.output }}"}</code>
        </dt>
        <dd>a node&apos;s reply — that node must be one this one depends on, or loop back to it</dd>
        <dt>
          <code>{"{{ question }}"}</code> <code>{"{{ input }}"}</code>
        </dt>
        <dd>older names for message and conversation</dd>
      </dl>
    </details>
  );
}

/** One line of a template, for a folded section's summary. */
function excerpt(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function NodeInspector(props: InspectorProps & { node: NodeConfig; tab: NodeTab; onTab: (tab: NodeTab) => void }) {
  const { node, doc, editable, onEdit, onSelect, presets, validation, tab, onTab } = props;
  const dialogs = useDialogs();
  const def = doc.definition;
  const id = node.id;
  /** One of the node's settings; `coalesce` folds a burst of edits (typing,
   * dragging) into one undo step. */
  const set = <K extends NodeProperty>(key: K, value: NodeConfig[K], coalesce = true) =>
    onEdit((d) => setNodeProperty(d, id, key, value), coalesce ? `node:${id}:${key}` : undefined);
  /** A change to the node's own model — its temperature or options. */
  const tuneModel = (change: (model: NodeModelConfig) => NodeModelConfig, key: string) =>
    onEdit((d) => updateNodeModel(d, id, change), `node:${id}:${key}`);
  const limits = useModelLimits(node.model);
  const deps = node.depends_on ?? [];
  const isOutput = def.output_nodes.includes(id);
  const onlyOutput = isOutput && def.output_nodes.length === 1;
  const onlyOutputHint = useId();
  const [presetChoice, setPresetChoice] = useState("");

  const branch = (def.branches ?? []).find((b) => b.from === id);
  const loop = (def.loops ?? []).find((l) => l.from === id);
  const loopBackSources = (def.loops ?? []).filter((l) => l.back_to === id).map((l) => l.from);
  const variables: TemplateVariable[] = [
    { text: "{{ message }}", meaning: "the new message" },
    {
      text: "{{ conversation }}",
      meaning:
        node.include_history === false
          ? "just the new message (this node doesn't see the history)"
          : "earlier turns, then the new message",
    },
    { text: "{{ history }}", meaning: "earlier turns only" },
    ...[...new Set([...deps, ...loopBackSources])].map((d) => ({
      text: `{{ ${d}.output }}`,
      meaning: deps.includes(d) ? `what ${d} replied` : `what ${d} replied on the loop's last pass`,
    })),
  ];
  const defaults = def.defaults ?? {};
  const effective = effectiveModel(def, node);
  const problem =
    validation.status === "invalid" && validation.nodeId === id
      ? validation.message
      : validation.status === "valid"
        ? [...validation.modelIssues, ...validation.warnings]
            .filter((i) => i.nodeId === id)
            .map((i) => i.message)
            .join("\n") || undefined
        : undefined;

  /** Renaming updates every reference; the dialog checks the new id as
   * it's typed, by trying the rename. */
  const rename = async () => {
    const next = await dialogs.prompt({
      title: `Rename "${id}"`,
      label: "New id — every reference to it is updated",
      initial: id,
      confirmLabel: "Rename",
      validate: (value) => {
        try {
          renameNode(def, id, value);
          return null;
        } catch (err) {
          if (err instanceof DraftError) return err.message;
          throw err;
        }
      },
    });
    if (!next || next === id) return;
    onEdit((d) => renameNode(d, id, next));
    onSelect({ kind: "node", id: next });
  };

  const inputOutput = [
    isOutput ? "output node" : null,
    node.include_history === false ? "no history" : null,
    node.strip_reasoning === true ? "strips reasoning" : node.strip_reasoning === false ? "keeps reasoning" : null,
    node.labels?.length ? `labels: ${node.labels.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <div className="inspector-body">
      <header className="inspector-title">
        <Breadcrumb pipeline={def.name} kind="node" onPipeline={() => onSelect(null)} />
        <h2>{id}</h2>
        {(editable || props.rerunnable.has(id)) && (
          <div className="title-actions">
            {props.rerunnable.has(id) && (
              <button
                type="button"
                title="Run the latest message again from this node — the nodes before it reuse their outputs"
                onClick={() => props.onRerun(id)}
              >
                ↻ Re-run from here
              </button>
            )}
            {editable && (
              <button type="button" className="ghost" title="Copy this node beside it (⌘D / Ctrl+D)" onClick={() => props.onDuplicate(id)}>
                Duplicate
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="ghost"
                title="Save this node's configuration to reuse it in any pipeline"
                onClick={() => props.onSaveAsPreset(id)}
              >
                Save as preset
              </button>
            )}
            {editable && (
              <MenuButton
                label="⋯"
                ariaLabel="More node actions"
                caret={false}
                align="end"
                items={[
                  { label: "Rename…", onSelect: () => void rename(), detail: "updates every reference to it" },
                  {
                    label: "Delete node",
                    onSelect: () => {
                      onEdit((d) => removeNode(d, id), undefined, `Deleted node "${id}"`);
                      onSelect(null);
                    },
                    detail: "undo with ⌘Z / Ctrl+Z",
                    separated: true,
                    danger: true,
                  },
                ]}
              />
            )}
          </div>
        )}
      </header>
      {problem && <p className={validation.status === "invalid" ? "problem error" : "problem warn"}>{problem}</p>}

      <div className="tabs" role="tablist" aria-label="Node view">
        <button type="button" role="tab" aria-selected={tab === "config"} className={tab === "config" ? "tab active" : "tab"} onClick={() => onTab("config")}>
          Configuration
        </button>
        <button type="button" role="tab" aria-selected={tab === "trace"} className={tab === "trace" ? "tab active" : "tab"} onClick={() => onTab("trace")}>
          Trace
        </button>
      </div>

      {tab === "trace" ? (
        <NodeMessages nodeId={id} turns={props.turns} isOutput={isOutput} />
      ) : (
        <>
          <Section
            id="model"
            title="Model"
            defaultOpen
            summary={`${node.model ? modelIdentity(node.model) : "pipeline default"} · T ${effective?.temperature ?? 0.2}`}
          >
            <ModelPicker
              model={node.model}
              models={props.models}
              limits={limits}
              {...(defaults.model ? { emptyOption: `pipeline default (${modelIdentity(defaults.model)})` } : {})}
              disabled={!editable}
              onRefresh={props.onRefreshModels}
              onChange={(identity) =>
                onEdit((d) => setNodeModel(d, id, identity ? modelWithIdentity(findNode(d, id).model, identity) : undefined))
              }
            />
            {node.model ? (
              <Field
                label={`Temperature · ${effective?.temperature ?? 0.2}${node.model.temperature === undefined ? " (inherited)" : ""}`}
                hint="0 = deterministic, higher = more varied"
              >
                <div className="row">
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={effective?.temperature ?? 0.2}
                    disabled={!editable}
                    aria-label="Temperature"
                    onChange={(e) => {
                      const temperature = Number(e.target.value);
                      tuneModel((m) => withTemperature(m, temperature), "temperature");
                    }}
                  />
                  <NumberField
                    value={node.model.temperature}
                    placeholder={`${effective?.temperature ?? 0.2}`}
                    disabled={!editable}
                    ariaLabel="Temperature value"
                    onChange={(v) => tuneModel((m) => withTemperature(m, v), "temperature")}
                  />
                </div>
              </Field>
            ) : (
              <p className="dim">
                Runs with the pipeline default model — temperature {effective?.temperature ?? 0.2}
                {Object.keys(effective?.options ?? {}).length > 0 ? " and its Ollama options" : ""}. Pick a model above
                to customize this node.
              </p>
            )}
          </Section>

          <Section id="prompts" title="Prompts" defaultOpen summary={excerpt(node.prompt_template)}>
            <PromptEditor
              label="System prompt"
              hint="sent as the model's system message; plain text"
              value={node.system_prompt ?? ""}
              {...(defaults.system_prompt ? { placeholder: `pipeline default: ${defaults.system_prompt}` } : {})}
              variables={[]}
              rows={3}
              disabled={!editable}
              onChange={(v) => set("system_prompt", v === "" ? undefined : v)}
            />
            <PromptEditor
              label="Prompt template"
              {...(editable ? { hint: "Click a variable to insert it — hover for what it holds." } : {})}
              value={node.prompt_template}
              variables={variables}
              rows={7}
              disabled={!editable}
              onChange={(v) => set("prompt_template", v)}
            >
              <TemplateSyntax variables={variables} />
            </PromptEditor>
            {editable && <PromptPreview definition={def} nodeId={id} context={props.previewContext} />}
          </Section>

          <Section id="io" title="Input & output" defaultOpen={false} summary={inputOutput.join(" · ") || "defaults"}>
            <label className="check">
              <input
                type="checkbox"
                checked={isOutput}
                disabled={!editable || onlyOutput}
                aria-describedby={onlyOutput ? onlyOutputHint : undefined}
                onChange={(e) => {
                  const current = def.output_nodes;
                  onEdit((d) => setOutput(d, e.target.checked ? [...current, id] : current.filter((o) => o !== id)));
                }}
              />
              output node — its answer is the pipeline&apos;s answer
            </label>
            {onlyOutput && editable && (
              <p className="field-hint" id={onlyOutputHint}>
                The pipeline&apos;s only output node — it needs at least one, so mark another before unmarking this.
              </p>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={node.include_history ?? true}
                disabled={!editable}
                onChange={(e) => set("include_history", e.target.checked ? undefined : false, false)}
              />
              sees the conversation history — off: {"{{ conversation }}"} is just the new message
            </label>
            <Field label="Strip <think> reasoning">
              <select
                value={node.strip_reasoning === undefined ? "" : node.strip_reasoning ? "on" : "off"}
                disabled={!editable}
                onChange={(e) =>
                  set("strip_reasoning", e.target.value === "" ? undefined : e.target.value === "on", false)
                }
              >
                <option value="">pipeline default ({defaults.strip_reasoning ? "on" : "off"})</option>
                <option value="on">on — remove reasoning from this node&apos;s output</option>
                <option value="off">off — keep it</option>
              </select>
            </Field>
            <Field label="Classifier labels" hint="comma-separated — the output becomes exactly one of them, for branches to route on">
              <CommitInput
                value={(node.labels ?? []).join(", ")}
                disabled={!editable}
                ariaLabel="Classifier labels"
                onCommit={(v) => set("labels", parseList(v), false)}
              />
            </Field>
          </Section>

          {node.model?.provider === "ollama" && (
            <Section
              id="ollama"
              title="Ollama options"
              defaultOpen={Object.keys(node.model.options ?? {}).length > 0}
              summary={ollamaOptionsSummary(node.model.options)}
            >
              {defaults.model?.provider === "ollama" && Object.keys(defaults.model.options ?? {}).length > 0 && (
                <p className="dim">Options left empty use the pipeline default&apos;s.</p>
              )}
              <OllamaOptionFields
                options={node.model.options}
                maxContext={limits?.context_length}
                disabled={!editable}
                onChange={(key, value) => tuneModel((m) => modelWithOption(m, key, value), `options.${key}`)}
              />
            </Section>
          )}

          <Section id="depends" title="Depends on" defaultOpen={false} summary={deps.length ? deps.join(", ") : "nothing — starts first"}>
            {deps.length === 0 ? (
              <p className="dim">nothing — starts as soon as the run does. Drag from another node&apos;s bottom dot to this node&apos;s top dot to add one.</p>
            ) : (
              <ul className="dep-list">
                {deps.map((dep) => (
                  <li key={dep}>
                    <button type="button" className="link" onClick={() => onSelect({ kind: "node", id: dep })}>
                      {dep}
                    </button>
                    {editable && (
                      <button type="button" className="ghost small" onClick={() => onEdit((d) => disconnect(d, dep, id), undefined, `Removed the dependency ${dep} → ${id}`)}>
                        remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="routing"
            title="Routing"
            defaultOpen={Boolean(branch || loop)}
            summary={branch ? `branch · ${branch.routes.length} routes` : loop ? `loop back to ${loop.back_to}` : "plain edges"}
          >
            {branch ? (
              <BranchForm branch={branch} def={def} editable={editable} onEdit={onEdit} />
            ) : loop ? (
              <LoopForm loop={loop} def={def} editable={editable} onEdit={onEdit} />
            ) : (
              <>
                <p className="dim">Plain edges. Add a branch to pick ONE next node by its output, or a loop to repeat an earlier step.</p>
                {editable && (
                  <div className="row">
                    <button type="button" className="ghost" onClick={() => onEdit((d) => upsertBranch(d, newBranch(d, id)))}>
                      + branch
                    </button>
                    <button type="button" className="ghost" onClick={() => onEdit((d) => upsertLoop(d, newLoop(d, id)))}>
                      + loop
                    </button>
                  </div>
                )}
              </>
            )}
          </Section>

          <Section id="presets" title="Presets" defaultOpen={false} summary={presets.length ? `${presets.length} saved` : "none saved"}>
            {!editable ? (
              <p className="dim">Editing is disabled on this server.</p>
            ) : presets.length === 0 ? (
              <p className="dim">None yet — Save as preset (above) keeps this node&apos;s configuration to reuse anywhere.</p>
            ) : (
              <>
                <p className="field-hint">Give this node a preset&apos;s configuration — its id and connections stay.</p>
                <div className="row">
                  <select value={presetChoice} onChange={(e) => setPresetChoice(e.target.value)} aria-label="Preset">
                    <option value="">choose a preset…</option>
                    {presets.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} — {p.model.provider}:{p.model.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!presetChoice}
                    title={presetChoice ? "Give this node the preset's configuration" : "Choose a preset first"}
                    onClick={() => {
                      const preset = presets.find((p) => p.name === presetChoice);
                      if (preset) onEdit((d) => applyPreset(d, id, preset));
                      setPresetChoice("");
                    }}
                  >
                    Apply
                  </button>
                </div>
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

/** What this node received and replied in each run of the session, newest
 * first — including loop re-runs, and live while it runs. */
function NodeMessages({ nodeId, turns, isOutput }: { nodeId: string; turns: Turn[]; isOutput: boolean }) {
  const runs = turns
    .map((turn, index) => ({ turn, index, entries: turn.log.filter((e) => e.nodeId === nodeId) }))
    .filter((r) => r.entries.length > 0)
    .reverse();
  if (runs.length === 0) {
    return (
      <p className="dim tip">
        <b>{nodeId}</b> hasn&apos;t run in this session yet. Send a message below — what it receives and replies shows up
        here, live.
      </p>
    );
  }
  return (
    <div className="node-messages">
      {runs.map(({ turn, index, entries }) => (
        <section key={turn.id} className="node-messages-run">
          <h3>
            run {index + 1} <span className="dim">› {turn.prompt}</span>
          </h3>
          {entries
            .slice()
            .reverse()
            .map((entry) => (
              <MessageEntry key={entry.key} entry={entry} isOutput={isOutput} showNodeId={false} />
            ))}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function newBranch(def: PipelineDefinition, from: string): BranchConfig {
  const others = nodeIds(def).filter((n) => n !== from);
  return {
    id: `${from}_route`,
    from,
    routes: [
      { when: '"YES" in output', to: others[0] ?? from },
      { default: true, to: others[1] ?? others[0] ?? from },
    ],
  };
}

function newLoop(def: PipelineDefinition, from: string): LoopConfig {
  const node = def.nodes.find((n) => n.id === from);
  return {
    id: `${from}_loop`,
    from,
    back_to: node?.depends_on?.[0] ?? from,
    exit_to: "END",
    exit_when: 'output.startswith("APPROVE")',
    max_iterations: 3,
    on_max_iterations: "proceed",
  };
}

/** A route's targets: one dropdown each (swap it for another node), a ✕ on
 * each once there are several, and "+ target" to start another node too. */
function RouteTargets(props: {
  route: BranchRoute;
  index: number;
  candidates: string[];
  editable: boolean;
  /** `removed`: what a ✕ took out, to offer undoing it. */
  onChange: (to: string | string[], removed?: string) => void;
}) {
  const { route, index, candidates, editable, onChange } = props;
  const chosen = routeTargets(route);
  const commit = (next: string[], removed?: string) => onChange(next.length === 1 ? next[0]! : next, removed);
  const addable = candidates.filter((t) => !chosen.includes(t));

  return (
    <div className="route-targets">
      {chosen.map((target, k) => (
        <span className="route-target" key={target}>
          <select
            value={target}
            disabled={!editable}
            aria-label={`Route ${index + 1} target${chosen.length > 1 ? ` ${k + 1}` : ""}`}
            onChange={(e) => commit(chosen.map((t, m) => (m === k ? e.target.value : t)))}
          >
            {candidates.includes(target) ? null : <option value={target}>{target}</option>}
            {candidates
              .filter((t) => t === target || !chosen.includes(t))
              .map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
          </select>
          {editable && chosen.length > 1 && (
            <button
              type="button"
              className="ghost small"
              aria-label={`Remove ${target} from route ${index + 1}`}
              onClick={() => commit(chosen.filter((t) => t !== target), `Removed ${target} from route ${index + 1}`)}
            >
              ✕
            </button>
          )}
        </span>
      ))}
      {editable && addable.length > 0 && (
        <select
          className="route-add-target"
          value=""
          aria-label={`Add a target to route ${index + 1}`}
          onChange={(e) => e.target.value && commit([...chosen, e.target.value])}
        >
          <option value="">+ target</option>
          {addable.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function BranchForm(props: { branch: BranchConfig; def: PipelineDefinition; editable: boolean; onEdit: Edit }) {
  const { branch, def, editable, onEdit } = props;
  const targets = nodeIds(def).filter((n) => n !== branch.from);
  const save = (next: BranchConfig, field?: string, removed?: string) =>
    onEdit((d) => upsertBranch(d, next, branch.id), field ? `branch:${branch.id}:${field}` : undefined, removed);

  return (
    <div className="routing-form">
      <p className="dim">
        After this node runs, the first route whose condition matches runs next; otherwise the default. Conditions read its{" "}
        <code>output</code> and the new <code>message</code>. A route can start several nodes. Route targets must have no
        dependencies of their own.
      </p>
      <Field label="Branch id">
        <CommitInput value={branch.id} disabled={!editable} onCommit={(v) => v && save({ ...branch, id: v })} />
      </Field>
      {branch.routes.map((route, i) => (
        <div className="route" key={i}>
          {route.default ? (
            <span className="route-default">default</span>
          ) : (
            <input
              type="text"
              value={route.when ?? ""}
              disabled={!editable}
              aria-label={`Route ${i + 1} condition`}
              placeholder='"YES" in output'
              onChange={(e) =>
                save(
                  { ...branch, routes: branch.routes.map((r, j) => (j === i ? { ...r, when: e.target.value } : r)) },
                  `route:${i}:when`
                )
              }
            />
          )}
          <span className="arrow">→</span>
          <RouteTargets
            route={route}
            index={i}
            candidates={targets}
            editable={editable}
            onChange={(to, removed) =>
              save({ ...branch, routes: branch.routes.map((r, j) => (j === i ? { ...r, to } : r)) }, undefined, removed)
            }
          />
          {editable && !route.default && (
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                save({ ...branch, routes: branch.routes.filter((_, j) => j !== i) }, undefined, `Removed route ${i + 1} of ${branch.id}`)
              }
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {editable && (
        <div className="row">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const routes = [...branch.routes];
              const defaultIndex = routes.findIndex((r) => r.default);
              routes.splice(defaultIndex < 0 ? routes.length : defaultIndex, 0, {
                when: '"KEYWORD" in output',
                to: targets[0] ?? branch.from,
              });
              save({ ...branch, routes });
            }}
          >
            + route
          </button>
          <button type="button" className="ghost danger-text" onClick={() => onEdit((d) => removeBranch(d, branch.id), undefined, `Removed the branch ${branch.id}`)}>
            remove branch
          </button>
        </div>
      )}
    </div>
  );
}

function LoopForm(props: { loop: LoopConfig; def: PipelineDefinition; editable: boolean; onEdit: Edit }) {
  const { loop, def, editable, onEdit } = props;
  const ids = nodeIds(def);
  const save = (next: LoopConfig, field?: string) =>
    onEdit((d) => upsertLoop(d, next, loop.id), field ? `loop:${loop.id}:${field}` : undefined);

  return (
    <div className="routing-form">
      <p className="dim">
        After this node runs, go back to <b>{loop.back_to}</b> until the exit condition holds on its{" "}
        <code>output</code> (or the iteration cap is hit).
      </p>
      <Field label="Loop id">
        <CommitInput value={loop.id} disabled={!editable} onCommit={(v) => v && save({ ...loop, id: v })} />
      </Field>
      <Field label="Go back to">
        <select value={loop.back_to} disabled={!editable} onChange={(e) => save({ ...loop, back_to: e.target.value })}>
          {ids.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Exit when" hint="a Python-like condition on `output`">
        <input
          type="text"
          value={loop.exit_when}
          disabled={!editable}
          onChange={(e) => save({ ...loop, exit_when: e.target.value }, "exit_when")}
        />
      </Field>
      <Field label="Then go to">
        <select value={loop.exit_to} disabled={!editable} onChange={(e) => save({ ...loop, exit_to: e.target.value })}>
          <option value="END">END — finish the run</option>
          {ids
            .filter((n) => n !== loop.from)
            .map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Max iterations">
        <NumberField
          value={loop.max_iterations}
          disabled={!editable}
          onChange={(v) => save({ ...loop, max_iterations: v }, "max_iterations")}
        />
      </Field>
      <Field label="At the cap">
        <select
          value={loop.on_max_iterations ?? "proceed"}
          disabled={!editable}
          onChange={(e) => save({ ...loop, on_max_iterations: e.target.value as "proceed" | "fail" })}
        >
          <option value="proceed">proceed</option>
          <option value="fail">fail the run</option>
        </select>
      </Field>
      {editable && (
        <button type="button" className="ghost danger-text" onClick={() => onEdit((d) => removeLoop(d, loop.id), undefined, `Removed the loop ${loop.id}`)}>
          remove loop
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EdgeInspector(props: InspectorProps & { from: string; to: string }) {
  const { from, to, editable, onEdit, onSelect } = props;
  return (
    <div className="inspector-body">
      <header className="inspector-title">
        <Breadcrumb pipeline={props.doc.definition.name} kind="dependency" onPipeline={() => onSelect(null)} />
        <h2>
          {from} → {to}
        </h2>
      </header>
      <p className="dim">
        <b>{to}</b> waits for <b>{from}</b> to finish, and may use <code>{`{{ ${from}.output }}`}</code> in its prompt.
      </p>
      {editable && (
        <button
          type="button"
          className="danger"
          onClick={() => {
            onEdit((d) => disconnect(d, from, to), undefined, `Removed the dependency ${from} → ${to}`);
            onSelect(null);
          }}
        >
          Remove dependency
        </button>
      )}
    </div>
  );
}

function PipelineInspector(props: InspectorProps) {
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
        <span className="kicker">pipeline</span>
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

      <section>
        <h3>Output</h3>
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
      </section>

      <section>
        <h3>Execution</h3>
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
      </section>

      <HistorySettings {...props} />
      <NodeDefaultsSettings {...props} />

      {((def.branches ?? []).length > 0 || (def.loops ?? []).length > 0) && (
        <section>
          <h3>Routing</h3>
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
        </section>
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

/** `model` with its own temperature, or — with `undefined` — none, so it
 * inherits the pipeline default's. */
function withTemperature(model: NodeModelConfig, temperature: number | undefined): NodeModelConfig {
  const { temperature: _old, ...rest } = model;
  return temperature === undefined ? rest : { ...rest, temperature };
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
    <section>
      <h3>Conversation history</h3>
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
    </section>
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
    <section>
      <h3>Defaults for all nodes</h3>
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
    </section>
  );
}
