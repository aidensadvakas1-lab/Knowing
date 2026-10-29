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
import { createBrain } from "@/lib/bot/brain";
import { handleUpdate, parseAllowed, secretMatches, type Deps, type Update } from "@/lib/bot/handle";
import { createMedia } from "@/lib/bot/media";
import { createEmbedder, SupabaseRetriever } from "@/lib/bot/rag-supabase";
import { SupabaseStore } from "@/lib/bot/store";
import { Telegram } from "@/lib/bot/telegram";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Defaults for the daily limits per user; override with KNOWING_DAILY_VIDEOS / KNOWING_DAILY_QUESTIONS. */
const DAILY_VIDEOS = 15;
const DAILY_QUESTIONS = 50;

/** At most one alert per few minutes per server instance, so a broken key doesn't flood the owner. */
const ALERT_GAP_MS = 5 * 60_000;
let lastAlert = 0;

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"] as const;

export async function POST(request: Request): Promise<Response> {
  const missing = REQUIRED.filter((k) => !process.env[k]);
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

  const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN!);
  const allowed = parseAllowed(process.env.TELEGRAM_ALLOWED_USERS);
  const deps: Deps = {
    tg,
    store: new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
    brain: createBrain(),
    media: createMedia((fileId) => tg.fileUrl(fileId)),
    retriever: new SupabaseRetriever(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, createEmbedder()),
    isAllowed: (id) => allowed.has(id),
    limits: { videos: positive(process.env.KNOWING_DAILY_VIDEOS, DAILY_VIDEOS), questions: positive(process.env.KNOWING_DAILY_QUESTIONS, DAILY_QUESTIONS) },
    async alert(text) {
      // The owner is KNOWING_OWNER_ID, or else the first allowed user.
      const owner = positive(process.env.KNOWING_OWNER_ID, [...allowed][0] ?? 0);
      if (!owner || Date.now() - lastAlert < ALERT_GAP_MS) return;
      lastAlert = Date.now();
      await tg.sendMessage(owner, `<b>Knowing alert</b>\n${text.replace(/[<>&]/g, " ")}`);
    },
  };
  after(() => handleUpdate(update, deps).catch((error) => console.error("Telegram update failed", error)));
  return new Response("ok");
}
