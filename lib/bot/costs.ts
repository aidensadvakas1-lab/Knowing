/**
 * The hard limits on every AI call the bot makes, and the most one video or
 * one question can cost because of them. A pack of extras is only safe to sell
 * when its worst case stays under what Telegram pays for it, and
 * tests/bot-costs.test.ts fails if a change ever breaks that.
 *
 * Text is counted at 2.5 characters a token, which is on the safe side for
 * English (closer to 4), Russian and code. Images are counted exactly: Claude
 * charges about one token per 750 pixels.
 */
import { PACK_SIZES } from "./shop";
import type { Pack, PackKind } from "./types";

/** Dollars per million tokens, from Anthropic's price list. */
export const PRICES = {
  sonnet: { input: 2, output: 10 },
  haiku: { input: 0.1, output: 0.5 },
} as const;
/** Speech to text (gpt-4o-mini-transcribe), dollars per minute of audio. */
export const TRANSCRIBE_PER_MINUTE = 0.003;
/** What Telegram pays the bot's owner per Star, in dollars. */
export const PAYOUT_PER_STAR = 0.013;
/** A pack's worst case may use at most this share of what it pays, so a dip in the payout rate still leaves a profit. */
export const SAFETY = 0.85;
/** Worst-case tokens per character of text. */
export const TOKENS_PER_CHAR = 0.4;

// Watching a video (media.ts, screen.ts, brain.ts)
/** Frames shown to Claude per video. Setups change every few seconds, so 8 missed whole placements. */
export const FRAME_COUNT = 20;
/** Most pixels in one frame. Upright and wide videos come out 540 by 960, like before; square ones a bit smaller. */
export const FRAME_PIXELS = 960 * 540;
/** Most frames read for on-screen text. About one a second for a one-minute video. */
export const SCAN_MAX = 60;
/** Only the first this many seconds of a video are watched and heard. */
export const MAX_SECONDS = 300;
/** Most characters of text sent with the frames (rules, caption, screen text, transcript, their saves). */
export const WATCH_TEXT_CHARS = 40_000;
/** Most tokens the watcher may write, thinking included. A save is about 1,500. */
export const WATCH_MAX_TOKENS = 6_000;
/** Most tokens the screen reader may write. */
export const READ_MAX_TOKENS = 4_000;

// Fix something / Add what it says (brain.rewrite), counted as a question
export const REWRITE_TEXT_CHARS = 30_000;
export const REWRITE_MAX_TOKENS = 4_000;

// Answering (prompts.ts buildAskSystem, brain.ts answer)
/** Most characters in the answer's instructions, including their saves, facts and earlier chats. */
export const ASK_SYSTEM_CHARS = 32_000;
/** Most characters of recent chat sent along, newest kept. */
export const HISTORY_CHARS = 10_000;
/** Most characters of their message that's read. */
export const QUESTION_CHARS = 4_000;
/** Most tokens an answer may use, thinking included. Most answers use under 1,500. */
export const ANSWER_MAX_TOKENS = 4_000;

// The wrap-up after a scroll session (only once a sweep runs), covering at least 3 videos (wrapup.ts WRAP_MIN)
export const WRAPUP_TEXT_CHARS = 30_000;
export const WRAPUP_MAX_TOKENS = 1_500;
const WRAPUP_MIN_VIDEOS = 3;

/** Embeddings for search, priced in hundredths of a cent; a generous allowance per video or question. */
const SMALL_CALLS = 0.001;

type Model = keyof typeof PRICES;

/** Dollars for one call at its limits. */
const callCost = (model: Model, inputTokens: number, outputTokens: number) => (inputTokens * PRICES[model].input + outputTokens * PRICES[model].output) / 1_000_000;

/** A Sonnet call plus the cheap model's second look, in case a safety filter blocks it by mistake. */
const withFallback = (inputTokens: number, outputTokens: number) => callCost("sonnet", inputTokens, outputTokens) + callCost("haiku", inputTokens, outputTokens);

const textTokens = (chars: number) => Math.ceil(chars * TOKENS_PER_CHAR);
/** One frame plus its "Frame 3, at 0:12:" label. */
const FRAME_TOKENS = Math.ceil(FRAME_PIXELS / 750) + 10;

/** The most one video can cost, in dollars. */
export function worstVideoCost(): number {
  const read = callCost("haiku", SCAN_MAX * FRAME_TOKENS + 300, READ_MAX_TOKENS);
  const watch = withFallback(FRAME_COUNT * FRAME_TOKENS + textTokens(WATCH_TEXT_CHARS), WATCH_MAX_TOKENS);
  const hear = (MAX_SECONDS / 60) * TRANSCRIBE_PER_MINUTE;
  const wrapUpShare = withFallback(textTokens(WRAPUP_TEXT_CHARS), WRAPUP_MAX_TOKENS) / WRAPUP_MIN_VIDEOS;
  return read + watch + hear + wrapUpShare + SMALL_CALLS;
}

/** The most one question can cost, in dollars: an answer, or a Fix / Add what it says. */
export function worstQuestionCost(): number {
  const answer = withFallback(textTokens(ASK_SYSTEM_CHARS + HISTORY_CHARS + QUESTION_CHARS), ANSWER_MAX_TOKENS);
  const rewrite = withFallback(textTokens(REWRITE_TEXT_CHARS), REWRITE_MAX_TOKENS);
  return Math.max(answer, rewrite) + SMALL_CALLS;
}

/** The most a pack of `count` can cost, in dollars. */
export function worstPackCost(kind: PackKind, count: number): number {
  return count * (kind === "videos" ? worstVideoCost() : worstQuestionCost());
}

/** Stars a pack sells for: enough that its worst case uses at most SAFETY of the payout, rounded up to a multiple of 50. */
export function packPrice(kind: PackKind, count: number): number {
  return Math.ceil(worstPackCost(kind, count) / (PAYOUT_PER_STAR * SAFETY) / 50) * 50;
}

/** Every pack on sale with its price, videos first, smallest first. */
export function pricedPacks(): Pack[] {
  return (["videos", "questions"] as const).flatMap((kind) => PACK_SIZES[kind].map((count) => ({ kind, count, stars: packPrice(kind, count) })));
}
