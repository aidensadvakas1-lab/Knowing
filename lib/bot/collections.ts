/**
 * Collections: lists people make themselves, like Date night or Watch later.
 * Unlike folders, a video can be in as many collections as they like, and it
 * stays in its folder too. Nothing files videos into a collection on its own:
 * they add them with 📌 under a video, or by asking ("add my pasta videos to
 * Date night").
 *
 * All of one person's collections are kept together, in bot_users.collections,
 * as [{name, ids}]. A deleted video is left out wherever it's shown, so a
 * collection never lists a video that's gone. Nothing here calls the AI.
 */
import { cleanFolderName, folderKey } from "./folders";
import type { Collection, Save } from "./types";

/** Most collections per person. */
export const COLLECTIONS_KEPT = 30;
/** Most videos in one collection. */
export const COLLECTION_SIZE = 300;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Same short id as folders use, for Telegram's 64-byte button data. */
export const collectionKey = folderKey;

/** Collections read from the database, checked and tidied: named, no repeats. */
export function readCollections(raw: unknown): Collection[] {
  const out: Collection[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const name = cleanFolderName(String(r.name ?? ""));
    if (!name || out.some((c) => same(c.name, name))) continue;
    const ids = (Array.isArray(r.ids) ? r.ids : []).map(String).filter(Boolean);
    out.push({ name, ids: [...new Set(ids)].slice(-COLLECTION_SIZE) });
  }
  return out.slice(0, COLLECTIONS_KEPT);
}

/** The videos in it that still exist, newest saved first. */
export function videosIn(collection: Collection, saves: Save[]): Save[] {
  return saves.filter((s) => collection.ids.includes(s.id));
}

/** The collection a button's key stands for. */
export function findCollection(collections: Collection[], key: string): Collection | undefined {
  return collections.find((c) => collectionKey(c.name) === key);
}

/** A name with the spelling of the collection they already have by that name, or the name itself for a new one. */
export function matchCollection(name: string, collections: Collection[]): string {
  return collections.find((c) => same(c.name, name))?.name ?? name;
}

/** The names of the collections a video is in. */
export function collectionsOf(collections: Collection[], saveId: string): string[] {
  return collections.filter((c) => c.ids.includes(saveId)).map((c) => c.name);
}

/** True when there's room for one more collection (or it already exists). */
export function hasRoomFor(collections: Collection[], name: string): boolean {
  return collections.some((c) => same(c.name, name)) || collections.length < COLLECTIONS_KEPT;
}

/** Their collections with these videos added to one (made if it's new, when there's room). */
export function addTo(collections: Collection[], name: string, ids: string[]): Collection[] {
  const clean = cleanFolderName(name);
  if (!clean) return collections;
  const found = collections.find((c) => same(c.name, clean));
  if (!found) return hasRoomFor(collections, clean) ? [...collections, { name: clean, ids: [...new Set(ids)].slice(-COLLECTION_SIZE) }] : collections;
  return collections.map((c) => (c === found ? { ...c, ids: [...new Set([...c.ids, ...ids])].slice(-COLLECTION_SIZE) } : c));
}

/** Their collections with these videos taken out of one. The collection stays, even if it's empty. */
export function removeFrom(collections: Collection[], name: string, ids: string[]): Collection[] {
  return collections.map((c) => (same(c.name, name) ? { ...c, ids: c.ids.filter((id) => !ids.includes(id)) } : c));
}

/** Rename a collection. Renaming it to one they already have merges the two. */
export function renameCollection(collections: Collection[], from: string, to: string): Collection[] {
  const source = collections.find((c) => same(c.name, from));
  const name = cleanFolderName(to);
  if (!source || !name) return collections;
  const into = collections.find((c) => c !== source && same(c.name, name));
  if (!into) return collections.map((c) => (c === source ? { ...c, name } : c));
  return addTo(dropCollection(collections, source.name), into.name, source.ids);
}

/** Their collections without this one. The videos stay saved. */
export function dropCollection(collections: Collection[], name: string): Collection[] {
  return collections.filter((c) => !same(c.name, name));
}

/** When a new save replaces an old one, it takes the old one's place in every collection. */
export function swapVideo(collections: Collection[], oldId: string, newId: string): Collection[] {
  return collections.map((c) => (c.ids.includes(oldId) ? { ...c, ids: [...new Set(c.ids.map((id) => (id === oldId ? newId : id)))] } : c));
}

/**
 * Their collections for Claude, one a line, with the videos in each by id and
 * title, so "what's in Date night?" or "take the ramen one out of Japan" works:
 * `Date night (2): [id a1] "Pasta alla vodka", [id b2] "Rooftop bars in Austin"`.
 */
export function collectionShelf(collections: Collection[], saves: Save[]): string[] {
  return collections.map((c) => {
    const list = videosIn(c, saves);
    return `${c.name} (${list.length})${list.length ? `: ${list.map((s) => `[id ${s.id}] "${s.title.slice(0, 30)}"`).join(", ")}` : ", empty"}`;
  });
}
