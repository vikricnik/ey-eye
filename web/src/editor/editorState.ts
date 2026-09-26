import type { PipelineDefinition } from "@llm-pipeline/client";

const HISTORY_LIMIT = 100;
/** Edits to the same field within this window form one undo step. */
const COALESCE_MS = 600;

/** The pipeline being edited, its undo history, and what's needed to save it. */
export interface EditorDoc {
  definition: PipelineDefinition;
  /** What's saved on the server; null for a draft that was never saved
   * (new or imported), which counts as unsaved until it is. */
  savedDefinition: PipelineDefinition | null;
  /** Revision the draft is based on (sent when saving); null = create. */
  baseRevision: string | null;
  past: PipelineDefinition[];
  future: PipelineDefinition[];
  /** The last edit's coalesce key and time — see COALESCE_MS. */
  lastEdit: { key: string; at: number } | null;
  /** Differs from what's saved. Undoing back to the saved state clears it. */
  dirty: boolean;
}

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; from: string; to: string }
  | { kind: "pipeline" };

export type DocAction =
  | { type: "load"; definition: PipelineDefinition; baseRevision: string | null; saved: boolean }
  | { type: "edit"; definition: PipelineDefinition; coalesce?: string | undefined; at: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; definition: PipelineDefinition; revision: string };

function sameDefinition(a: PipelineDefinition, b: PipelineDefinition): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function withDirty(doc: Omit<EditorDoc, "dirty">): EditorDoc {
  return {
    ...doc,
    dirty: doc.savedDefinition === null || !sameDefinition(doc.definition, doc.savedDefinition),
  };
}

/** Pure: the same state and action always give the same result, so the
 * app can apply it to a ref synchronously and then publish it. */
export function docReducer(state: EditorDoc | null, action: DocAction): EditorDoc | null {
  if (action.type === "load") {
    return withDirty({
      definition: action.definition,
      savedDefinition: action.saved ? action.definition : null,
      baseRevision: action.baseRevision,
      past: [],
      future: [],
      lastEdit: null,
    });
  }
  if (!state) return state;

  switch (action.type) {
    case "edit": {
      if (action.definition === state.definition) return state;
      const merge =
        action.coalesce !== undefined &&
        state.lastEdit?.key === action.coalesce &&
        action.at - state.lastEdit.at < COALESCE_MS;
      return withDirty({
        ...state,
        definition: action.definition,
        past: merge ? state.past : [...state.past, state.definition].slice(-HISTORY_LIMIT),
        future: [],
        lastEdit: action.coalesce !== undefined ? { key: action.coalesce, at: action.at } : null,
      });
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return withDirty({
        ...state,
        definition: previous,
        past: state.past.slice(0, -1),
        future: [state.definition, ...state.future],
        lastEdit: null,
      });
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return withDirty({
        ...state,
        definition: next,
        past: [...state.past, state.definition],
        future: state.future.slice(1),
        lastEdit: null,
      });
    }
    case "saved":
      // History survives a save: undo can still go back past it (which
      // makes the draft differ from the saved file again).
      return withDirty({
        ...state,
        definition: action.definition,
        savedDefinition: action.definition,
        baseRevision: action.revision,
        lastEdit: null,
      });
  }
}

export interface Issue {
  nodeId: string | null;
  message: string;
}

export type ValidationState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "valid"; modelIssues: Issue[]; warnings: Issue[] }
  | { status: "invalid"; message: string; nodeId: string | null }
  | { status: "unavailable"; message: string };
