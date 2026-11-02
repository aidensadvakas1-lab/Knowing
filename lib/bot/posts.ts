/**
 * The words of a post from an app that won't let the bot download its video
 * (X, Instagram), read through each app's official embed service (oEmbed), so
 * a link can be saved right away instead of turned away. The video itself can
 * be added later: the next video file sent fills in the same save.
 *
 * X's embed service is free and needs no key. Instagram's needs a Meta app
 * (META_APP_ID and META_APP_SECRET, with the oEmbed Read feature); without one,
 * Instagram links just say how to get the Reel watched.
 */

const TIMEOUT_MS = 8_000;
const META_VERSION = "v26.0";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };

/** Plain text from a bit of embed HTML: tags dropped, entities decoded, spaces tidied. */
export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|blockquote|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === "#") {
        const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** What an X post says, from its embed: the text inside <p>, without the trailing pic.twitter.com link. */
export function xPostText(html: string): string {
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  return htmlText(p).replace(/\s*pic\.(twitter|x)\.com\/\S+$/i, "").trim();
}

/** An Instagram embed's caption, without the "View this post on Instagram" and "A post shared by" lines. */
export function instagramCaption(html: string): string {
  return htmlText(html)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^View this post on Instagram$/i.test(l) && !/^A post shared by\b/i.test(l))
    .join("\n")
    .trim();
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const field = (o: Record<string, unknown> | null, key: string) => (typeof o?.[key] === "string" ? (o[key] as string) : "");

/**
 * The words of an X or Instagram post, and who posted it, or empty strings
 * when it can't be read (deleted, private, or no Meta app for Instagram).
 */
export async function postText(url: string, platform: string, metaToken = ""): Promise<{ text: string; author: string }> {
  if (platform === "X") {
    const body = await getJson(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=true`);
    return { text: xPostText(field(body, "html")).slice(0, 4_000), author: field(body, "author_name").slice(0, 80) };
  }
  if (platform === "Instagram" && metaToken) {
    const body = await getJson(`https://graph.facebook.com/${META_VERSION}/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${encodeURIComponent(metaToken)}`);
    return { text: instagramCaption(field(body, "html")).slice(0, 4_000), author: "" };
  }
  return { text: "", author: "" };
}

/** A save's title for a post: who posted it and how it starts. */
export function postTitle(platform: string, text: string, author: string): string {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const start = firstLine.length > 60 ? `${firstLine.slice(0, 57).replace(/\s+\S*$/, "")}…` : firstLine;
  return (author ? `${author}: ${start}` : start || `${platform} post`).slice(0, 100);
}
