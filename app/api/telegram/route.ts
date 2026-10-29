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
import { timingSafeEqual } from "node:crypto";
import { createBrain } from "@/lib/bot/brain";
import { handleUpdate, parseAllowed, type Deps, type Update } from "@/lib/bot/handle";
import { createMedia } from "@/lib/bot/media";
import { createEmbedder, SupabaseRetriever } from "@/lib/bot/rag-supabase";
import { SupabaseStore } from "@/lib/bot/store";
import { Telegram } from "@/lib/bot/telegram";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"] as const;

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  };
  after(() => handleUpdate(update, deps).catch((error) => console.error("Telegram update failed", error)));
  return new Response("ok");
}
