/**
 * Link classification: figure out what a pasted URL points at so the learn
 * route can choose how to fetch its text.
 */

export type SourceType = "youtube" | "tiktok" | "web";

/** Parse a string as an http(s) URL. Returns null for anything else. */
export function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extract the 11-character video id from any common YouTube link shape:
 * watch?v=, youtu.be/, shorts/, embed/, live/. Returns null if none found.
 */
export function extractYouTubeId(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  let id: string | null = null;
  if (url.hostname.toLowerCase() === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (url.searchParams.get("v")) {
    id = url.searchParams.get("v");
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    id = match?.[1] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/** Classify a link as YouTube, TikTok, or a generic web page. */
export function detectSource(raw: string): SourceType | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  if (extractYouTubeId(raw)) return "youtube";
  if (TIKTOK_HOST.test(url.hostname)) return "tiktok";
  return "web";
}

/**
 * Refuse links to the server's own network (localhost, private ranges, cloud
 * metadata). This blocks the obvious server-side request forgery cases when
 * the learn route fetches a user-supplied URL.
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return false;
  }
  if (host.includes(":")) {
    // IPv6 literal: loopback, unspecified, unique-local, link-local, IPv4-mapped.
    return !(host === "::1" || host === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith("::ffff:"));
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

/** Suggest an item kind for a link so the Teach form can preselect it. */
export function suggestKind(raw: string): "tiktok" | "video" | "article" | null {
  const type = detectSource(raw);
  if (type === "tiktok") return "tiktok";
  if (type === "youtube") return "video";
  if (type === "web") return "article";
  return null;
}
