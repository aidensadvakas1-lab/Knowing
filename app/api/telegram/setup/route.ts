/**
 * GET /api/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET>
 *
 * Run once after deploying (open the URL in a browser): connects Telegram to
 * this app's webhook and sets the bot's commands menu and profile text.
 * Running it again is harmless.
 */
import { secretMatches } from "@/lib/bot/handle";
import { COMMANDS, DESCRIPTION, SHORT_DESCRIPTION } from "@/lib/bot/profile";
import { Telegram } from "@/lib/bot/telegram";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return apiError("not_configured", "Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
  const url = new URL(request.url);
  if (!secretMatches(url.searchParams.get("key") ?? "", secret)) return apiError("unauthorized", "Add ?key=<your TELEGRAM_WEBHOOK_SECRET> to the URL.");

  try {
    const me = await new Telegram(token).setup(`${url.origin}/api/telegram`, secret, { commands: COMMANDS, description: DESCRIPTION, shortDescription: SHORT_DESCRIPTION });
    return Response.json({ ok: true, bot: me.username ? `@${me.username}` : null, webhook: `${url.origin}/api/telegram`, next: "Open the bot in Telegram and send /start." });
  } catch (error) {
    return apiError("upstream_error", error instanceof Error ? error.message : "Telegram refused the setup.");
  }
}
