/**
 * The bot's real services and settings, built from Vercel's environment
 * variables. Shared by the Telegram webhook and the Instagram webhook, so both
 * see the same limits, invite key and alerts.
 */
import { createHash } from "node:crypto";
import { createBrain } from "./brain";
import { pricedPacks } from "./costs";
import { inviteCode, parseAllowed, type Deps } from "./handle";
import { createMedia } from "./media";
import { createEmbedder, SupabaseRetriever } from "./rag-supabase";
import { SupabaseStore } from "./store";
import { Telegram } from "./telegram";

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

/** Settings the bot can't run without. */
export const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"] as const;

/** The REQUIRED settings that aren't set. */
export const missingSettings = () => REQUIRED.filter((k) => !process.env[k]);

/** Everything the bot needs, from the environment. Check missingSettings() first. */
export function createDeps(): Deps {
  const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN!);
  const allowed = parseAllowed(process.env.TELEGRAM_ALLOWED_USERS);
  // The owner is KNOWING_OWNER_ID, or else the first allowed user.
  const owner = positive(process.env.KNOWING_OWNER_ID, [...allowed][0] ?? 0);
  const code = inviteCode(process.env.TELEGRAM_WEBHOOK_SECRET!, process.env.KNOWING_INVITE_CODE);
  return {
    tg,
    store: new SupabaseStore(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!),
    brain: createBrain(),
    media: createMedia((fileId) => tg.fileUrl(fileId), { instagram: instagramAccount(), metaToken: metaAppToken() }),
    retriever: new SupabaseRetriever(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, createEmbedder()),
    isAllowed: (id) => allowed.has(id),
    ownerId: owner,
    invite: {
      code,
      spots: positive(process.env.KNOWING_INVITE_SPOTS, INVITE_SPOTS),
      // Signs everyone's own /invite link and /instagram code, so nobody can make one up for someone else.
      key: createHash("sha256").update(`knowing-referral:${process.env.TELEGRAM_WEBHOOK_SECRET}`).digest("base64url"),
      link: async (start = code) => `https://t.me/${await tg.username()}?start=${start}`,
    },
    packs: packsSetting(process.env.KNOWING_PACK_STARS),
    limits: {
      videos: positive(process.env.KNOWING_FREE_VIDEOS ?? process.env.KNOWING_DAILY_VIDEOS, FREE_VIDEOS),
      questions: positive(process.env.KNOWING_FREE_QUESTIONS ?? process.env.KNOWING_DAILY_QUESTIONS, FREE_QUESTIONS),
    },
    async alert(text) {
      if (!owner || Date.now() - lastAlert < ALERT_GAP_MS) return;
      lastAlert = Date.now();
      await tg.sendMessage(owner, `<b>Knowing alert</b>\n${text.replace(/[<>&]/g, " ")}`);
    },
    instagram: instagramAccount(),
  };
}

/**
 * Knowing's Instagram username (INSTAGRAM_USERNAME, without @), but only once
 * the webhook can be trusted (INSTAGRAM_APP_SECRET or META_APP_SECRET is set). "" means sharing
 * Reels to it is off.
 */
export function instagramAccount(): string {
  const name = (process.env.INSTAGRAM_USERNAME ?? "").trim().replace(/^@/, "");
  return name && webhookSecrets().length ? name : "";
}

/** Meta's app token (META_APP_ID|META_APP_SECRET), for reading Instagram captions through oEmbed. "" when not set. */
export function metaAppToken(): string {
  const id = (process.env.META_APP_ID ?? "").trim();
  const secret = (process.env.META_APP_SECRET ?? "").trim();
  return id && secret ? `${id}|${secret}` : "";
}

/** The secrets Meta may sign webhook deliveries with: the Instagram app secret, and the Meta app secret if set. */
export function webhookSecrets(): string[] {
  return [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].map((s) => (s ?? "").trim()).filter(Boolean);
}
