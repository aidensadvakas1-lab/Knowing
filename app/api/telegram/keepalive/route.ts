/**
 * GET /api/telegram/keepalive
 *
 * Vercel calls this once a day (vercel.json). It makes one tiny read from
 * Supabase, because Supabase's free plan pauses a project after a week with
 * no activity, and a paused database means the bot stops working. If
 * CRON_SECRET is set in Vercel, only Vercel's own cron calls are accepted.
 */
import { secretMatches } from "@/lib/bot/handle";
import { SupabaseStore } from "@/lib/bot/store";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const cron = process.env.CRON_SECRET;
  if (cron && !secretMatches(request.headers.get("authorization") ?? "", `Bearer ${cron}`)) return apiError("unauthorized", "Only Vercel's cron may call this.");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return apiError("not_configured", "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  try {
    await new SupabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY).hasUser(0);
    return Response.json({ ok: true, at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError("upstream_error", error instanceof Error ? error.message.slice(0, 200) : "Supabase didn't answer.");
  }
}
