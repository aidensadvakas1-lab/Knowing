/**
 * Smart folders: every save is filed by the first part of its topic
 * ("Cooking, Pasta" goes in Cooking), which Claude writes when it watches the
 * video. Claude is shown the folders someone already has, so it reuses "Gym"
 * instead of starting "Fitness". Nobody has to organize anything, and it costs
 * nothing: /folders only reads what's saved.
 */
import type { Save } from "./types";

export interface Folder {
  name: string;
  /** Newest first. */
  saves: Save[];
}

/** The folder a save is filed in: the first part of its topic. */
export function folderOf(save: Save): string {
  return (save.topic.split(",")[0] ?? "").trim().slice(0, 40) || "Other";
}

/** 1 when a name starts with a capital, so "Cooking" wins a tie with "cooking". */
const capital = (name: string) => (/^\p{Lu}/u.test(name) ? 1 : 0);

/** Their folders, biggest first. Differences in capitals don't make a new folder; the spelling used most wins (capitalized on a tie). */
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
  return [...groups.values()]
    .map((g) => ({ name: [...g.spellings].sort((a, b) => b[1] - a[1] || capital(b[0]) - capital(a[0]))[0]?.[0] ?? "Other", saves: g.saves }))
    .sort((a, b) => b.saves.length - a.saves.length || a.name.localeCompare(b.name));
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

/** "Gym (4), Cooking (3)", for the watcher, so it files new videos under folders they already have. */
export function folderNames(saves: Save[], limit = 30): string {
  return folders(saves)
    .slice(0, limit)
    .map((f) => `${f.name} (${f.saves.length})`)
    .join(", ");
}
