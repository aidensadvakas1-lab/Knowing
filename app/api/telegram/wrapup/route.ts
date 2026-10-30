/**
 * GET /api/telegram/wrapup?key=<KNOWING_CRON_SECRET>
 *
 * Sends the wrap-up for every scroll session that has gone quiet. Supabase
 * calls it every 5 minutes (setup in docs/TELEGRAM.md). Running it
 * more often or by hand is harmless: each sitting is wrapped up once.
 */
import { createBrain } from "@/lib/bot/brain";
import { secretMatches } from "@/lib/bot/handle";
import { SupabaseStore } from "@/lib/bot/store";
import { Telegram } from "@/lib/bot/telegram";
import { sendWrapUps } from "@/lib/bot/wrapup";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REQUIRED = ["KNOWING_CRON_SECRET", "TELEGRAM_BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"] as const;

export async function GET(request: Request): Promise<Response> {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) return apiError("not_configured", `Wrap-ups are missing settings: ${missing.join(", ")}.`);
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!secretMatches(key, process.env.KNOWING_CRON_SECRET!)) return apiError("unauthorized", "Add ?key=<your KNOWING_CRON_SECRET> to the URL.");

  const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN!);
  const sent = await sendWrapUps({
    tg,
    store: new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
    brain: createBrain(),
    alert: async (text) => console.error(text),
  });
  return Response.json({ ok: true, sent });
}
