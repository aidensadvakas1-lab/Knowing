/**
 * Telegram message text (HTML parse mode) and buttons for saves, drill
 * steps and answers.
 */
import { findFolder, folderKey, folderOf, folders, sections, type Folder } from "./folders";
import { SAVE_TYPE_LABEL, type FilingRule, type InlineButton, type Save } from "./types";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Claude's light markdown (bold, italics, code) to Telegram HTML. Code goes
 * first and is set aside, so a `*` or `#` in a command stays as typed, and
 * Telegram shows it tap-to-copy without turning `/mcp` or `@name` into links.
 */
export function mdToHtml(md: string): string {
  const code: string[] = [];
  const keep = (html: string) => `\u0000${code.push(html) - 1}\u0000`;
  return escapeHtml(md)
    .replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, body: string) => keep(`<pre>${body.replace(/\n$/, "")}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, body: string) => keep(`<code>${body}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/^#{1,4}\s+(.*)$/gm, "<b>$1</b>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}

const canRun = (s: Save) => (s.type === "drill" || s.type === "plan") && s.steps.length > 0;

/** The link to the video a save came from, ready for an href. Empty for a video sent as a file. */
const videoHref = (s: Save) => (/^https?:\/\//.test(s.sourceUrl) ? escapeHtml(s.sourceUrl).replace(/"/g, "&quot;") : "");

/** A save's title, linked to its video when there is one. */
export function linkedTitle(s: Save): string {
  const href = videoHref(s);
  return href ? `<a href="${href}">${escapeHtml(s.title)}</a>` : escapeHtml(s.title);
}

/** The reply to a shared video: a short reaction, then a one-line receipt. Details stay behind "Show steps". */
export function reactionText(reply: string, s: Save, notes: string[] = []): string {
  const lines = [mdToHtml(reply || `Saved: ${s.title}.`), "", `✓ <i>Saved: ${escapeHtml(s.title)}</i>`];
  if (notes.length) lines.push(...notes.map((n) => `<i>${escapeHtml(n)}</i>`));
  return lines.join("\n");
}

/**
 * Buttons under a reaction. Against a duplicate, ask keep both or replace.
 * Against another way to do something, both are kept, with Replace there if wanted.
 */
export function reactionButtons(s: Save, decideAgainst?: Save | null, kind: "duplicate" | "alternative" = "duplicate"): InlineButton[][] {
  const rows: InlineButton[][] = [];
  const replace = decideAgainst && { text: "Replace the old one", callback_data: `repl:${s.id}:${decideAgainst.id}` };
  if (replace) rows.push(kind === "duplicate" ? [{ text: "Keep both", callback_data: `keep:${s.id}` }, replace] : [replace]);
  const row: InlineButton[] = [];
  if (s.steps.length) row.push({ text: "Show steps", callback_data: `show:${s.id}` });
  if (canRun(s)) row.push({ text: "Start now", callback_data: `open:${s.id}` });
  if (row.length) rows.push(row);
  if (s.needsWords && !s.words) rows.push([{ text: "Add what it says", callback_data: `words:${s.id}` }]);
  rows.push([folderButton(s, "r"), { text: "Fix something", callback_data: `fix:${s.id}` }]);
  return rows;
}

/**
 * Where buttons were, so moving a video can put the same ones back: "r" under
 * the reaction to a shared video, "c" under a save's full card.
 */
export type ButtonsAt = "r" | "c";

/** "📂 Cooking": shows the folder it's in, and tapping it moves it. */
function folderButton(s: Save, at: ButtonsAt): InlineButton {
  return { text: `📂 ${folderOf(s).slice(0, 28)}`, callback_data: `mv:${s.id}:${at}` };
}

/** The buttons a save had at `at`, with its folder button up to date. */
export function buttonsFor(s: Save, at: ButtonsAt): InlineButton[][] {
  return at === "c" ? saveButtons(s) : reactionButtons(s);
}

/** Most folders offered when moving a video; the rest are a "New folder" (same name) away. */
const MOVE_CHOICES = 12;

/** Moving a video: their other folders, biggest first, then a new one. */
export function moveButtons(s: Save, saves: Save[], at: ButtonsAt): InlineButton[][] {
  const here = folderOf(s).toLowerCase();
  const others = folders(saves).filter((f) => f.name.toLowerCase() !== here).slice(0, MOVE_CHOICES);
  const rows: InlineButton[][] = [];
  for (let i = 0; i < others.length; i += 2) {
    rows.push(others.slice(i, i + 2).map((f) => ({ text: f.name, callback_data: `mvto:${s.id}:${folderKey(f.name)}:${at}` })));
  }
  rows.push([{ text: "➕ New folder", callback_data: `mvnew:${s.id}` }, { text: "« Back", callback_data: `mvback:${s.id}:${at}` }]);
  return rows;
}

/** The full save, shown when asked. */
export function saveCard(s: Save, notes: string[] = []): string {
  const lines = [
    `<b>${escapeHtml(s.title)}</b>`,
    `<i>📂 ${escapeHtml(folderOf(s))} · ${escapeHtml(s.topic || "No topic")} · ${SAVE_TYPE_LABEL[s.type]}</i>`,
  ];
  if (s.summary) lines.push("", escapeHtml(s.summary));
  if (s.steps.length) lines.push("", ...s.steps.map((x, i) => `${i + 1}. ${escapeHtml(x)}`));
  if (videoHref(s)) lines.push("", `<a href="${videoHref(s)}">Open the video</a>`);
  if (s.needsWords && !s.words) lines.push("", "<i>I couldn't hear what's said. Tap Add what it says if the details are spoken.</i>");
  if (notes.length) lines.push("", ...notes.map((n) => `<i>${escapeHtml(n)}</i>`));
  return lines.join("\n");
}

export function saveButtons(s: Save): InlineButton[][] {
  const rows: InlineButton[][] = [];
  if (canRun(s)) rows.push([{ text: "Start now", callback_data: `open:${s.id}` }]);
  if (s.needsWords && !s.words) rows.push([{ text: "Add what it says", callback_data: `words:${s.id}` }]);
  rows.push([folderButton(s, "c"), { text: "Fix something", callback_data: `fix:${s.id}` }]);
  rows.push([{ text: "🗑 Delete", callback_data: `del:${s.id}` }]);
  return rows;
}

/** Asked before a save is deleted. */
export function deleteButtons(s: Save): InlineButton[][] {
  return [[{ text: "Yes, delete it", callback_data: `delok:${s.id}` }, { text: "Cancel", callback_data: `delno:${s.id}` }]];
}

/** One step of Start now. */
export function stepText(s: Save, i: number): string {
  const bar = s.steps.map((_, k) => (k <= i ? "●" : "○")).join("");
  return `<b>${escapeHtml(s.title)}</b>\n${bar}  Step ${i + 1} of ${s.steps.length}\n\n${escapeHtml(s.steps[i] ?? "")}`;
}

export function stepButtons(s: Save, i: number): InlineButton[][] {
  const row: InlineButton[] = [];
  if (i > 0) row.push({ text: "Back", callback_data: `run:${s.id}:${i - 1}` });
  row.push(i < s.steps.length - 1 ? { text: "Next", callback_data: `run:${s.id}:${i + 1}` } : { text: "Done", callback_data: `done:${s.id}` });
  return [row];
}

/** Everything saved, grouped by topic. */
export function savedList(saves: Save[]): string {
  if (!saves.length) return "Nothing saved yet. In TikTok, tap Share, then Telegram, then me.";
  const out: string[] = [`<b>Your saves</b> (${saves.length})`];
  for (const { name, saves: list } of folders(saves)) {
    out.push("", `<b>${escapeHtml(name)}</b>`, ...list.slice(0, 15).map((s) => `• ${linkedTitle(s)} <i>(${SAVE_TYPE_LABEL[s.type]})</i>`));
  }
  return out.join("\n");
}

/**
 * An answer plus its videos, each linked. "From your save" only when the
 * answer came from it. Other videos on the same topic (including one the chat
 * is about when the answer came from Claude, like install steps its video
 * skips) go in a list under "Videos related to this topic", so they can
 * rewatch them without being told the answer came from there.
 */
export const RELATED_SHOWN = 5;

export function answerText(text: string, sources: Save[], related: Save[] = []): string {
  const others = [...new Set(related)].filter((s) => !sources.includes(s)).slice(0, RELATED_SHOWN);
  const parts = [mdToHtml(text)];
  if (sources.length) parts.push(`<i>From your save${sources.length > 1 ? "s" : ""}: ${sources.map(linkedTitle).join(", ")}</i>`);
  if (others.length) parts.push(["<b>Videos related to this topic:</b>", ...others.map((s) => `• ${linkedTitle(s)}`)].join("\n"));
  return parts.join("\n\n");
}

/** Most folders shown as buttons. */
const FOLDERS_SHOWN = 40;
/** Most videos listed in one folder. */
const LISTED = 30;

/** "Nov 2", in UTC like every other date the bot keeps. */
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** /folders: one button per folder, two to a row. */
export function folderList(saves: Save[]): { html: string; buttons: InlineButton[][] } {
  if (!saves.length) return { html: "No folders yet. Send me a video and I'll file it for you.", buttons: [] };
  const all = folders(saves);
  const shown = all.slice(0, FOLDERS_SHOWN);
  const buttons: InlineButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    buttons.push(shown.slice(i, i + 2).map((f) => ({ text: `${f.name} (${f.saves.length})`, callback_data: `folder:${folderKey(f.name)}` })));
  }
  const more = all.length > shown.length ? `\n\n${all.length - shown.length} smaller folders aren't shown. /saved lists everything.` : "";
  return {
    html: `📂 <b>Your folders</b>\n${saves.length} video${saves.length === 1 ? "" : "s"} in ${all.length} folder${all.length === 1 ? "" : "s"}, filed for you as you save them. Tap one to open it. To move a video, tap 📂 under it, or ask me ("put my pasta videos in Dinner ideas").${more}`,
    buttons,
  };
}

/**
 * One folder: its videos (newest first, in sections when it's big), each
 * linked, with number buttons that open the notes, then rename, merge and
 * delete, and its filing rules.
 */
export function folderView(saves: Save[], key: string, rules: FilingRule[] = []): { html: string; buttons: InlineButton[][] } | null {
  const folder = findFolder(saves, key);
  if (!folder) return null;
  const parts: Folder[] = sections(folder) ?? [{ name: "", saves: folder.saves }];
  const n = folder.saves.length;
  const lines = [`📂 <b>${escapeHtml(folder.name)}</b> · ${n} video${n === 1 ? "" : "s"}`];
  const listed: Save[] = [];
  for (const part of parts) {
    const room = part.saves.slice(0, LISTED - listed.length);
    if (!room.length) break;
    lines.push(part.name ? `\n<b>${escapeHtml(part.name)}</b>` : "");
    for (const s of room) {
      listed.push(s);
      lines.push(`${listed.length}. ${linkedTitle(s)} <i>(${SAVE_TYPE_LABEL[s.type]}, ${shortDate(s.createdAt)})</i>`);
    }
  }
  if (n > listed.length) lines.push(`…and ${n - listed.length} more. Ask me about them any time.`);
  const own = rules.filter((r) => r.folder.toLowerCase() === folder.name.toLowerCase());
  if (own.length) lines.push("", `📌 New videos about ${own.map((r) => escapeHtml(r.about)).join("; ")} come here.`);
  lines.push("", "Tap a number for its notes, or just ask me about any of them.");
  const buttons: InlineButton[][] = [];
  for (let i = 0; i < listed.length; i += 6) {
    buttons.push(listed.slice(i, i + 6).map((s, j) => ({ text: String(i + j + 1), callback_data: `show:${s.id}` })));
  }
  buttons.push([
    { text: "✏️ Rename", callback_data: `frn:${key}` },
    { text: "🔀 Merge", callback_data: `fmg:${key}` },
    { text: "🗑 Delete", callback_data: `fdl:${key}` },
  ]);
  if (own.length) buttons.push([{ text: "📌 Stop the rule", callback_data: `frl:${key}` }]);
  buttons.push([{ text: "« All folders", callback_data: "folders:" }]);
  return { html: lines.join("\n"), buttons };
}

/** Merging a folder: the others to merge it into. */
export function mergeButtons(saves: Save[], key: string): InlineButton[][] {
  const others = folders(saves).filter((f) => folderKey(f.name) !== key).slice(0, FOLDERS_SHOWN);
  const rows: InlineButton[][] = [];
  for (let i = 0; i < others.length; i += 2) {
    rows.push(others.slice(i, i + 2).map((f) => ({ text: f.name, callback_data: `fmgto:${key}:${folderKey(f.name)}` })));
  }
  rows.push([{ text: "« Back", callback_data: `folder:${key}` }]);
  return rows;
}
