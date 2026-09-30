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
} from "@llm-pipeline/client";
import type { EditorDoc, Selection, ValidationState } from "./editorState";
import {
  CommitInput,
  Field,
  ModelPicker,
  NumberField,
  OllamaOptionFields,
  ollamaOptionsSummary,
  useModelLimits,
  withTemperature,
} from "./fields";
import { Section } from "./Section";
import { useDialogs } from "../ui/Dialogs";
import { MenuButton } from "../ui/Menu";
import { PromptPreview } from "./PromptPreview";
import { parseList } from "../format";
import type { PreviewContext } from "./PromptPreview";
import { NodeTrace } from "./NodeTrace";
import { nodeTraceSummary } from "./traceSummary";
import type { Turn } from "../run/Chat";

/** `coalesce` names the field being edited, so continuous edits to it
 * (typing, dragging a slider) form one undo step. `removed` says what a
 * deletion removed; the app then offers to undo it. */
export type Edit = (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string, removed?: string) => void;

export interface InspectorProps {
  doc: EditorDoc;
  selection: Selection | null;
  editable: boolean;
  models: ModelsResponse | null;
  presets: NodePreset[];
  /** This session's runs — a node's Trace section shows its part of them. */
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

export function Inspector(props: InspectorProps) {
  const { doc, selection } = props;
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
        <NodeInspector key={node.id} node={node} {...props} />
      ) : selection?.kind === "edge" ? (
        <EdgeInspector from={selection.from} to={selection.to} {...props} />
      ) : (
        <div className="inspector-body">
          <p className="dim">Select a node or dependency on the canvas.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

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

function NodeInspector(props: InspectorProps & { node: NodeConfig }) {
  const { node, doc, editable, onEdit, onSelect, presets, validation } = props;
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

      {/* First, so a node's latest input and reply can be read while the
          settings below it are changed; capped in height (.node-trace). */}
      <Section id="trace" title="Trace" defaultOpen={false} summary={nodeTraceSummary(id, props.turns)}>
        <div className="node-trace">
          <NodeTrace nodeId={id} turns={props.turns} isOutput={isOutput} />
        </div>
      </Section>
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
