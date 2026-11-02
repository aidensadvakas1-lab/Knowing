/**
 * POST /api/telegram
 *
 * Telegram's webhook for the Knowing bot. Answers Telegram right away, then
 * does the slow work (download, watch, answer) after the response, so
 * Telegram never times out and resends the update.
 *
 * Setup is in docs/TELEGRAM.md.
 */
import { after } from "next/server";
import { createDeps, missingSettings } from "@/lib/bot/deps";
import { handleUpdate, secretMatches, type Update } from "@/lib/bot/handle";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Watching a video (download, frames, speech, on-screen text, then Claude) can take over a minute.
// Vercel's Hobby plan allows up to 300 seconds with Fluid compute, which new projects have on.
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const missing = missingSettings();
  if (missing.length) return apiError("not_configured", `The bot is missing settings: ${missing.join(", ")}.`);
  if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token") ?? "", process.env.TELEGRAM_WEBHOOK_SECRET!)) {
    return apiError("unauthorized", "Wrong webhook secret.");
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return apiError("bad_request", "The request body must be JSON.");
  }

  const deps = createDeps();
  after(() => handleUpdate(update, deps).catch((error) => console.error("Telegram update failed", error)));
  return new Response("ok");
}
