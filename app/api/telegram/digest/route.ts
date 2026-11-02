/**
 * GET /api/telegram/digest
 *
 * Vercel calls this on Sunday evenings (vercel.json) to send the weekly
 * flashback to everyone who turned it on. Calling it again, by hand or on
 * another day, sends nothing twice: it only runs on Sundays (UTC) and each
 * person gets at most one a week. If CRON_SECRET is set in Vercel, only
 * Vercel's own cron calls are accepted.
 */
import { sendFlashbacks } from "@/lib/bot/digest";
import { parseAllowed, secretMatches } from "@/lib/bot/handle";
import { SupabaseStore } from "@/lib/bot/store";
import { Telegram } from "@/lib/bot/telegram";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

export async function GET(request: Request): Promise<Response> {
  const cron = process.env.CRON_SECRET;
  if (cron && !secretMatches(request.headers.get("authorization") ?? "", `Bearer ${cron}`)) return apiError("unauthorized", "Only Vercel's cron may call this.");
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) return apiError("not_configured", `The weekly flashback is missing settings: ${missing.join(", ")}.`);

  const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN!);
  // Problems go to the owner, like the webhook's alerts: KNOWING_OWNER_ID, or else the first allowed user.
  const owner = Number(process.env.KNOWING_OWNER_ID) || [...parseAllowed(process.env.TELEGRAM_ALLOWED_USERS)][0] || 0;
  try {
    const sent = await sendFlashbacks({
      tg,
      store: new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
      alert: async (text) => {
        console.error(text);
        if (owner) await tg.sendMessage(owner, `<b>Knowing alert</b>\n${text.slice(0, 500).replace(/[<>&]/g, " ")}`).catch(() => {});
      },
    });
    return Response.json({ ok: true, sent }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError("upstream_error", error instanceof Error ? error.message.slice(0, 200) : "The weekly flashback failed.");
  }
}
