/**
 * Browser storage for Knowing.
 *
 * Data lives in localStorage on the device. Every access is wrapped so a
 * private window, full storage, or corrupt data never crashes the app; the
 * worst case is starting empty. Backup and restore move data between devices.
 */
import { EMPTY_PROFILE, LIMITS, STORAGE_KEYS } from "./constants";
import type { ChatTurn, KnowingBackup, KnowledgeItem, Profile } from "./types";
import { ChatTurnSchema, KnowledgeItemSchema, ProfileSchema } from "./validate";
import { z } from "zod";

/** Read and JSON-parse a key, returning `fallback` on any problem. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** JSON-serialize and write a key. Returns false if the write failed (e.g. quota). */
export function writeJson(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Remove a key, ignoring errors. */
export function removeKey(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing to do: storage is unavailable.
  }
}

/** Validate an array, keeping only the entries that pass the schema. */
function keepValid<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const result = schema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

export function loadProfile(): Profile {
  const result = ProfileSchema.safeParse(readJson(STORAGE_KEYS.profile, null));
  return result.success ? result.data : { ...EMPTY_PROFILE };
}

export function loadItems(): KnowledgeItem[] {
  return keepValid(KnowledgeItemSchema, readJson(STORAGE_KEYS.items, [])) as KnowledgeItem[];
}

export function loadChat(): ChatTurn[] {
  return keepValid(ChatTurnSchema, readJson(STORAGE_KEYS.chat, [])).slice(-LIMITS.chatTurnsKept);
}

export const saveProfile = (profile: Profile) => writeJson(STORAGE_KEYS.profile, profile);
export const saveItems = (items: KnowledgeItem[]) => writeJson(STORAGE_KEYS.items, items);
export const saveChat = (chat: ChatTurn[]) => writeJson(STORAGE_KEYS.chat, chat.slice(-LIMITS.chatTurnsKept));

/** Package everything into one backup object. */
export function createBackup(profile: Profile, items: KnowledgeItem[], chat: ChatTurn[]): KnowingBackup {
  return { version: 1, exportedAt: Date.now(), profile, items, chat };
}

/**
 * Validate a backup file's contents. Invalid items are skipped rather than
 * failing the whole restore. Throws only if the file isn't a Knowing backup.
 */
export function parseBackup(raw: string): KnowingBackup {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) {
    throw new Error("That file isn't a Knowing backup.");
  }
  const obj = data as Record<string, unknown>;
  const profile = ProfileSchema.safeParse(obj.profile);
  return {
    version: 1,
    exportedAt: typeof obj.exportedAt === "number" ? obj.exportedAt : Date.now(),
    profile: profile.success ? profile.data : { ...EMPTY_PROFILE },
    items: keepValid(KnowledgeItemSchema, obj.items) as KnowledgeItem[],
    chat: keepValid(ChatTurnSchema, obj.chat),
  };
}

/** Merge restored items into existing ones, de-duplicating by id. */
export function mergeItems(existing: KnowledgeItem[], incoming: KnowledgeItem[]): KnowledgeItem[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** A short random id, unique enough for items in one person's browser. */
export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
