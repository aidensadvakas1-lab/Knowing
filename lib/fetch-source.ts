/**
 * Server-only: fetch the readable text behind a link the user taught.
 *
 * - YouTube: the video's caption transcript.
 * - TikTok: the post's caption and author via TikTok's public oEmbed API.
 *   (TikTok does not publish spoken transcripts, so the user can paste more.)
 * - Anything else: the page's main text.
 *
 * Every path fails soft: it returns a warning instead of throwing, so the user
 * can still save the item with their own notes.
 */
import "server-only";
import { YoutubeTranscript } from "youtube-transcript";
import { LIMITS } from "./constants";
import { extractTitle, htmlToText } from "./html-text";
import { detectSource, extractYouTubeId, isPublicHost, parseHttpUrl } from "./sources";
import type { SourceOrigin } from "./types";

export interface FetchedSource {
  text: string;
  title: string;
  origin: SourceOrigin;
  warning?: string;
}

const EMPTY = (warning: string): FetchedSource => ({ text: "", title: "", origin: "pasted", warning });

/** Fetch with a timeout and a size cap. Throws on network or HTTP errors. */
async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    redirect: "follow",
    signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
    headers: { "user-agent": "Mozilla/5.0 (compatible; KnowingBot/1.0)", ...init?.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const finalUrl = parseHttpUrl(res.url);
  if (finalUrl && !isPublicHost(finalUrl.hostname)) throw new Error("Redirected to a private address");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < LIMITS.fetchBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** YouTube: join the caption track into one block of text. */
async function fromYouTube(url: string): Promise<FetchedSource> {
  const id = extractYouTubeId(url);
  if (!id) return EMPTY("That YouTube link has no video id.");
  try {
    const parts = await YoutubeTranscript.fetchTranscript(id);
    const text = parts
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return EMPTY("This video has no captions. Paste your notes instead.");
    let title = "";
    try {
      const meta = JSON.parse(
        await fetchText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`),
      ) as { title?: string };
      title = meta.title ?? "";
    } catch {
      // The title is a nice-to-have; the transcript is what matters.
    }
    return { text: text.slice(0, LIMITS.itemContentChars), title, origin: "youtube-transcript" };
  } catch {
    return EMPTY("Couldn't get this video's transcript. Paste what it says instead.");
  }
}

/** TikTok: oEmbed gives the caption (as `title`) and the creator's name. */
async function fromTikTok(url: string): Promise<FetchedSource> {
  try {
    const raw = await fetchText(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    const meta = JSON.parse(raw) as { title?: string; author_name?: string };
    const caption = meta.title?.trim() ?? "";
    if (!caption) return EMPTY("This TikTok has no caption. Paste what it says.");
    const text = meta.author_name ? `Caption by @${meta.author_name}: ${caption}` : caption;
    return {
      text,
      title: "",
      origin: "tiktok-caption",
      warning: "Got the caption only. Add what the creator says for better advice.",
    };
  } catch {
    return EMPTY("Couldn't read this TikTok. Paste what it says instead.");
  }
}

/** Generic page: download HTML and keep the main text. */
async function fromWebPage(url: string): Promise<FetchedSource> {
  try {
    const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.5" } });
    const text = htmlToText(html);
    if (text.length < 200) return EMPTY("Couldn't find much text on that page. Paste the key parts.");
    return { text: text.slice(0, LIMITS.itemContentChars), title: extractTitle(html), origin: "web-page" };
  } catch {
    return EMPTY("Couldn't open that page. Paste what it says instead.");
  }
}

/** Fetch the text behind a link. Never throws. */
export async function fetchSource(rawUrl: string): Promise<FetchedSource> {
  const url = parseHttpUrl(rawUrl);
  if (!url) return EMPTY("That link doesn't look right.");
  if (!isPublicHost(url.hostname)) return EMPTY("That link points to a private address.");
  switch (detectSource(rawUrl)) {
    case "youtube":
      return fromYouTube(url.toString());
    case "tiktok":
      return fromTikTok(url.toString());
    default:
      return fromWebPage(url.toString());
  }
}
