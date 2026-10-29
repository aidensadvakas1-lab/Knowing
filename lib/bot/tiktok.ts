/**
 * Turning a shared TikTok link into a video file.
 *
 * TikTok has no official download API, so this goes through a resolver
 * service (tikwm.com's free API by default, swappable with
 * KNOWING_TIKTOK_RESOLVER). It is the fragile part of the bot: when it fails,
 * the caller falls back to the caption from TikTok's public oEmbed endpoint.
 */
import { parseHttpUrl } from "../sources";

const DEFAULT_RESOLVER = "https://www.tikwm.com/api/";
const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;

/** The first http(s) link in a message, or null. */
export function findUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const raw = match[0].replace(/[).,!?]+$/, "");
  return parseHttpUrl(raw) ? raw : null;
}

export function isTikTok(url: string): boolean {
  const parsed = parseHttpUrl(url);
  return Boolean(parsed && TIKTOK_HOST.test(parsed.hostname));
}

export interface ResolvedTikTok {
  /** Direct MP4 link, when the post is a video. */
  videoUrl: string;
  /** Photo-mode posts are a list of images instead. */
  images: string[];
  caption: string;
  author: string;
  durationSec: number;
}

const absolute = (u: unknown, base: string): string => {
  if (typeof u !== "string" || !u) return "";
  try {
    return new URL(u, base).toString();
  } catch {
    return "";
  }
};

/** Read a tikwm-style response. Returns null when it doesn't describe a post. */
export function parseResolverResponse(json: unknown, base = DEFAULT_RESOLVER): ResolvedTikTok | null {
  if (!json || typeof json !== "object") return null;
  const { code, data } = json as { code?: unknown; data?: unknown };
  if (code !== 0 || !data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const author = d.author && typeof d.author === "object" ? (d.author as Record<string, unknown>) : {};
  const images = Array.isArray(d.images) ? d.images.map((x) => absolute(x, base)).filter(Boolean).slice(0, 10) : [];
  const videoUrl = images.length ? "" : absolute(d.play, base);
  if (!videoUrl && !images.length) return null;
  return {
    videoUrl,
    images,
    caption: typeof d.title === "string" ? d.title.trim() : "",
    author: typeof author.nickname === "string" ? author.nickname : "",
    durationSec: typeof d.duration === "number" && d.duration > 0 ? d.duration : 0,
  };
}

/** Ask the resolver for the post's video. Throws when it can't. */
export async function resolveTikTok(url: string, signal?: AbortSignal): Promise<ResolvedTikTok> {
  const base = process.env.KNOWING_TIKTOK_RESOLVER || DEFAULT_RESOLVER;
  const res = await fetch(`${base}?url=${encodeURIComponent(url)}&hd=0`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TikTok resolver answered ${res.status}`);
  const parsed = parseResolverResponse(await res.json().catch(() => null), base);
  if (!parsed) throw new Error("TikTok resolver couldn't read that post");
  return parsed;
}
