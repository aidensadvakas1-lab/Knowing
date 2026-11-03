/**
 * Folders: every save is in exactly one. Claude picks it when it watches the
 * video, going by the folders they already have, what they've moved into each
 * and their filing rules ("anything about cars goes in Car mods"), so a new
 * video lands where they'd put it. They can move a video, rename, merge or
 * delete a folder, by button or by asking in chat.
 *
 * A folder exists while it has videos in it. Saves from before folders could
 * be moved have no folder of their own and are filed by the first part of
 * their topic ("Cooking, Pasta" goes in Cooking), like before.
 *
 * Big folders split into sections by the second part of the topic (Gym into
 * Legs, Arms...), so nobody has to make subfolders. Nothing here calls the AI.
 */
import type { FilingRule, Save } from "./types";

export interface Folder {
  name: string;
  /** Newest first. */
  saves: Save[];
}

/** Where a deleted folder's videos go, so nothing is lost. New videos are never filed here. */
export const UNSORTED = "Unsorted";
/** Longest folder name. */
export const FOLDER_NAME_MAX = 40;
/** Filing rules kept per person. */
export const RULES_KEPT = 20;
/** Folders with at least this many videos split into sections. */
export const SECTION_MIN = 8;

/** A folder name as typed or written by Claude, tidied: one line, no "|" (it separates parts of a MOVE line), at most FOLDER_NAME_MAX characters. "" if nothing's left. */
export function cleanFolderName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f|<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'«“]+|["'»”.]+$/g, "")
    .trim()
    .slice(0, FOLDER_NAME_MAX)
    .trim();
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The first part of a save's topic: where saves from before folders could be moved are filed. */
export function topicFolder(topic: string): string {
  return cleanFolderName(topic.split(",")[0] ?? "") || "Other";
}

/** The folder a save is in. */
export function folderOf(save: Save): string {
  return cleanFolderName(save.folder ?? "") || topicFolder(save.topic);
}

/** 1 when a name starts with a capital, so "Cooking" wins a tie with "cooking". */
const capital = (name: string) => (/^\p{Lu}/u.test(name) ? 1 : 0);

/** Their folders, biggest first (Unsorted last). Differences in capitals don't make a new folder; the spelling used most wins (capitalized on a tie). */
export function folders(saves: Save[]): Folder[] {
  const groups = new Map<string, { spellings: Map<string, number>; saves: Save[] }>();
  for (const save of saves) {
    const name = folderOf(save);
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { spellings: new Map<string, number>(), saves: [] as Save[] };
    group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
    group.saves.push(save);
    groups.set(key, group);
  }
  const last = (f: Folder) => (same(f.name, UNSORTED) ? 1 : 0);
  return [...groups.values()]
    .map((g) => ({ name: [...g.spellings].sort((a, b) => b[1] - a[1] || capital(b[0]) - capital(a[0]))[0]?.[0] ?? "Other", saves: g.saves }))
    .sort((a, b) => last(a) - last(b) || b.saves.length - a.saves.length || a.name.localeCompare(b.name));
}

/** A short, stable id for a folder, to fit in Telegram's 64-byte button data whatever the folder's name. */
export function folderKey(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The folder a button's key stands for, if it still has videos. */
export function findFolder(saves: Save[], key: string): Folder | undefined {
  return folders(saves).find((f) => folderKey(f.name) === key);
}

/** A name with the spelling of the folder they already have by that name ("gym" files into "Gym"), or the name itself for a new folder. */
export function matchFolder(name: string, saves: Save[]): string {
  return folders(saves).find((f) => same(f.name, name))?.name ?? name;
}

/** "Gym (4), Cooking (3)". */
export function folderNames(saves: Save[], limit = 30): string {
  return folders(saves)
    .slice(0, limit)
    .map((f) => `${f.name} (${f.saves.length})`)
    .join(", ");
}

/**
 * Their folders for Claude, one a line, with a few of the newest titles in
 * each and the rules that send videos there, so it files a new video where
 * they would: `Japan trip (3): "Tokyo ramen spots", "Kyoto in 2 days". Rule: anything about Japan`.
 * Rules for folders that are still empty get a line too.
 */
export function folderShelf(saves: Save[], rules: FilingRule[] = [], limit = 40): string[] {
  const all = folders(saves);
  const ruled = (name: string) => rules.filter((r) => same(r.folder, name)).map((r) => r.about);
  const lines = all.slice(0, limit).map((f) => {
    const titles = f.saves.slice(0, 3).map((s) => `"${s.title.slice(0, 40)}"`).join(", ");
    const rule = ruled(f.name);
    return `${f.name} (${f.saves.length}): ${titles}${rule.length ? `. Rule: ${rule.join("; ")}` : ""}`;
  });
  const waiting = [...new Set(rules.map((r) => r.folder))].filter((name) => !all.some((f) => same(f.name, name)));
  return [...lines, ...waiting.map((name) => `${name} (0, nothing in it yet). Rule: ${ruled(name).join("; ")}`)];
}

/** Which section of a big folder a save goes in: the second part of its topic ("Gym, Legs" is Legs), or "" when it has none. */
export function sectionOf(save: Save, folder: string): string {
  const parts = save.topic.split(",").map((p) => cleanFolderName(p)).filter(Boolean);
  const name = parts.length > 1 ? parts[1] : parts[0];
  return !name || same(name, folder) ? "" : name;
}

/**
 * A big folder's videos in sections (each with 2 or more videos, biggest
 * first, then "Other" for the rest), or null when it's small or doesn't split
 * into at least two sections.
 */
export function sections(folder: Folder): Folder[] | null {
  if (folder.saves.length < SECTION_MIN) return null;
  const groups = new Map<string, Folder>();
  for (const save of folder.saves) {
    const name = sectionOf(save, folder.name);
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, saves: [] };
    group.saves.push(save);
    groups.set(key, group);
  }
  const named = [...groups.values()].filter((g) => g.name && g.saves.length >= 2).sort((a, b) => b.saves.length - a.saves.length || a.name.localeCompare(b.name));
  if (named.length < 2) return null;
  const rest = folder.saves.filter((s) => !named.some((g) => g.saves.includes(s)));
  return rest.length ? [...named, { name: "Other", saves: rest }] : named;
}

/** Filing rules read from the database, checked and tidied. */
export function readRules(raw: unknown): FilingRule[] {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ folder: cleanFolderName(String(r.folder ?? "")), about: String(r.about ?? "").replace(/\s+/g, " ").trim().slice(0, 120) }))
    .filter((r) => r.folder && r.about)
    .slice(-RULES_KEPT);
}

/** Their rules plus new ones, without repeats, newest kept. */
export function addRules(rules: FilingRule[], fresh: FilingRule[]): FilingRule[] {
  const out = [...rules];
  for (const rule of readRules(fresh)) {
    const i = out.findIndex((r) => same(r.folder, rule.folder) && same(r.about, rule.about));
    if (i >= 0) out.splice(i, 1);
    out.push(rule);
  }
  return out.slice(-RULES_KEPT);
}

/** Rules for a renamed (or merged) folder now send videos to its new name. */
export function renameRules(rules: FilingRule[], from: string, to: string): FilingRule[] {
  return addRules([], rules.map((r) => (same(r.folder, from) ? { ...r, folder: to } : r)));
}

/** Rules without the ones for this folder. */
export function dropRules(rules: FilingRule[], folder: string): FilingRule[] {
  return rules.filter((r) => !same(r.folder, folder));
}
