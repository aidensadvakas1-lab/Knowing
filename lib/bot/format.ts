/**
 * Telegram message text (HTML parse mode) and buttons for saves, drill
 * steps and answers.
 */
import { SAVE_TYPE_LABEL, type InlineButton, type Save } from "./types";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Claude's light markdown (bold, italics, code) to Telegram HTML. */
export function mdToHtml(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,4}\s+(.*)$/gm, "<b>$1</b>");
}

const canRun = (s: Save) => (s.type === "drill" || s.type === "plan") && s.steps.length > 0;

/** A saved video as a message. */
export function saveCard(s: Save, notes: string[] = []): string {
  const lines = [
    `✅ <b>Saved:</b> ${escapeHtml(s.title)}`,
    `<i>${escapeHtml(s.topic || "No topic")} · ${SAVE_TYPE_LABEL[s.type]}</i>`,
  ];
  if (s.summary) lines.push("", escapeHtml(s.summary));
  if (s.steps.length) lines.push("", ...s.steps.map((x, i) => `${i + 1}. ${escapeHtml(x)}`));
  if (s.needsWords && !s.words) lines.push("", "🔇 I couldn't hear what's said. Tap <b>Add what it says</b> to make it exact.");
  if (notes.length) lines.push("", ...notes.map((n) => `<i>${escapeHtml(n)}</i>`));
  lines.push("", "Ask me about it anytime.");
  return lines.join("\n");
}

export function saveButtons(s: Save): InlineButton[][] {
  const rows: InlineButton[][] = [];
  if (canRun(s)) rows.push([{ text: "▶️ Start now", callback_data: `open:${s.id}` }]);
  if (s.needsWords && !s.words) rows.push([{ text: "✍️ Add what it says", callback_data: `words:${s.id}` }]);
  return rows;
}

/** One step of Start now. */
export function stepText(s: Save, i: number): string {
  const bar = s.steps.map((_, k) => (k <= i ? "●" : "○")).join("");
  return `<b>${escapeHtml(s.title)}</b>\n${bar}  Step ${i + 1} of ${s.steps.length}\n\n${escapeHtml(s.steps[i] ?? "")}`;
}

export function stepButtons(s: Save, i: number): InlineButton[][] {
  const row: InlineButton[] = [];
  if (i > 0) row.push({ text: "◀️ Back", callback_data: `run:${s.id}:${i - 1}` });
  row.push(i < s.steps.length - 1 ? { text: "Next ▶️", callback_data: `run:${s.id}:${i + 1}` } : { text: "✅ Done", callback_data: `done:${s.id}` });
  return [row];
}

/** Everything saved, grouped by topic. */
export function savedList(saves: Save[]): string {
  if (!saves.length) return "Nothing saved yet. Share a TikTok to me: tap <b>Share</b> in TikTok, then <b>Telegram</b>, then me.";
  const groups = new Map<string, Save[]>();
  for (const s of saves) {
    const topic = (s.topic.split(",")[0] ?? "").trim() || "Other";
    groups.set(topic, [...(groups.get(topic) ?? []), s]);
  }
  const out: string[] = [`<b>Your saves</b> (${saves.length})`];
  for (const [topic, list] of groups) {
    out.push("", `<b>${escapeHtml(topic)}</b>`, ...list.slice(0, 15).map((s) => `• ${escapeHtml(s.title)} <i>(${SAVE_TYPE_LABEL[s.type]})</i>`));
  }
  out.push("", "Ask about any of them, or say “start the …” to run a drill.");
  return out.join("\n");
}

/** An answer plus where it came from. */
export function answerText(text: string, sources: Save[]): string {
  const from = sources.length ? `📌 <i>From your save${sources.length > 1 ? "s" : ""}: ${sources.map((s) => escapeHtml(s.title)).join(", ")}</i>\n\n` : "";
  return from + mdToHtml(text);
}

export function goalButtons(currentGoal: string, offer: { switchTo: string; both: string }): InlineButton[][] {
  const cut = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
  const rows: InlineButton[][] = [[{ text: `Keep: ${cut(currentGoal)}`, callback_data: "goal:keep" }]];
  if (offer.switchTo) rows.push([{ text: `Switch: ${cut(offer.switchTo)}`, callback_data: "goal:switch" }]);
  if (offer.both) rows.push([{ text: `Do both: ${cut(offer.both)}`, callback_data: "goal:both" }]);
  return rows;
}
