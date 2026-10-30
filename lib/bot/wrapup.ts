/**
 * The wrap-up after a scroll session. Videos shared within a few minutes of
 * each other make one sitting; once someone stops for a while, a sweep
 * (GET /api/telegram/wrapup, called every few minutes by Supabase cron)
 * sends one short message on what they kept and how it connects.
 *
 * It only ever answers something the person just did, so it never pings
 * anyone out of the blue.
 */
import { mdToHtml } from "./format";
import type { Deps } from "./handle";
import type { BotUser } from "./types";

/** A share more than this long after the last one starts a new sitting. */
export const SITTING_GAP_MS = 30 * 60_000;
/** How long after the last share the wrap-up goes out. */
export const QUIET_MS = 15 * 60_000;
/** Fewer videos than this in a sitting get no wrap-up: each already had its own reply. */
export const WRAP_MIN = 3;

/** Add a new save to the user's current sitting, or start a new one. */
export function trackSitting(user: BotUser, saveId: string, now: number): void {
  const open = user.sitting && now - Date.parse(user.sitting.last) < SITTING_GAP_MS;
  user.sitting = { last: new Date(now).toISOString(), ids: [...(open ? user.sitting!.ids : []), saveId].slice(-30) };
}

/** Send the wrap-up for every sitting that has gone quiet. Returns how many were sent. */
export async function sendWrapUps(deps: Pick<Deps, "tg" | "store" | "brain" | "alert">, now = Date.now()): Promise<number> {
  let sent = 0;
  for (const user of await deps.store.listOpenSittings()) {
    const sitting = user.sitting;
    if (!sitting || now - Date.parse(sitting.last) < QUIET_MS) continue;
    user.sitting = null;
    await deps.store.saveUser(user);
    if (sitting.ids.length < WRAP_MIN) continue;
    try {
      const saves = await deps.store.listSaves(user.id);
      const kept = sitting.ids.map((id) => saves.find((s) => s.id === id)).filter((s) => s !== undefined);
      if (kept.length < WRAP_MIN) continue;
      const text = await deps.brain.wrapUp({ kept, others: saves.filter((s) => !sitting.ids.includes(s.id)), facts: user.facts });
      const buttons = kept.slice(0, 6).map((s) => [{ text: s.title.slice(0, 40), callback_data: `show:${s.id}` }]);
      await deps.tg.sendMessage(user.id, mdToHtml(text), buttons);
      sent += 1;
    } catch (error) {
      await deps.alert(`Wrap-up failed for ${user.id}: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  }
  return sent;
}
