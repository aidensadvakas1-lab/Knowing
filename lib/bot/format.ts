/**
 * Telegram message text (HTML parse mode) and buttons for saves, drill
 * steps and answers.
 */
import { folderKey, folders } from "./folders";
import { SAVE_TYPE_LABEL, type InlineButton, type Save } from "./types";

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
  rows.push([{ text: "Fix something", callback_data: `fix:${s.id}` }]);
  return rows;
}

/** The full save, shown when asked. */
export function saveCard(s: Save, notes: string[] = []): string {
  const lines = [
    `<b>${escapeHtml(s.title)}</b>`,
    `<i>${escapeHtml(s.topic || "No topic")} · ${SAVE_TYPE_LABEL[s.type]}</i>`,
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
  rows.push([{ text: "Fix something", callback_data: `fix:${s.id}` }]);
  return rows;
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
    html: `📂 <b>Your folders</b>\n${saves.length} video${saves.length === 1 ? "" : "s"} in ${all.length} folder${all.length === 1 ? "" : "s"}, filed for you as you save them. Tap one to open it.${more}`,
    buttons,
  };
}

/** One folder: its videos, newest first, each linked, with number buttons that open the notes. */
export function folderView(saves: Save[], key: string): { html: string; buttons: InlineButton[][] } | null {
  const folder = folders(saves).find((f) => folderKey(f.name) === key);
  if (!folder) return null;
  const listed = folder.saves.slice(0, LISTED);
  const n = folder.saves.length;
  const lines = [`📂 <b>${escapeHtml(folder.name)}</b> · ${n} video${n === 1 ? "" : "s"}`, ""];
  lines.push(...listed.map((s, i) => `${i + 1}. ${linkedTitle(s)} <i>(${SAVE_TYPE_LABEL[s.type]}, ${shortDate(s.createdAt)})</i>`));
  if (n > listed.length) lines.push(`…and ${n - listed.length} older ones. Ask me about them any time.`);
  lines.push("", "Tap a number for its notes, or just ask me about any of them.");
  const buttons: InlineButton[][] = [];
  for (let i = 0; i < listed.length; i += 6) {
    buttons.push(listed.slice(i, i + 6).map((s, j) => ({ text: String(i + j + 1), callback_data: `show:${s.id}` })));
  }
  buttons.push([{ text: "« All folders", callback_data: "folders:" }]);
  return { html: lines.join("\n"), buttons };
}
