/**
 * Saving Reels straight from Instagram, the official way.
 *
 * Instagram doesn't let a bot download a Reel from its link. But when someone
 * shares a Reel in a DM to an Instagram professional account, Instagram's
 * Messaging API hands that account the Reel itself (an `ig_reel` attachment
 * with a link to the video). So Knowing has its own Instagram account: people
 * link it to their Telegram once (/instagram gives a code to send it), then
 * tap Share on any Reel, pick Knowing, and it shows up watched in Telegram.
 *
 * The webhook is POST /api/instagram (lib/bot/handle.ts handleInstagram does
 * the rest). Setup is in docs/INSTAGRAM.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Attachment types that carry something to watch: Reels, Facebook reels shared on Instagram, videos, and shared posts. */
const WATCHABLE = new Set(["ig_reel", "reel", "video", "ig_post", "share", "image"]);

/** One DM sent to Knowing's Instagram account, with only what the bot reads. */
export interface InstagramEvent {
  /** Who sent it (their Instagram-scoped id). */
  sender: string;
  /** The message's id, so a delivery Meta repeats isn't saved twice. "" for a link opened with a ref. */
  mid: string;
  text: string;
  /** The first Reel, video or post in it. */
  media: { type: string; url: string; title: string } | null;
  /** The ref from an ig.me link they opened (ig.me/m/<account>?ref=...), if any. */
  ref: string;
}

/** The code someone sends Knowing on Instagram to link it to their Telegram. Lowercase, so a phone's autocorrect can't break it. */
export function linkCode(key: string, telegramId: number): string {
  return `know-${telegramId.toString(36)}-${sign(key, telegramId)}`;
}

/** The Telegram id a message's link code belongs to, or 0 if there isn't a real one in it. */
export function readLinkCode(key: string, text: string): number {
  const m = /\bknow-([0-9a-z]{1,13})-([0-9a-f]{8})\b/.exec(text.toLowerCase());
  if (!m || !key) return 0;
  const id = parseInt(m[1]!, 36);
  if (!Number.isSafeInteger(id) || id <= 0) return 0;
  return timingSafeEqual(Buffer.from(m[2]!), Buffer.from(sign(key, id))) ? id : 0;
}

const sign = (key: string, telegramId: number) => createHmac("sha256", key).update(`knowing-instagram:${telegramId}`).digest("hex").slice(0, 8);

/** True when the X-Hub-Signature-256 header is Meta's signature of this exact body, made with the app secret. */
export function signatureMatches(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * The DMs in one webhook delivery. Skips Knowing's own messages (echoes) and
 * anything that isn't a message or a link opened with a ref.
 */
export function instagramEvents(body: unknown): InstagramEvent[] {
  const root = obj(body);
  if (root.object !== "instagram") return [];
  const events: InstagramEvent[] = [];
  for (const entry of list(root.entry)) {
    for (const item of list(obj(entry).messaging)) {
      const m = obj(item);
      const sender = str(obj(m.sender).id);
      const message = obj(m.message);
      if (!sender || message.is_echo === true) continue;
      const ref = str(obj(m.referral).ref) || str(obj(obj(m.postback).referral).ref);
      const attachments = list(message.attachments).map(obj);
      const found = attachments.find((a) => WATCHABLE.has(str(a.type)) && str(obj(a.payload).url));
      const media = found ? { type: str(found.type), url: str(obj(found.payload).url), title: str(obj(found.payload).title).slice(0, 2_000) } : null;
      const text = str(message.text).slice(0, 2_000);
      if (text || media || ref) events.push({ sender, mid: str(message.mid), text, media, ref });
    }
  }
  return events;
}

/** A direct-message link to Knowing's Instagram account. */
export const dmLink = (username: string) => `https://ig.me/m/${encodeURIComponent(username)}`;
