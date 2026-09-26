import { useEffect, useRef, useState } from "react";
import {
  applyPreset,
  disconnect,
  effectiveModel,
  modelIdentity,
  nodeIds,
  outputCandidates,
  removeBranch,
  removeLoop,
  removeNode,
  renameNode,
  routeTargets,
  setNodeField,
  setOutput,
  setPipelineField,
  upsertBranch,
  upsertLoop,
} from "@llm-pipeline/client";
import type {
  BranchConfig,
  BranchRoute,
  LoopConfig,
  ModelsResponse,
  NodeConfig,
  NodePreset,
  PipelineDefinition,
} from "@llm-pipeline/client";
import type { EditorDoc, Selection, ValidationState } from "./editorState";
import { CommitInput, Field, ModelPicker, NumberField, OllamaOptionsForm, useModelLimits } from "./fields";
import { PromptPreview } from "./PromptPreview";
import { parseList } from "../format";
import type { PreviewContext } from "./PromptPreview";
import { MessageEntry } from "../run/MessageEntry";
import type { Turn } from "../run/Chat";

// The server's built-in history defaults (pipeline_config/schema.py), shown
// as the starting text of the format fields.
const DEFAULT_TURN_TEMPLATE =
  "User: {{ prompt }}\n{% for node, text in outputs.items() %}{{ node }}: {{ text }}\n{% endfor %}Assistant: {{ answer }}";
const DEFAULT_SUMMARY_PROMPT =
  "Summarize this conversation briefly. Keep names, facts, decisions and open questions; drop small talk.\n\n{{ history }}";

/** `coalesce` names the field being edited, so continuous edits to it
 * (typing, dragging a slider) form one undo step. */
type Edit = (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string) => void;

export interface InspectorProps {
  doc: EditorDoc;
  selection: Selection | null;
  editable: boolean;
  models: ModelsResponse | null;
  presets: NodePreset[];
  /** This session's runs — the node Messages tab shows the selected node's part. */
  turns: Turn[];
  validation: ValidationState;
  onEdit: Edit;
  onSelect: (selection: Selection | null) => void;
  onRefreshModels: () => void;
  /** Opens the "save to library" dialog for a node. */
  onSaveToLibrary: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
  /** Nodes the latest run can be re-run from (empty while running). */
  rerunnable: Set<string>;
  onRerun: (nodeId: string) => void;
  /** The latest message and its outputs, for prompt previews. */
  previewContext: PreviewContext | null;
}

type NodeTab = "config" | "messages";

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

function PromptEditor(props: {
  label: string;
  hint: string;
  value: string;
  refs: string[];
  disabled: boolean;
  rows: number;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

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

  return (
    <Field label={props.label} hint={props.hint}>
      {props.refs.length > 0 && !props.disabled && (
        <div className="chips">
          {props.refs.map((r) => (
            <button type="button" key={r} className="chip" onClick={() => insert(r)}>
              {r}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="prompt"
        rows={props.rows}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  );
}

function NodeInspector(props: InspectorProps & { node: NodeConfig; tab: NodeTab; onTab: (tab: NodeTab) => void }) {
  const { node, doc, editable, onEdit, onSelect, presets, validation, tab, onTab } = props;
  const def = doc.definition;
  const id = node.id;
  const set = (path: string, value: unknown, coalesce = true) =>
    onEdit((d) => setNodeField(d, id, path, value), coalesce ? `node:${id}:${path}` : undefined);
  const limits = useModelLimits(node.model);
  const deps = node.depends_on ?? [];
  const isOutput = outputCandidates(def).includes(id);
  const [presetChoice, setPresetChoice] = useState("");

  const branch = (def.branches ?? []).find((b) => b.from === id);
  const loop = (def.loops ?? []).find((l) => l.from === id);
  const loopBackSources = (def.loops ?? []).filter((l) => l.back_to === id).map((l) => l.from);
  const refs = [
    "{{ input }}",
    "{{ question }}",
    "{{ history }}",
    ...[...deps, ...loopBackSources].map((d) => `{{ ${d}.output }}`),
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

  return (
    <div className="inspector-body">
      <header className="inspector-title">
        <span className="kicker">node</span>
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
                onClick={() => props.onSaveToLibrary(id)}
              >
                Save to library
              </button>
            )}
          </div>
        )}
      </header>
      {problem && <p className={validation.status === "invalid" ? "problem error" : "problem warn"}>{problem}</p>}

      <div className="tabs" role="tablist" aria-label="Node view">
        <button type="button" role="tab" aria-selected={tab === "config"} className={tab === "config" ? "tab active" : "tab"} onClick={() => onTab("config")}>
          Configuration
        </button>
        <button type="button" role="tab" aria-selected={tab === "messages"} className={tab === "messages" ? "tab active" : "tab"} onClick={() => onTab("messages")}>
          Messages
        </button>
      </div>

      {tab === "messages" ? (
        <NodeMessages nodeId={id} turns={props.turns} isOutput={isOutput} />
      ) : (
      <>
      <section>
        <Field label="Id" hint="renaming updates every reference to it">
          <CommitInput
            value={id}
            disabled={!editable}
            ariaLabel="Node id"
            onCommit={(next) => {
              if (!next) return;
              onEdit((d) => renameNode(d, id, next));
              onSelect({ kind: "node", id: next });
            }}
          />
        </Field>
        <Field label="Model">
          <ModelPicker
            model={node.model}
            models={props.models}
            limits={limits}
            {...(defaults.model ? { emptyOption: `pipeline default (${modelIdentity(defaults.model)})` } : {})}
            disabled={!editable}
            onRefresh={props.onRefreshModels}
            onChange={(identity) => set("model", identity || "default", false)}
          />
        </Field>
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
                onChange={(e) => set("temperature", Number(e.target.value))}
              />
              <NumberField
                value={node.model.temperature}
                placeholder={`${effective?.temperature ?? 0.2}`}
                disabled={!editable}
                ariaLabel="Temperature value"
                onChange={(v) => set("temperature", v)}
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
        <label className="check">
          <input
            type="checkbox"
            checked={node.include_history ?? true}
            disabled={!editable}
            onChange={(e) => set("include_history", e.target.checked ? undefined : false, false)}
          />
          sees the conversation history — off: {"{{ input }}"} is just the new message
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
        <label className="check">
          <input
            type="checkbox"
            checked={isOutput}
            disabled={!editable || (isOutput && outputCandidates(def).length === 1)}
            onChange={(e) => {
              const current = outputCandidates(def);
              onEdit((d) => setOutput(d, e.target.checked ? [...current, id] : current.filter((o) => o !== id)));
            }}
          />
          output node — its answer is the pipeline&apos;s answer
        </label>
      </section>

      <section>
        <PromptEditor
          label="System prompt"
          hint="sent as the model's system message; plain text"
          value={node.system_prompt ?? ""}
          {...(defaults.system_prompt ? { placeholder: `pipeline default: ${defaults.system_prompt}` } : {})}
          refs={[]}
          rows={3}
          disabled={!editable}
          onChange={(v) => set("system_prompt", v === "" ? undefined : v)}
        />
        <PromptEditor
          label="Prompt template"
          hint="{{ input }}: new message + history · {{ question }}: new message only · {{ history }}: earlier turns only · {{ node.output }} needs that node as a dependency"
          value={node.prompt_template}
          refs={refs}
          rows={7}
          disabled={!editable}
          onChange={(v) => set("prompt_template", v)}
        />
        {editable && <PromptPreview definition={def} nodeId={id} context={props.previewContext} />}
      </section>

      {node.model?.provider === "ollama" && (
        <section>
          {defaults.model?.provider === "ollama" && Object.keys(defaults.model.options ?? {}).length > 0 && (
            <p className="dim">Options left empty use the pipeline default&apos;s.</p>
          )}
          <OllamaOptionsForm
            options={node.model.options}
            maxContext={limits?.context_length}
            disabled={!editable}
            onChange={(key, value) => set(`options.${key}`, value)}
          />
        </section>
      )}

      <section>
        <h3>Depends on</h3>
        {deps.length === 0 ? (
          <p className="dim">nothing — starts as soon as the run does. Drag from another node&apos;s bottom handle to this node&apos;s top handle to add one.</p>
        ) : (
          <ul className="dep-list">
            {deps.map((dep) => (
              <li key={dep}>
                <button type="button" className="link" onClick={() => onSelect({ kind: "node", id: dep })}>
                  {dep}
                </button>
                {editable && (
                  <button type="button" className="ghost small" onClick={() => onEdit((d) => disconnect(d, dep, id))}>
                    remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Routing</h3>
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
      </section>

      <section>
        <h3>Library</h3>
        <p className="field-hint">
          Saved nodes keep a model, its options, prompts and history and reasoning settings. Add them from the sidebar,
          or give this node one&apos;s configuration (its id and connections stay).
        </p>
        {editable && presets.length > 0 && (
          <div className="row">
            <select value={presetChoice} onChange={(e) => setPresetChoice(e.target.value)} aria-label="Saved node">
              <option value="">use a saved node&apos;s configuration…</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.model.provider}:{p.model.model}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!presetChoice}
              onClick={() => {
                const preset = presets.find((p) => p.name === presetChoice);
                if (preset) onEdit((d) => applyPreset(d, id, preset));
                setPresetChoice("");
              }}
            >
              Apply
            </button>
          </div>
        )}
        {editable && (
          <button type="button" className="ghost" onClick={() => props.onSaveToLibrary(id)}>
            Save to library…
          </button>
        )}
        {!editable && <p className="dim">Editing is disabled on this server.</p>}
      </section>

      {editable && (
        <section className="row">
          <button type="button" className="ghost" onClick={() => props.onDuplicate(id)}>
            Duplicate <kbd>⌘D</kbd>
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onEdit((d) => removeNode(d, id));
              onSelect(null);
            }}
          >
            Delete node
          </button>
        </section>
      )}
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
        <b>{nodeId}</b> hasn&apos;t run in this session yet. Send a prompt below — what it receives and replies shows up
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
  onChange: (to: string | string[]) => void;
}) {
  const { route, index, candidates, editable, onChange } = props;
  const chosen = routeTargets(route);
  const commit = (next: string[]) => onChange(next.length === 1 ? next[0]! : next);
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
              onClick={() => commit(chosen.filter((t) => t !== target))}
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
  const save = (next: BranchConfig, field?: string) =>
    onEdit((d) => upsertBranch(d, next, branch.id), field ? `branch:${branch.id}:${field}` : undefined);

  return (
    <div className="routing-form">
      <p className="dim">
        After this node runs, the first route whose condition matches runs next; otherwise the default. Conditions read its{" "}
        <code>output</code> and the user's <code>question</code>. A route can start several nodes. Route targets must have no
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
            onChange={(to) => save({ ...branch, routes: branch.routes.map((r, j) => (j === i ? { ...r, to } : r)) })}
          />
          {editable && !route.default && (
            <button
              type="button"
              className="ghost small"
              onClick={() => save({ ...branch, routes: branch.routes.filter((_, j) => j !== i) })}
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
          <button type="button" className="ghost danger-text" onClick={() => onEdit((d) => removeBranch(d, branch.id))}>
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
        <button type="button" className="ghost danger-text" onClick={() => onEdit((d) => removeLoop(d, loop.id))}>
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
        <span className="kicker">dependency</span>
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
            onEdit((d) => disconnect(d, from, to));
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
  const outputs = outputCandidates(def);

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
        {def.nodes.map((n) => (
          <label className="check" key={n.id}>
            <input
              type="checkbox"
              checked={outputs.includes(n.id)}
              disabled={!editable || (outputs.includes(n.id) && outputs.length === 1)}
              onChange={(e) =>
                onEdit((d) => setOutput(d, e.target.checked ? [...outputs, n.id] : outputs.filter((o) => o !== n.id)))
              }
            />
            {n.id}
          </label>
        ))}
      </section>

      <section>
        <h3>Execution</h3>
        <div className="field-stack">
          <Field label="timeout (s)" hint="per model call">
            <NumberField value={exec.model_timeout_seconds} disabled={!editable} onChange={(v) => setExec("model_timeout_seconds", v)} />
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


/** Edits one pipeline-wide setting by path (see setPipelineField). */
function usePipelineSetter(onEdit: Edit) {
  return (path: string, value: unknown, coalesce = true) =>
    onEdit((d) => setPipelineField(d, path, value), coalesce ? `pipeline:${path}` : undefined);
}

/** How earlier conversation turns reach the nodes. */
function HistorySettings(props: InspectorProps) {
  const { doc, editable, onEdit, models } = props;
  const def = doc.definition;
  const history = def.history ?? {};
  const set = usePipelineSetter(onEdit);
  const remember = history.remember ?? [];
  const summaryLimits = useModelLimits(history.summarize?.model);
  const turns = def.execution?.max_history_turns;

  return (
    <section>
      <h3>Conversation history</h3>
      <p className="dim">
        Earlier turns reach nodes through <code>{"{{ input }}"}</code> (history + new message),{" "}
        <code>{"{{ history }}"}</code> and <code>{"{{ question }}"}</code>. Nodes can opt out in their settings.
      </p>
      <div className="field-stack">
        <Field label="turns kept" hint="most recent turns sent verbatim; 0 turns history off">
          <NumberField
            value={turns}
            placeholder="6"
            disabled={!editable}
            onChange={(v) => set("execution.max_history_turns", v)}
          />
        </Field>
        <Field label="character budget" hint="oldest turns go first (empty: no limit)">
          <NumberField
            value={history.max_chars}
            placeholder="no limit"
            disabled={!editable}
            onChange={(v) => set("history.max_chars", v)}
          />
        </Field>
      </div>
      <Field label="Intro line" hint="first line of the history inside {{ input }}">
        <input
          type="text"
          value={history.intro ?? "Conversation so far:"}
          disabled={!editable}
          onChange={(e) => set("history.intro", e.target.value)}
        />
      </Field>
      <Field
        label="Turn format"
        hint="how each earlier turn is written — {{ prompt }}, {{ answer }}, and remembered outputs as {{ outputs.<node> }}"
      >
        <textarea
          className="prompt"
          rows={3}
          spellCheck={false}
          value={history.turn_template ?? DEFAULT_TURN_TEMPLATE}
          disabled={!editable}
          onChange={(e) => set("history.turn_template", e.target.value)}
        />
      </Field>
      {editable && history.turn_template !== undefined && history.turn_template !== DEFAULT_TURN_TEMPLATE && (
        <button type="button" className="ghost small" onClick={() => set("history.turn_template", undefined, false)}>
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
                    "history.remember",
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
          onChange={(identity) => set("history.summarize.model", identity || "unset", false)}
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
            onChange={(e) => set("history.summarize.prompt", e.target.value)}
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
          onChange={(identity) => set("defaults.model", identity || "unset", false)}
        />
      </Field>
      {defaults.model && (
        <Field label="Temperature" hint="for nodes that don't set one">
          <NumberField
            value={defaults.model.temperature}
            placeholder="0.2"
            disabled={!editable}
            onChange={(v) => set("defaults.temperature", v)}
          />
        </Field>
      )}
      <Field label="System prompt" hint="for nodes without their own">
        <textarea
          className="prompt"
          rows={3}
          value={defaults.system_prompt ?? ""}
          disabled={!editable}
          onChange={(e) => set("defaults.system_prompt", e.target.value || undefined)}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={defaults.strip_reasoning ?? false}
          disabled={!editable}
          onChange={(e) => set("defaults.strip_reasoning", e.target.checked || undefined, false)}
        />
        strip &lt;think&gt; reasoning from outputs (qwen3, deepseek-r1 …)
      </label>
      {defaults.model?.provider === "ollama" && (
        <OllamaOptionsForm
          options={defaults.model.options}
          maxContext={limits?.context_length}
          disabled={!editable}
          onChange={(key, value) => set(`defaults.options.${key}`, value)}
        />
      )}
    </section>
  );
}
