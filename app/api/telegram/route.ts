/**
 * POST /api/telegram
 *
 * Telegram's webhook for the Knowing bot. Answers Telegram right away, then
 * does the slow work (download, watch, answer) after the response, so
 * Telegram never times out and resends the update.
 *
 * Setup is in docs/TELEGRAM.md.
 */
import { createHash } from "node:crypto";
import { after } from "next/server";
import { createBrain } from "@/lib/bot/brain";
import { pricedPacks } from "@/lib/bot/costs";
import { PLAN } from "@/lib/bot/plan";
import { handleUpdate, inviteCode, parseAllowed, secretMatches, type Deps, type Update } from "@/lib/bot/handle";
import { createMedia } from "@/lib/bot/media";
import { createEmbedder, SupabaseRetriever } from "@/lib/bot/rag-supabase";
import { SupabaseStore } from "@/lib/bot/store";
import { Telegram } from "@/lib/bot/telegram";
import { apiError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Watching a video (download, frames, speech, on-screen text, then Claude) can take over a minute,
// and a 30-minute one on Knowing Plus a few. Vercel allows up to 300 seconds with Fluid compute, which new projects have on.
export const maxDuration = 300;

/**
 * Free videos and questions per person, given once (they don't refill). Override with
 * KNOWING_FREE_VIDEOS / KNOWING_FREE_QUESTIONS (the older KNOWING_DAILY_* names still work).
 */
const FREE_VIDEOS = 5;
const FREE_QUESTIONS = 10;

/** How many people can join with the invite link; override with KNOWING_INVITE_SPOTS. */
const INVITE_SPOTS = 20;

/** At most one alert per few minutes per server instance, so a broken key doesn't flood the owner. */
const ALERT_GAP_MS = 5 * 60_000;
let lastAlert = 0;

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Pack prices come from their worst case (costs.ts), so none can sell at a loss. KNOWING_PACK_STARS=0 turns buying off. */
const packsSetting = (raw: string | undefined) => (raw?.trim() === "0" ? [] : pricedPacks());

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
  // The owner is KNOWING_OWNER_ID, or else the first allowed user.
  const owner = positive(process.env.KNOWING_OWNER_ID, [...allowed][0] ?? 0);
  const code = inviteCode(process.env.TELEGRAM_WEBHOOK_SECRET!, process.env.KNOWING_INVITE_CODE);
  const deps: Deps = {
    tg,
    store: new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
    brain: createBrain(),
    media: createMedia((fileId) => tg.fileUrl(fileId)),
    retriever: new SupabaseRetriever(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, createEmbedder()),
    isAllowed: (id) => allowed.has(id),
    ownerId: owner,
    invite: {
      code,
      spots: positive(process.env.KNOWING_INVITE_SPOTS, INVITE_SPOTS),
      // Signs everyone's own /invite link, so nobody can make one up for someone else.
      key: createHash("sha256").update(`knowing-referral:${process.env.TELEGRAM_WEBHOOK_SECRET}`).digest("base64url"),
      link: async (start = code) => `https://t.me/${await tg.username()}${start ? `?start=${start}` : ""}`,
    },
    // Public unless KNOWING_PUBLIC=0. KNOWING_PUBLIC_SPOTS caps how many people can join (unset = no limit).
    open: process.env.KNOWING_PUBLIC?.trim() === "0" ? undefined : { cap: positive(process.env.KNOWING_PUBLIC_SPOTS, 0) },
    packs: packsSetting(process.env.KNOWING_PACK_STARS),
    // Knowing Plus is on sale with the refill; KNOWING_PLAN=0 stops new sign-ups.
    plan: process.env.KNOWING_PACK_STARS?.trim() === "0" || process.env.KNOWING_PLAN?.trim() === "0" ? undefined : PLAN,
    limits: {
      videos: positive(process.env.KNOWING_FREE_VIDEOS ?? process.env.KNOWING_DAILY_VIDEOS, FREE_VIDEOS),
      questions: positive(process.env.KNOWING_FREE_QUESTIONS ?? process.env.KNOWING_DAILY_QUESTIONS, FREE_QUESTIONS),
    },
    async alert(text) {
      if (!owner || Date.now() - lastAlert < ALERT_GAP_MS) return;
      lastAlert = Date.now();
      await tg.sendMessage(owner, `<b>Knowing alert</b>\n${text.replace(/[<>&]/g, " ")}`);
    },
  };
  after(() => handleUpdate(update, deps).catch((error) => console.error("Telegram update failed", error)));
  return new Response("ok");
}
