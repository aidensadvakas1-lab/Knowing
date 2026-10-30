/**
 * The wrap-up after a scroll session. Videos saved less than SITTING_GAP_MS
 * apart make one sitting. Once someone has stopped for that long, a sweep
 * (GET /api/telegram/wrapup, which Supabase cron calls every 5 minutes)
 * sends one short message on what they kept and how it fits with the rest.
 *
 * It only ever follows something the person just did, so it never pings
 * anyone out of the blue.
 *
 * Which videos were in the sitting comes from the saves' own times, not a
 * list on the user row: several videos are often being watched at once, and
 * a list written by each of them would lose some.
 */
import { mdToHtml } from "./format";
import type { Deps } from "./handle";
import type { Save } from "./types";

/** A sitting ends after this long without a share, and the wrap-up goes out then. */
export const SITTING_GAP_MS = 15 * 60_000;
/** Fewer videos than this get no wrap-up: each already had its own reply. */
export const WRAP_MIN = 3;
/** A sitting this old is dropped without a wrap-up (say the sweep was off), since it would arrive out of nowhere. */
export const STALE_MS = 3 * 60 * 60_000;
/** Most videos one wrap-up covers. */
const MAX_KEPT = 30;

/** The newest run of saves made less than SITTING_GAP_MS apart, oldest first. `saves` is newest first. */
export function lastSitting(saves: Save[]): Save[] {
  const run: Save[] = [];
  for (const save of saves) {
    const newer = run.at(-1);
    if (newer && Date.parse(newer.createdAt) - Date.parse(save.createdAt) >= SITTING_GAP_MS) break;
    run.push(save);
    if (run.length >= MAX_KEPT) break;
  }
  return run.reverse();
}

/** Send the wrap-up for every sitting that has gone quiet. Returns how many were sent. */
export async function sendWrapUps(deps: Pick<Deps, "tg" | "store" | "brain" | "alert">, now = Date.now()): Promise<number> {
  let sent = 0;
  for (const user of await deps.store.listOpenSittings()) {
    const last = user.sitting?.last ?? "";
    const quietFor = now - Date.parse(last);
    if (!(quietFor >= SITTING_GAP_MS)) continue;
    // Claim it before sending, so it goes out once even if two sweeps overlap or they shared again just now.
    if (!(await deps.store.closeSitting(user.id, last)) || quietFor > STALE_MS) continue;
    try {
      const saves = await deps.store.listSaves(user.id);
      const kept = lastSitting(saves);
      if (kept.length < WRAP_MIN) continue;
      const text = await deps.brain.wrapUp({ kept, others: saves.filter((s) => !kept.includes(s)), facts: user.facts });
      const buttons = kept.slice(0, 6).map((s) => [{ text: s.title.slice(0, 40), callback_data: `show:${s.id}` }]);
      await deps.tg.sendMessage(user.id, mdToHtml(text), buttons);
      sent += 1;
    } catch (error) {
      await deps.alert(`Wrap-up failed for ${user.id}: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  }
  return sent;
}
