/**
 * The weekly flashback: one short message on Sunday evening for people who
 * turned it on. If they saved videos that week it recaps them by folder and
 * brings back one from about a month ago; if not, it brings back a few older
 * ones, spaced out (about a week, a month and three months old), so nothing
 * they saved is forgotten.
 *
 * It's built from what's saved, with no AI call, so it costs nothing. It's off
 * until they turn it on (offered once, at the start), goes out at most once a
 * week however often the sweep runs, and pauses after QUIET_LIMIT in a row with
 * no message back, so it never turns into spam.
 */
import { folders } from "./folders";
import { escapeHtml, linkedTitle } from "./format";
import type { Deps } from "./handle";
import type { DigestState, InlineButton, Save } from "./types";

const DAY = 86_400_000;
/** Sunday, in UTC. */
export const DIGEST_DAY = 0;
/** Flashbacks in a row with no message back before they pause (until the person writes again). */
export const QUIET_LIMIT = 3;
/** Most of this week's videos listed by name. */
const WEEK_LISTED = 5;

export const OFFER_TEXT = `One more thing: want a <b>weekly flashback</b>? Every Sunday I'll send a short note with what you saved that week, or a few older videos worth another look. It stays off unless you turn it on.`;
export const OFFER_BUTTONS: InlineButton[][] = [[{ text: "Turn it on", callback_data: "digest:on" }, { text: "No thanks", callback_data: "digest:no" }]];
export const ON_TEXT = "Weekly flashback is on. It comes Sunday evenings (around 17:00 UTC). /digest off stops it any time.";
export const OFF_TEXT = "Weekly flashback is off. /digest on turns it back on any time.";

/** "a week ago", "3 weeks ago", "a month ago", "4 months ago". */
export function ageText(days: number): string {
  if (days < 11) return "a week ago";
  if (days < 18) return "2 weeks ago";
  if (days < 25) return "3 weeks ago";
  if (days < 46) return "a month ago";
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return "over a year ago";
}

const ageDays = (s: Save, now: number) => (now - Date.parse(s.createdAt)) / DAY;

/** For each target age (in days), the saved video closest to it, each used once. As weeks pass, different ones come up. */
export function spacedPicks(saves: Save[], now: number, targets: number[]): Save[] {
  const picks: Save[] = [];
  for (const target of targets) {
    const best = saves
      .filter((s) => !picks.includes(s))
      .sort((a, b) => Math.abs(ageDays(a, now) - target) - Math.abs(ageDays(b, now) - target))[0];
    if (best) picks.push(best);
  }
  return picks;
}

/** This week's flashback for someone with these saves (newest first), or null when there's nothing to show. */
export function flashback(saves: Save[], now = Date.now()): { html: string; buttons: InlineButton[][] } | null {
  if (!saves.length) return null;
  const week = saves.filter((s) => now - Date.parse(s.createdAt) < 7 * DAY);
  const older = saves.filter((s) => !week.includes(s));
  const lines = ["🧠 <b>Weekly flashback</b>", ""];
  const shown: Save[] = [];
  if (week.length) {
    const byFolder = folders(week).map((f) => `${escapeHtml(f.name)} ${f.saves.length}`).join(", ");
    lines.push(`You saved ${week.length} video${week.length === 1 ? "" : "s"} this week (${byFolder}):`);
    shown.push(...week.slice(0, WEEK_LISTED));
    lines.push(...shown.map((s) => `• ${linkedTitle(s)}`));
    if (week.length > WEEK_LISTED) lines.push(`…and ${week.length - WEEK_LISTED} more in /folders.`);
    const back = spacedPicks(older, now, [30])[0];
    if (back) {
      lines.push("", `<b>From ${ageText(ageDays(back, now))}:</b> ${linkedTitle(back)}`);
      shown.push(back);
    }
  } else {
    const picks = spacedPicks(older, now, [7, 30, 90]);
    lines.push("Worth another look:");
    lines.push(...picks.map((s) => `• ${linkedTitle(s)} <i>(saved ${ageText(ageDays(s, now))})</i>`));
    shown.push(...picks);
  }
  lines.push("", "Tap one for its notes, or ask me anything about them.");
  const buttons: InlineButton[][] = shown.slice(0, 4).map((s) => [{ text: s.title.slice(0, 40), callback_data: `show:${s.id}` }]);
  buttons.push([
    { text: "📂 Your folders", callback_data: "folders:new" },
    { text: "Turn these off", callback_data: "digest:stop" },
  ]);
  return { html: lines.join("\n"), buttons };
}

/** The person blocked the bot or deleted their account, so nothing can reach them. */
const unreachable = (error: unknown) => /\b403\b|blocked|deactivated|chat not found/i.test(error instanceof Error ? error.message : String(error));

/**
 * Send this week's flashbacks (GET /api/telegram/digest, Vercel cron on
 * Sundays). Only runs on Sunday (UTC), and each person gets at most one a week,
 * so calling it again or by hand sends nothing twice. Returns how many went out.
 */
export async function sendFlashbacks(deps: Pick<Deps, "tg" | "store" | "alert">, now = Date.now()): Promise<number> {
  if (new Date(now).getUTCDay() !== DIGEST_DAY) return 0;
  let sent = 0;
  for (const { id, digest, active } of await deps.store.listDigestUsers()) {
    if (digest.sent && now - Date.parse(digest.sent) < 6 * DAY) continue;
    // Any message from them since the last one means they're around, so the quiet count starts over.
    const back = !digest.sent || Date.parse(active) > Date.parse(digest.sent);
    const quiet = back ? 0 : digest.quiet;
    if (quiet >= QUIET_LIMIT) continue;
    try {
      const message = flashback(await deps.store.listSaves(id), now);
      if (!message) continue;
      const next: DigestState = { ...digest, sent: new Date(now).toISOString(), quiet: quiet + 1 };
      // Marked sent first, so an overlapping run can't send it twice.
      await deps.store.saveDigest(id, next);
      await deps.tg.sendMessage(id, message.html, message.buttons);
      sent += 1;
    } catch (error) {
      if (unreachable(error)) {
        await deps.store.saveDigest(id, { ...digest, on: false }).catch(() => {});
        continue;
      }
      await deps.alert(`Weekly flashback failed for ${id}: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  }
  return sent;
}
