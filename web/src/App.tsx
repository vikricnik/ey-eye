import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DraftError,
  PRESET_NAME_PATTERN,
  PipelineApiError,
  ServerUnreachableError,
  RequestCancelledError,
  addNode,
  appendRunLog,
  applyStreamError,
  applyStreamEvent,
  applyStreamStopped,
  connect,
  createGraphViewState,
  disconnect,
  duplicateNode,
  endRunLog,
  liveTextOf,
  moveNode,
  newDefinition,
  testCases,
  presetFromNode,
  removeNode,
} from "@llm-pipeline/client";
import type {
  ConversationTurn,
  GraphViewState,
  ServerInfoResponse,
  ModelsResponse,
  NodeModelConfig,
  NodeOutput,
  NodePreset,
  PipelineDefinition,
  PipelineSummary,
  RunLogEntry,
  VariantRequest,
} from "@llm-pipeline/client";
import { BASE_URL, client } from "./config";
import { Inspector } from "./editor/Inspector";
import { PipelineCanvas } from "./editor/PipelineCanvas";
import { Sidebar } from "./editor/Sidebar";
import { LEVEL_SPACING, SIBLING_SPACING, autoLayout, definitionToFlow, graphOf } from "./editor/conversion";
import { docReducer } from "./editor/editorState";
import type { DocAction, EditorDoc, Selection, ValidationState } from "./editor/editorState";
import { useDialogs } from "./ui/Dialogs";
import { DisplayMenu, useDisplaySettings } from "./ui/DisplaySettings";
import { OutageNotice, ServerStatus } from "./ui/ServerStatus";
import { outageMessage, runBlockedReason, runOutage } from "./providerStatus";
import { Splitter, usePanelSizes } from "./ui/Splitter";
import { errorText } from "./format";
import type { PreviewContext } from "./editor/PromptPreview";
import { MessagesView } from "./run/MessagesView";
import { TestsView, resultKey } from "./tests/TestsView";
import type { TestRunState } from "./tests/TestsView";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  newConversationId,
  saveConversation,
} from "./run/runHistory";
import type { ConversationSummary } from "./run/runHistory";
import { Chat, Composer } from "./run/Chat";
import type { ComposerHandle, Turn } from "./run/Chat";
import { SidePanel } from "./ui/SidePanel";
import type { PanelTab } from "./ui/SidePanel";

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

interface Notice {
  kind: "info" | "error";
  text: string;
  action?: { label: string; run: () => void };
}


function toApiError(err: unknown): PipelineApiError {
  return err instanceof PipelineApiError ? err : new PipelineApiError(errorText(err));
}

/** Each node's latest output in a run (a loop's last iteration wins). */
function outputsOf(turn: Turn): Record<string, string> {
  return Object.fromEntries(turn.nodeOutputs.map((node) => [node.node_id, node.output]));
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const [serverInfo, setServerInfo] = useState<ServerInfoResponse | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [doc, setDoc] = useState<EditorDoc | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [presets, setPresets] = useState<NodePreset[]>([]);
  const [viewState, setViewState] = useState<GraphViewState | undefined>();
  const [lastOutputs, setLastOutputs] = useState<Record<string, NodeOutput>>({});
  // Which tab of the side panel is showing (see ui/SidePanel.tsx).
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");
  const [testRun, setTestRun] = useState<TestRunState | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  // Stops the run / test run in progress (Stop buttons, Esc).
  const stopRun = useRef<AbortController | null>(null);
  const stopTests = useRef<AbortController | null>(null);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  // The conversation these turns belong to (saved in this browser after
  // every run), and the pipeline's other saved conversations.
  const conversationId = useRef(newConversationId());
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [saveTick, setSaveTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const history = useRef<ConversationTurn[]>([]);
  const turnSeq = useRef(0);
  const validationSeq = useRef(0);
  const importInput = useRef<HTMLInputElement>(null);
  const composer = useRef<ComposerHandle>(null);

  const dialogs = useDialogs();
  const panels = usePanelSizes();
  const display = useDisplaySettings();

  // Every document change goes through docReducer applied to this ref first
  // (then published to state), so several edits fired in one event — e.g.
  // deleting a node and its edges — compose instead of overwriting each
  // other, and handlers always see the latest document.
  const docRef = useRef<EditorDoc | null>(doc);
  docRef.current = doc;
  const applyDoc = useCallback((action: DocAction) => {
    const next = docReducer(docRef.current, action);
    if (next === docRef.current) return;
    docRef.current = next;
    setDoc(next);
  }, []);

  const editable = serverInfo?.editing_enabled === true && online !== false;

  const notify = useCallback((kind: Notice["kind"], text: string, action?: Notice["action"]) => {
    setNotice(action ? { kind, text, action } : { kind, text });
  }, []);

  useEffect(() => {
    if (notice?.kind !== "info") return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // ---------- loading ----------

  const refreshPipelines = useCallback(async () => {
    try {
      setPipelines((await client.listPipelines()).pipelines);
    } catch {
      /* the status indicator already shows the server as offline */
    }
  }, []);

  const refreshModels = useCallback(async (refresh = false) => {
    try {
      setModels(await client.listModels({ refresh }));
    } catch (err) {
      notify("error", `couldn't load models: ${errorText(err)}`);
    }
  }, [notify]);

  const refreshPresets = useCallback(async () => {
    try {
      setPresets((await client.listPresets()).presets);
    } catch {
      /* optional feature — the sidebar just shows none */
    }
  }, []);

  /** Starts a new, empty conversation; the current one stays saved. */
  const resetRunState = useCallback(() => {
    setViewState(undefined);
    setLastOutputs({});

    setTurns([]);
    history.current = [];
    conversationId.current = newConversationId();
  }, []);

  const refreshConversations = useCallback(async (pipeline: string) => {
    setConversations(await listConversations(pipeline));
  }, []);

  /** Continues a saved conversation: its runs, and its context for the next message. */
  const openConversation = useCallback(async (id: string) => {
    const conversation = await loadConversation(id);
    if (!conversation) return;
    conversationId.current = conversation.id;
    history.current = conversation.history;
    turnSeq.current = Math.max(turnSeq.current, ...conversation.turns.map((t) => t.id));
    setTurns(conversation.turns);
    setViewState(undefined);
    const last = conversation.turns.at(-1);
    setLastOutputs(last ? Object.fromEntries(last.nodeOutputs.map((node) => [node.node_id, node])) : {});
  }, []);

  // Saves the conversation after every run (see run()'s finally).
  useEffect(() => {
    if (saveTick === 0) return;
    const finished = turnsRef.current.filter((t) => t.status !== "running");
    const first = finished[0];
    if (!first) return;
    void saveConversation({
      id: conversationId.current,
      pipeline: first.pipeline,
      title: first.prompt,
      updatedAt: Date.now(),
      turns: finished,
      history: history.current,
    }).then(() => refreshConversations(first.pipeline));
  }, [saveTick, refreshConversations]);

  const loadDoc = (definition: PipelineDefinition, baseRevision: string | null, saved: boolean) => {
    applyDoc({ type: "load", definition, baseRevision, saved });
    setSelection(null);
    setValidation({ status: "idle" });
    setCanvasKey((k) => k + 1);
    resetRunState();
    setTestRun(null); // results belong to the pipeline they ran
    void refreshConversations(definition.name);
  };

  const confirmDiscard = async (): Promise<boolean> => {
    const current = docRef.current;
    if (!current?.dirty) return true;
    return dialogs.confirm({
      title: `Discard unsaved changes to "${current.definition.name}"?`,
      body: "Your edits since the last save will be lost.",
      confirmLabel: "Discard",
      danger: true,
    });
  };

  const openPipeline = useCallback(async (name: string) => {
    try {
      const loaded = await client.getPipeline(name);
      loadDoc(loaded.definition, loaded.revision, true);
      setLoadError(null);
      // Pick up where the last conversation with this pipeline left off.
      const [latest] = await listConversations(name);
      if (latest) await openConversation(latest.id);
    } catch (err) {
      setLoadError(`couldn't load "${name}": ${errorText(err)}`);
    }
  }, [openConversation]);

  useEffect(() => {
    void (async () => {
      try {
        const info = await client.getServerInfo();
        setServerInfo(info);
        setOnline(true);
        const { pipelines: list } = await client.listPipelines();
        setPipelines(list);
        const first = list.some((p) => p.name === info.default_pipeline_name) ? info.default_pipeline_name : list[0]?.name;
        if (first) await openPipeline(first);
      } catch (err) {
        // Only a server we can't reach is offline — a refused API key isn't.
        const unreachable = err instanceof ServerUnreachableError;
        setOnline(!unreachable);
        setLoadError(
          unreachable ? `can't reach the pipeline server at ${BASE_URL}` : `couldn't load the pipelines: ${errorText(err)}`
        );
      }
      void refreshModels();
      void refreshPresets();
    })();
  }, [openPipeline, refreshModels, refreshPresets]);

  // Self-scheduling server poll (never overlapping, unlike setInterval): is
  // it reachable, does it still allow editing, and can it reach Ollama?
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        setServerInfo(await client.getServerInfo());
        setOnline(true);
        // The server re-checks Ollama on every call while it's down, so this
        // notices it going away or coming back — and newly installed models.
        const next = await client.listModels();
        setModels((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } catch (err) {
        setOnline(!(err instanceof ServerUnreachableError));
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 15000);
    };
    timer = window.setTimeout(() => void tick(), 15000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (docRef.current?.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---------- editing ----------

  /** Applies one draft edit. `coalesce` groups rapid edits of the same
   * field (typing a prompt) into a single undo step. */
  const edit = useCallback(
    (op: (d: PipelineDefinition) => PipelineDefinition, coalesce?: string) => {
      const current = docRef.current;
      if (!current) return;
      try {
        applyDoc({ type: "edit", definition: op(current.definition), coalesce, at: Date.now() });
      } catch (err) {
        if (err instanceof DraftError) notify("error", err.message);
        else throw err;
      }
    },
    [applyDoc, notify]
  );

  const undo = useCallback(() => applyDoc({ type: "undo" }), [applyDoc]);
  const redo = useCallback(() => applyDoc({ type: "redo" }), [applyDoc]);

  // Live validation: the server is the only validator. Debounced so
  // typing in a prompt doesn't send a request per keystroke.
  useEffect(() => {
    if (!doc?.dirty) return;
    const seq = ++validationSeq.current;
    const definition = doc.definition;
    const timer = window.setTimeout(async () => {
      setValidation({ status: "checking" });
      try {
        const result = await client.validatePipeline({ format: "json", definition });
        if (seq !== validationSeq.current) return;
        setValidation({
          status: "valid",
          modelIssues: result.model_issues.map((i) => ({ nodeId: i.node_id, message: i.message })),
          warnings: (result.warnings ?? []).map((i) => ({ nodeId: i.node_id, message: i.message })),
        });
      } catch (err) {
        if (seq !== validationSeq.current) return;
        if (err instanceof PipelineApiError && err.code === "DEFINITION_INVALID") {
          const nodeId = typeof err.details?.node_id === "string" ? err.details.node_id : null;
          setValidation({ status: "invalid", message: errorText(err), nodeId });
        } else {
          setValidation({ status: "unavailable", message: errorText(err) });
        }
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [doc?.definition, doc?.dirty]);

  /** For a new pipeline: the model the open pipeline already uses (a
   * known-good choice), else the first model the server lists. */
  const defaultModel = (): NodeModelConfig => {
    const inUse = docRef.current?.definition.nodes.find((n) => n.model)?.model;
    if (inUse) return { provider: inUse.provider, name: inUse.name, temperature: inUse.temperature ?? 0.2 };
    const first = models?.providers.find((p) => p.provider === "ollama" && p.models.length > 0)?.models[0];
    return { provider: "ollama", name: first?.name ?? "llama3", temperature: 0.2 };
  };

  /** Where each node is drawn (its saved layout, else the auto layout),
   * and the first free spot in a row starting at (x, y) — so new nodes
   * land beside their siblings instead of on top of them. */
  const placement = (definition: PipelineDefinition) => {
    const auto = autoLayout(graphOf(definition));
    const at = (id: string) => definition.nodes.find((n) => n.id === id)?.layout ?? auto[id] ?? { x: 0, y: 0 };
    const occupied = (x: number, y: number) =>
      definition.nodes.some((n) => {
        const q = at(n.id);
        return Math.abs(q.x - x) < SIBLING_SPACING - 20 && Math.abs(q.y - y) < LEVEL_SPACING - 40;
      });
    const freeSpot = (x: number, y: number) => {
      while (occupied(x, y)) x += SIBLING_SPACING;
      return { x, y };
    };
    return { at, freeSpot };
  };

  const addNodeAt = (position: { x: number; y: number } | undefined, presetName: string | undefined) => {
    const current = docRef.current;
    if (!current) return;
    const preset = presets.find((p) => p.name === presetName);
    const selectedId = selection?.kind === "node" ? selection.id : undefined;
    let layout = position;
    if (!layout) {
      // Click-to-add: place it below the selected node, or below everything.
      const { at, freeSpot } = placement(current.definition);
      layout = selectedId
        ? freeSpot(at(selectedId).x, at(selectedId).y + LEVEL_SPACING)
        : freeSpot(0, Math.max(0, ...current.definition.nodes.map((n) => at(n.id).y)) + LEVEL_SPACING);
    }
    let newId: string | undefined;
    edit((d) => {
      // Without a preset, addNode reuses the pipeline's own model.
      const result = addNode(d, {
        layout,
        ...(preset ? { preset } : {}),
        ...(!position && selectedId ? { after: [selectedId] } : {}),
      });
      newId = result.id;
      return result.definition;
    });
    if (newId) setSelection({ kind: "node", id: newId });
  };

  /** Copies a node beside the original — same settings and inputs. */
  const duplicate = (id: string) => {
    const current = docRef.current;
    if (!current || !current.definition.nodes.some((n) => n.id === id)) return;
    const { at, freeSpot } = placement(current.definition);
    let newId: string | undefined;
    edit((d) => {
      const result = duplicateNode(d, id, { layout: freeSpot(at(id).x + SIBLING_SPACING, at(id).y) });
      newId = result.id;
      return result.definition;
    });
    if (newId) {
      setSelection({ kind: "node", id: newId });
      notify("info", `duplicated "${id}" as "${newId}"`);
    }
  };

  /** Asks for a name and description, then saves the node — everything it
   * runs with — as a preset. */
  const saveNodeAsPreset = async (id: string) => {
    const current = docRef.current;
    if (!current) return;
    const values = await dialogs.form({
      title: `Save "${id}" as a preset`,
      body: (
        <>
          Saves its model, options, prompts and history and reasoning settings, so you can add it to any pipeline
          from the sidebar.
        </>
      ),
      confirmLabel: "Save",
      fields: [
        {
          name: "name",
          label: "Name",
          initial: id,
          validate: (v) => (PRESET_NAME_PATTERN.test(v) ? null : "letters, digits, - and _ only"),
          hint: "a preset with the same name is replaced (you'll be asked)",
        },
        {
          name: "description",
          label: "Description",
          optional: true,
          placeholder: "what it's for — shown in the sidebar",
          initial: presets.find((p) => p.name === id)?.description ?? "",
        },
      ],
    });
    if (!values) return;
    try {
      await savePreset(
        presetFromNode(current.definition, id, values.name!, { description: values.description ?? "" })
      );
    } catch (err) {
      notify("error", `preset not saved: ${errorText(err)}`);
    }
  };

  /** Saves a preset, asking first before replacing one of the same name. */
  const savePreset = async (preset: NodePreset): Promise<boolean> => {
    if (presets.some((p) => p.name === preset.name)) {
      const replace = await dialogs.confirm({
        title: `Replace the preset "${preset.name}"?`,
        body: <>Pipelines that already use it keep their copy — only new additions get the new settings.</>,
        confirmLabel: "Replace",
      });
      if (!replace) return false;
    }
    try {
      await client.savePreset(preset);
      await refreshPresets();
      notify("info", `saved the preset "${preset.name}"`);
      return true;
    } catch (err) {
      notify("error", `preset not saved: ${errorText(err)}`);
      return false;
    }
  };

  // ---------- save / new / import / export ----------

  const save = async (asName?: string): Promise<boolean> => {
    const current = docRef.current;
    if (!current) return false;
    let definition = current.definition;
    let base = current.baseRevision;
    if (asName !== undefined) {
      definition = { ...definition, name: asName };
      base = null;
    }
    try {
      const saved =
        base === null
          ? await client.createPipeline(definition)
          : await client.updatePipeline(definition, { baseRevision: base });
      applyDoc({ type: "saved", definition: saved.definition, revision: saved.revision });
      notify(
        "info",
        saved.comments_preserved === false
          ? `saved "${saved.definition.name}" — its comments couldn't be kept (rewritten in canonical form)`
          : `saved "${saved.definition.name}" — new runs use it`
      );
      void refreshPipelines();
      return true;
    } catch (err) {
      const stale = err instanceof PipelineApiError && err.code === "REVISION_CONFLICT";
      notify(
        "error",
        `not saved: ${errorText(err)}`,
        stale ? { label: "reload latest", run: () => void openPipeline(definition.name) } : undefined
      );
      return false;
    }
  };

  /** Inline validation for a new pipeline name. */
  const validateNewName = (name: string): string | null => {
    if (!NAME_PATTERN.test(name)) return "use only letters, digits, - and _";
    if (pipelines.some((p) => p.name === name)) return `"${name}" already exists`;
    return null;
  };

  const saveAs = async () => {
    const name = await dialogs.prompt({
      title: "Save as a new pipeline",
      label: "Name (the file becomes pipelines/<name>.yaml)",
      initial: `${docRef.current?.definition.name ?? "pipeline"}-copy`,
      confirmLabel: "Save",
      validate: validateNewName,
    });
    if (name) await save(name);
  };

  const newPipeline = async () => {
    if (!(await confirmDiscard())) return;
    const answer = await dialogs.form({
      title: "New pipeline",
      confirmLabel: "Create",
      fields: [
        {
          name: "name",
          label: "Name (the file becomes pipelines/<name>.yaml)",
          initial: "my-pipeline",
          validate: validateNewName,
        },
        ...(presets.length > 0
          ? [
              {
                name: "start",
                label: "Start with",
                options: [
                  { value: "", label: "a blank LLM node" },
                  ...presets.map((p) => ({ value: p.name, label: `${p.name} — ${p.model.name} (preset)` })),
                ],
                hint: "add more from the presets in the sidebar",
              },
            ]
          : []),
      ],
    });
    if (!answer) return;
    const preset = presets.find((p) => p.name === answer.start);
    const definition = newDefinition(answer.name!, defaultModel(), preset);
    loadDoc(definition, null, false);
    setSelection({ kind: "node", id: definition.nodes[0]!.id });
  };

  const deletePipeline = async () => {
    const current = docRef.current;
    if (!current) return;
    const name = current.definition.name;
    const fallback = serverInfo?.default_pipeline_name ?? pipelines[0]?.name;
    if (current.baseRevision === null) {
      // Never saved: "delete" just discards the draft.
      if (await confirmDiscard()) {
        if (fallback) void openPipeline(fallback);
      }
      return;
    }
    const ok = await dialogs.confirm({
      title: `Delete "${name}"?`,
      body: (
        <>
          The file moves to <code>pipelines/.deleted/</code> on the server, so it can be recovered by moving it
          back.{current.dirty ? " Your unsaved changes are discarded." : ""}
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const deleted = await client.deletePipeline(name, current.baseRevision);
      notify("info", `deleted "${name}" — recoverable as pipelines/${deleted.recoverable_as}`);
      await refreshPipelines();
      if (fallback && fallback !== name) void openPipeline(fallback);
    } catch (err) {
      notify("error", `not deleted: ${errorText(err)}`);
    }
  };

  const deletePreset = async (name: string) => {
    const ok = await dialogs.confirm({
      title: `Remove the preset "${name}"?`,
      body: (
        <>
          Pipelines that use it keep their copy. The file moves to <code>presets/.deleted/</code> on the server.
        </>
      ),
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await client.deletePreset(name);
      await refreshPresets();
      notify("info", `removed the preset "${name}"`);
    } catch (err) {
      notify("error", `not removed: ${errorText(err)}`);
    }
  };

  const importFile = async (file: File) => {
    if (!(await confirmDiscard())) return;
    try {
      const { definition } = await client.validatePipeline({ format: "yaml", text: await file.text() });
      let baseRevision: string | null = null;
      if (pipelines.some((p) => p.name === definition.name)) {
        const replace = await dialogs.confirm({
          title: `"${definition.name}" already exists`,
          body: "Import it as a replacement? Nothing changes on the server until you click Save.",
          confirmLabel: "Import",
        });
        if (!replace) return;
        baseRevision = (await client.getPipeline(definition.name)).revision;
      }
      loadDoc(definition, baseRevision, false);
      notify("info", `imported "${definition.name}" — not saved yet`);
    } catch (err) {
      notify("error", `import failed: ${errorText(err)}`);
    }
  };

  const exportYaml = async () => {
    const current = docRef.current;
    if (!current) return;
    try {
      const { yaml } = await client.validatePipeline({ format: "json", definition: current.definition });
      download(`${current.definition.name}.yaml`, yaml);
    } catch (err) {
      notify("error", `export failed — the pipeline must be valid: ${errorText(err)}`);
    }
  };

  const onKeyDown = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyDown.current = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector("dialog[open]") && (stopRun.current || stopTests.current)) {
      e.preventDefault();
      stopRun.current?.abort();
      stopTests.current?.abort();
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      if (editable && docRef.current?.dirty) void save();
      return;
    }
    // Inside a text field the browser's own undo applies to that field.
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (!editable) return;
    if (key === "d" && selection?.kind === "node") {
      e.preventDefault(); // not the browser's bookmark shortcut
      duplicate(selection.id);
      return;
    }
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyDown.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---------- running ----------

  /**
   * Sends a message — or, with `rerunFrom`, runs the latest message again
   * from that node: it and every node after it call their models, the rest
   * reuse their outputs from the latest run. The re-run's answer replaces
   * the latest one in the conversation.
   */
  const run = async (message: string, rerunFrom?: string) => {
    const previous = rerunFrom ? turnsRef.current.at(-1) : undefined;
    if (rerunFrom && (!previous || previous.status === "running")) return;
    if (docRef.current?.dirty && !(await save())) return;
    const current = docRef.current;
    if (!current) return;
    const name = current.definition.name;
    const prompt = previous ? previous.prompt : message;
    // The conversation this message is sent with (a re-run: the same as before).
    const before = previous ? previous.history : history.current.slice();
    const rerun = previous && rerunFrom ? { from_node: rerunFrom, outputs: outputsOf(previous) } : undefined;

    let state = createGraphViewState(graphOf(current.definition));
    setViewState(state);
    setLastOutputs({});
    const turnId = ++turnSeq.current;
    const updateTurn = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === turnId ? fn(t) : t)));
    setTurns((ts) => [
      ...ts,
      {
        id: turnId,
        pipeline: name,
        prompt,
        history: before,
        status: "running",
        nodeOutputs: [],
        log: [],
        ...(rerunFrom ? { rerunFrom } : {}),
      },
    ]);
    // What every node received and replied (see appendRunLog). Tokens build
    // up in this local and reach state at most every ~100ms, so a fast model
    // doesn't re-render the whole editor once per token.
    let log: RunLogEntry[] = [];
    let flushTimer: number | undefined;
    const flushLog = (now: boolean) => {
      const publish = () => {
        const snapshot = log;
        updateTurn((t) => ({ ...t, log: snapshot }));
      };
      if (now) {
        window.clearTimeout(flushTimer);
        flushTimer = undefined;
        publish();
      } else if (flushTimer === undefined) {
        flushTimer = window.setTimeout(() => {
          flushTimer = undefined;
          publish();
        }, 100);
      }
    };
    setRunning(true);
    const startedAt = performance.now();
    const stop = new AbortController();
    stopRun.current = stop;

    try {
      const input = { pipeline: name, prompt, history: before, ...(rerun ? { rerun } : {}) };
      for await (const event of client.askStream(input, { signal: stop.signal })) {
        log = appendRunLog(log, event);
        if (event.type === "node_token") {
          flushLog(false);
          continue; // text only — node status is unchanged
        }
        flushLog(true);
        state = applyStreamEvent(state, event);
        setViewState(state);
        if (event.type === "node_complete") {
          const node = event.data.node;
          setLastOutputs((o) => ({ ...o, [node.node_id]: node }));
          updateTurn((t) => ({ ...t, nodeOutputs: [...t.nodeOutputs, node] }));
        } else if (event.type === "done") {
          const result = event.data;
          updateTurn((t) => ({ ...t, status: "done", result, elapsedMs: performance.now() - startedAt }));
          // Remembered node outputs travel with the turn (history.remember).
          // A re-run's answer takes the place of the one it re-ran.
          history.current = [...before, { prompt, final_answer: result.final_answer, outputs: result.remembered ?? {} }];
        }
      }
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        // The server stops the model calls; finished nodes keep their output.
        setViewState(applyStreamStopped(state));
        log = endRunLog(log);
        updateTurn((t) => ({ ...t, status: "stopped", elapsedMs: performance.now() - startedAt }));
        return;
      }
      const apiErr = toApiError(err);
      state = applyStreamError(state, apiErr);
      setViewState(state);
      const failedNode = typeof apiErr.details?.node_id === "string" ? apiErr.details.node_id : undefined;
      log = endRunLog(log, failedNode);
      updateTurn((t) => ({
        ...t,
        status: "error",
        error: { message: errorText(err), requestId: apiErr.requestId, code: apiErr.code },
      }));
    } finally {
      flushLog(true);
      if (stopRun.current === stop) stopRun.current = null;
      setRunning(false);
      setSaveTick((t) => t + 1);
    }
  };

  /** Runs the draft's test cases (all, or some), and each variant's — no
   * save needed. Results fill in case by case. */
  const runTests = async (request: { cases?: string[]; variants: VariantRequest[] }) => {
    const current = docRef.current;
    if (!current) return;
    const definition = current.definition;
    const cases = request.cases ?? testCases(definition).map((c) => c.name);
    setTestRun({ status: "running", cases, variants: ["current", ...request.variants.map((v) => v.label)], results: {} });
    const stop = new AbortController();
    stopTests.current = stop;
    try {
      for await (const event of client.runTests(
        { definition, ...(request.cases ? { cases: request.cases } : {}), variants: request.variants },
        { signal: stop.signal }
      )) {
        if (event.type === "case_start") {
          setTestRun((r) => r && { ...r, current: event.data });
        } else if (event.type === "case_result") {
          const result = event.data;
          setTestRun((r) => r && { ...r, results: { ...r.results, [resultKey(result.case, result.variant)]: result } });
        } else {
          const { summaries } = event.data;
          setTestRun((r) => r && { ...r, status: "done", current: undefined, summaries });
        }
      }
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        setTestRun((r) => r && { ...r, status: "stopped", current: undefined });
      } else {
        setTestRun((r) => r && { ...r, status: "error", current: undefined, error: errorText(err) });
      }
    } finally {
      if (stopTests.current === stop) stopTests.current = null;
    }
  };

  const removeConversation = async (id: string) => {
    const ok = await dialogs.confirm({
      title: "Delete this conversation?",
      body: "Its runs and message logs are removed from this browser.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await deleteConversation(id);
    if (id === conversationId.current) resetRunState();
    if (docRef.current) await refreshConversations(docRef.current.definition.name);
  };

  // ---------- derived ----------

  // Selecting a node or edge — on the canvas, from Messages, by adding one —
  // shows its settings.
  const selectionKey =
    selection?.kind === "node" ? `node:${selection.id}` : selection?.kind === "edge" ? `edge:${selection.from}->${selection.to}` : "";
  useEffect(() => {
    if (selectionKey) setPanelTab("settings");
  }, [selectionKey]);

  const lastTurn = turns.at(-1);
  // What a re-run of the latest message starts from — and what previews show.
  const previewContext = useMemo<PreviewContext | null>(
    () =>
      lastTurn && lastTurn.status !== "running"
        ? { prompt: lastTurn.prompt, history: lastTurn.history, outputs: outputsOf(lastTurn) }
        : null,
    [lastTurn]
  );
  // Nodes that ran (or failed) in the latest run can be re-run from.
  const rerunnable = useMemo(
    () =>
      new Set(
        lastTurn && lastTurn.status !== "running" && !running ? lastTurn.log.map((entry) => entry.nodeId) : []
      ),
    [lastTurn, running]
  );

  // Retry sends the latest run again as it was: its message, or a re-run
  // from the same node — while that node can still be re-run from (it
  // needs the outputs of the nodes before it from that run).
  const retryable =
    lastTurn &&
    (lastTurn.status === "error" || lastTurn.status === "stopped") &&
    (!lastTurn.rerunFrom || rerunnable.has(lastTurn.rerunFrom))
      ? lastTurn
      : undefined;
  const retry = retryable
    ? () => void (retryable.rerunFrom ? run("", retryable.rerunFrom) : run(retryable.prompt))
    : undefined;

  const graph = useMemo(() => (doc ? graphOf(doc.definition) : null), [doc]);
  // Text the running nodes' models are writing right now, from the current run's log.
  const currentLog = running ? turns.at(-1)?.log : undefined;
  const liveText = useMemo(() => (currentLog ? liveTextOf(currentLog) : {}), [currentLog]);
  const outputIds = useMemo(() => new Set(doc?.definition.output_nodes ?? []), [doc]);
  const flow = useMemo(
    () =>
      doc && graph
        ? definitionToFlow({
            definition: doc.definition,
            graph,
            status: viewState?.nodeStatus ?? {},
            outputs: lastOutputs,
            liveText,
            validation,
            editable,
          })
        : { nodes: [], edges: [] },
    [doc, graph, viewState, lastOutputs, liveText, validation, editable]
  );

  // While a run is in flight, the output node's text streams into the
  // transcript as it's written (the first candidate with any text yet).
  const pendingAnswer = running && doc
    ? doc.definition.output_nodes.map((id) => liveText[id]).find((t) => t)
    : undefined;

  // A model provider the open pipeline needs is down (Ollama, in practice).
  const outage = useMemo(() => (doc ? runOutage(doc.definition, models) : null), [doc, models]);
  const ollama = models?.providers.find((p) => p.provider === "ollama");
  const blockedByOutage = runBlockedReason(outage);

  const isNew = doc?.baseRevision === null;
  let runDisabled: string | null = null;
  if (!doc) runDisabled = "no pipeline loaded";
  else if (online === false) runDisabled = "server offline";
  else if (blockedByOutage) runDisabled = blockedByOutage;
  else if (doc.dirty && !editable) runDisabled = "editing is disabled — can't save changes to run them";
  else if (doc.dirty && validation.status === "invalid") runDisabled = "fix the validation error to run";

  const validationChip = (() => {
    if (!doc?.dirty) return doc ? <span className="chip-status ok">saved</span> : null;
    switch (validation.status) {
      case "checking":
        return <span className="chip-status">checking…</span>;
      case "valid": {
        const issues = [...validation.modelIssues, ...validation.warnings];
        return issues.length > 0 ? (
          <span className="chip-status warn" title={issues.map((i) => i.message).join("\n")}>
            valid · {issues.length} warning{issues.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="chip-status ok">valid · unsaved</span>
        );
      }
      case "invalid":
        return (
          <button
            type="button"
            className="chip-status error"
            title={validation.message}
            onClick={() => setSelection(validation.nodeId ? { kind: "node", id: validation.nodeId } : null)}
          >
            invalid{validation.nodeId ? ` · ${validation.nodeId}` : ""}
          </button>
        );
      case "unavailable":
        return <span className="chip-status warn" title={validation.message}>can&apos;t validate</span>;
      default:
        return <span className="chip-status">unsaved</span>;
    }
  })();

  return (
    <div className="app" style={panels.style}>
      <header className="topbar">
        <div className="title-block">
          <h1>LLM Pipeline</h1>
          <span className="subtitle">{BASE_URL}</span>
          <ServerStatus
            baseUrl={BASE_URL}
            online={online}
            ollama={ollama}
            readOnly={serverInfo !== null && !serverInfo.editing_enabled}
          />
        </div>
        <div className="toolbar">
          <select
            className="pipeline-select"
            aria-label="Pipeline"
            value={doc?.definition.name ?? ""}
            onChange={(e) => {
              const name = e.target.value;
              void confirmDiscard().then((ok) => {
                if (ok) void openPipeline(name);
              });
            }}
          >
            {isNew && doc && <option value={doc.definition.name}>{doc.definition.name} (new)</option>}
            {!doc && <option value="">{online === false ? "server unreachable" : "loading…"}</option>}
            {pipelines.map((p) => (
              <option key={p.name} value={p.name} title={p.description}>
                {p.name}
              </option>
            ))}
          </select>
          {doc?.dirty && <span className="dirty-dot" title="unsaved changes">●</span>}
          {validationChip}
          <span className="sep" />
          <button type="button" className="ghost icon" onClick={undo} disabled={!editable || !doc?.past.length} title="Undo (⌘Z / Ctrl+Z)" aria-label="Undo">
            ↶
          </button>
          <button type="button" className="ghost icon" onClick={redo} disabled={!editable || !doc?.future.length} title="Redo (⇧⌘Z / Ctrl+Y)" aria-label="Redo">
            ↷
          </button>
          <button type="button" className="ghost" onClick={() => void newPipeline()} disabled={!editable}>
            New
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editable || !doc?.dirty || validation.status === "invalid"}
            title="Save (⌘S / Ctrl+S)"
          >
            Save
          </button>
          <button type="button" className="ghost" onClick={() => void saveAs()} disabled={!editable || !doc}>
            Save as
          </button>
          <button type="button" className="ghost" onClick={() => importInput.current?.click()} disabled={!editable}>
            Import
          </button>
          <button type="button" className="ghost" onClick={() => void exportYaml()} disabled={!doc}>
            Export
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!editable || !doc}
            onClick={() => {
              if (!graph) return;
              const positions = autoLayout(graph);
              edit((d) => d.nodes.reduce((acc, n) => moveNode(acc, n.id, positions[n.id]!.x, positions[n.id]!.y), d));
              setFitSignal((s) => s + 1);
            }}
          >
            Auto-layout
          </button>
          <button
            type="button"
            className="ghost danger-text"
            onClick={() => void deletePipeline()}
            disabled={!editable || !doc || doc.definition.name === serverInfo?.default_pipeline_name}
            title={
              doc?.definition.name === serverInfo?.default_pipeline_name
                ? "The server's default pipeline can't be deleted"
                : "Delete this pipeline (recoverable)"
            }
          >
            Delete
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".yaml,.yml"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <DisplayMenu settings={display.settings} onChange={display.update} />
        </div>
      </header>

      <div className="notices">
        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            <span>{notice.text}</span>
            {notice.action && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  notice.action?.run();
                  setNotice(null);
                }}
              >
                {notice.action.label}
              </button>
            )}
            <button type="button" className="link" aria-label="Dismiss" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}
        {outage && online !== false && <OutageNotice message={outageMessage(outage)} onRetry={() => refreshModels(true)} />}
        {serverInfo && !serverInfo.editing_enabled && (
          <div className="notice info subtle">
            {serverInfo.editing_disabled_reason ? (
              <>Read-only: {serverInfo.editing_disabled_reason}</>
            ) : (
              <>
                Read-only: this server has editing disabled. Set <code>PIPELINE_EDITING_ENABLED=true</code> on the server
                to build and save pipelines here.
              </>
            )}
          </div>
        )}
      </div>

      <div className="workspace">
        <main className="canvas-wrap">
          {doc ? (
            <PipelineCanvas
              key={canvasKey}
              nodes={flow.nodes}
              edges={flow.edges}
              editable={editable}
              colorMode={display.theme}
              textScale={display.settings.textScale}
              selectedNodeId={selection?.kind === "node" ? selection.id : null}
              fitSignal={fitSignal}
              onConnect={(from, to) => edit((d) => connect(d, from, to))}
              onDisconnect={(from, to) =>
                edit((d) => (d.nodes.some((n) => n.id === from) && d.nodes.some((n) => n.id === to) ? disconnect(d, from, to) : d))
              }
              onDeleteNodes={(ids) => {
                edit((d) => ids.reduce((acc, id) => (acc.nodes.some((n) => n.id === id) ? removeNode(acc, id) : acc), d));
                setSelection(null);
              }}
              onMoveNodes={(moves) =>
                edit((d) =>
                  moves.reduce((acc, m) => {
                    const layout = acc.nodes.find((n) => n.id === m.id)?.layout;
                    return layout && Math.round(m.x) === layout.x && Math.round(m.y) === layout.y
                      ? acc
                      : moveNode(acc, m.id, m.x, m.y);
                  }, d)
                )
              }
              onSelect={setSelection}
              onDropNode={(position, preset) => addNodeAt(position, preset)}
            />
          ) : (
            <div className="canvas-empty">{loadError ?? "loading…"}</div>
          )}
        </main>
        {doc && (
          <Splitter
            axis="x"
            grow={-1}
            value={panels.sizes.panel}
            onResize={(px) => panels.setSize("panel", px)}
            onReset={() => panels.resetSize("panel")}
            label="Resize the panel"
            className="splitter-panel"
          />
        )}
        <SidePanel
          tab={panelTab}
          onTab={setPanelTab}
          badges={{
            chat: running ? <span className="pulse-dot" aria-hidden="true" /> : null,
            tests: testRun?.status === "running" ? <span className="pulse-dot" aria-hidden="true" /> : null,
          }}
          footer={
            <Composer
              ref={composer}
              running={running}
              runLabel={doc?.dirty ? "Save & run" : "Run"}
              disabledReason={runDisabled}
              onSubmit={(prompt) => {
                // Show the answer coming in — unless the log is what's being watched.
                if (panelTab !== "messages") setPanelTab("chat");
                void run(prompt);
              }}
              onStop={() => stopRun.current?.abort()}
            />
          }
        >
          {panelTab === "chat" ? (
            <Chat
              turns={turns}
              running={running}
              pendingAnswer={pendingAnswer}
              verbose={verbose}
              onVerbose={setVerbose}
              conversations={conversations}
              currentConversation={conversationId.current}
              onOpenConversation={(id) => void openConversation(id)}
              onDeleteConversation={(id) => void removeConversation(id)}
              onNewConversation={resetRunState}
              onRetry={retry}
              retryDisabledReason={runDisabled}
              onEditMessage={(prompt) => composer.current?.fill(prompt)}
            />
          ) : panelTab === "messages" ? (
            <MessagesView
              turns={turns}
              outputNodeIds={outputIds}
              onSelectNode={(nodeId) => setSelection({ kind: "node", id: nodeId })}
              rerunnable={rerunnable}
              onRerun={(id) => void run("", id)}
            />
          ) : panelTab === "add" ? (
            <Sidebar
              editable={editable && Boolean(doc)}
              presets={presets}
              onAdd={(preset) => addNodeAt(undefined, preset)}
              onDeletePreset={(name) => void deletePreset(name)}
            />
          ) : !doc ? (
            <div className="empty-state">{loadError ?? "loading…"}</div>
          ) : panelTab === "tests" ? (
            <TestsView
              definition={doc.definition}
              editable={editable}
              models={models}
              onEdit={edit}
              onRefreshModels={() => void refreshModels(true)}
              run={testRun}
              onRun={(request) => void runTests(request)}
              onStop={() => stopTests.current?.abort()}
              lastMessage={lastTurn?.prompt ?? null}
            />
          ) : (
            <Inspector
              doc={doc}
              selection={selection}
              editable={editable}
              models={models}
              presets={presets}
              turns={turns}
              validation={doc.dirty ? validation : { status: "idle" }}
              onEdit={edit}
              onSelect={setSelection}
              onRefreshModels={() => void refreshModels(true)}
              onSaveAsPreset={(id) => void saveNodeAsPreset(id)}
              onDuplicate={duplicate}
              rerunnable={rerunnable}
              onRerun={(id) => void run("", id)}
              previewContext={previewContext}
            />
          )}
        </SidePanel>
      </div>
    </div>
  );
}
