import type { ConversationTurn } from "@llm-pipeline/client";
import type { Turn } from "./Chat";

/**
 * Past conversations, kept in this browser (IndexedDB) so runs and their
 * message logs survive a reload. Per viewer and best effort: when storage
 * is unavailable (private mode, blocked site data) every call quietly does
 * nothing and the app works as before, just without history.
 */

export interface Conversation {
  id: string;
  pipeline: string;
  /** The first message. */
  title: string;
  updatedAt: number;
  turns: Turn[];
  /** The context the next message is sent with. */
  history: ConversationTurn[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  turnCount: number;
}

const DB_NAME = "llm-pipeline";
const STORE = "conversations";
/** Older conversations of a pipeline are dropped beyond this many. */
export const KEEP_PER_PIPELINE = 30;

let opened: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("pipeline", "pipeline");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  const db = await openDb();
  return db ? db.transaction(STORE, mode).objectStore(STORE) : null;
}

async function allFor(pipeline: string): Promise<Conversation[]> {
  const conversations = await store("readonly");
  if (!conversations) return [];
  const found = await done(conversations.index("pipeline").getAll(pipeline) as IDBRequest<Conversation[]>);
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A pipeline's conversations, most recent first. */
export async function listConversations(pipeline: string): Promise<ConversationSummary[]> {
  try {
    return (await allFor(pipeline)).map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      turnCount: c.turns.length,
    }));
  } catch {
    return [];
  }
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  try {
    const conversations = await store("readonly");
    return conversations ? ((await done(conversations.get(id))) as Conversation | undefined) ?? null : null;
  } catch {
    return null;
  }
}

/** Saves (or replaces) a conversation, then drops the pipeline's oldest
 * beyond KEEP_PER_PIPELINE. */
export async function saveConversation(conversation: Conversation): Promise<void> {
  try {
    const conversations = await store("readwrite");
    if (!conversations) return;
    await done(conversations.put(conversation));
    const stale = (await allFor(conversation.pipeline)).slice(KEEP_PER_PIPELINE);
    if (stale.length === 0) return;
    const cleanup = await store("readwrite");
    await Promise.all(stale.map((c) => cleanup && done(cleanup.delete(c.id))));
  } catch {
    // not remembered — the conversation still works for this page
  }
}

export async function deleteConversation(id: string): Promise<void> {
  try {
    const conversations = await store("readwrite");
    if (conversations) await done(conversations.delete(id));
  } catch {
    // nothing to do: it wasn't stored, or storage is unavailable
  }
}

/** An id for a new conversation — crypto.randomUUID only exists in secure
 * contexts, and the app may be served over plain http on a LAN address. */
export function newConversationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
