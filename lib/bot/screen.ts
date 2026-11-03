/**
 * Reading the words on screen from frames taken about every second, so text
 * that flashes by between the 20 frames the watcher looks at (a command, a
 * link, a name) still gets saved. A cheap model does it: it only copies text.
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { formatTimestamp } from "../video-math";
import { MODELS } from "../constants";
import { getAnthropic } from "../server";
import { READ_MAX_TOKENS } from "./costs";
import { chargeClaude } from "./meter";

export const SCREEN_TEXT_PROMPT = `These are frames from one short video, in order, about a second apart. Copy out the text that appears on screen, word for word, so nothing someone might need later gets lost: commands and code, links and web addresses, @handles, names of apps, tools, packages, products and places, settings, numbers, amounts and prices, and captions or titles. Keep the exact spelling, capitals and symbols. Write each piece once, in the order it first appears, one per line. Skip the app's own buttons and counters (likes, comments, shares, follow) and anything you can't read clearly. If there's no text, write NONE.`;

/** Added when each frame is labeled with its time, so the text can be found again by when it showed up. */
export const SCREEN_TIMES_PROMPT = `Each frame is labeled with when it was taken. Start each line with the time its text first shows up, like "0:12 npm install firecrawl-mcp".`;

/** The longest screen text kept per video. */
const MAX_CHARS = 6_000;

/** The model's reply as text to keep: empty when it found none. */
export function cleanScreenText(raw: string): string {
  const text = raw.trim();
  return /^none\.?$/i.test(text) ? "" : text.slice(0, MAX_CHARS);
}

/**
 * Copy the on-screen text out of `frames` (base64 JPEGs). With `times` (one
 * per frame, in seconds) each line gets the time it first shows up. Throws on
 * API errors; the caller decides to go without.
 */
export async function readScreenText(frames: string[], times: number[] = []): Promise<string> {
  if (!frames.length) return "";
  const timed = times.length === frames.length;
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: timed ? `${SCREEN_TEXT_PROMPT}\n\n${SCREEN_TIMES_PROMPT}` : SCREEN_TEXT_PROMPT }];
  for (const [i, data] of frames.entries()) {
    if (timed) content.push({ type: "text", text: `At ${formatTimestamp(times[i] ?? 0)}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  }
  const response = await getAnthropic().messages.create(
    { model: MODELS.read, max_tokens: READ_MAX_TOKENS, output_config: { effort: "low" }, messages: [{ role: "user", content }] },
    // Watching has to fit in the webhook's minute, so this step never holds it up for long.
    { timeout: 25_000, maxRetries: 0 },
  );
  chargeClaude(MODELS.read, response.usage);
  if (response.stop_reason === "refusal") return "";
  return cleanScreenText(response.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
}
