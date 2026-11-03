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
import { MODELS } from "../constants";
import { PACK_SIZES } from "./shop";
import type { Pack } from "./types";

/** Dollars per million tokens, from Anthropic's price list. */
export const PRICES = {
  sonnet: { input: 2, output: 10 },
  haiku: { input: 0.1, output: 0.5 },
} as const;

/**
 * Dollars per million tokens for each model the bot might be set to use
 * (KNOWING_WATCH_MODEL, KNOWING_BOT_MODEL...), from Anthropic's price list.
 * A model not listed is priced like the most expensive one, so switching to
 * a stronger model raises prices instead of quietly selling at a loss.
 */
const MODEL_PRICES: Array<[RegExp, { input: number; output: number }]> = [
  [/haiku-5-5/, PRICES.haiku],
  [/sonnet-5(-5)?(\b|$)/, PRICES.sonnet],
  [/opus-5-5/, { input: 4, output: 20 }],
  [/opus-5(\b|$)|opus-4-[678]/, { input: 5, output: 25 }],
];
const MOST_EXPENSIVE = { input: 15, output: 75 };

/** What a model costs. Haiku 5.5 costs 5 times more on a prompt over 100K tokens. */
export function priceOf(model: string, inputTokens = 0): { input: number; output: number } {
  const price = MODEL_PRICES.find(([match]) => match.test(model))?.[1] ?? MOST_EXPENSIVE;
  return price === PRICES.haiku && inputTokens > 100_000 ? { input: 0.5, output: 2.5 } : price;
}
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
/** The screen reader's instructions (screen.ts SCREEN_TEXT_PROMPT), in tokens, with room to spare. */
export const READ_PROMPT_TOKENS = 500;

// Fix something / Add what it says (brain.rewrite), counted as a question
export const REWRITE_TEXT_CHARS = 30_000;
export const REWRITE_MAX_TOKENS = 4_000;

// Answering (prompts.ts buildAskSystem, brain.ts answer)
/** Most characters in the answer's instructions, including their saves, facts and earlier chats. */
export const ASK_SYSTEM_CHARS = 32_000;
/** Most characters of recent chat sent along, newest kept. Older chats come back through search. */
export const HISTORY_CHARS = 7_500;
/** Most characters of their message that's read. */
export const QUESTION_CHARS = 4_000;
/** Most tokens an answer may use, thinking included. Most answers use under 1,500. */
export const ANSWER_MAX_TOKENS = 4_000;
/** Only the first this many seconds of a voice question are heard. Most are under 15. */
export const VOICE_MAX_SECONDS = 60;

// The wrap-up after a scroll session (only once a sweep runs), covering at least 3 videos (wrapup.ts WRAP_MIN)
export const WRAPUP_TEXT_CHARS = 30_000;
export const WRAPUP_MAX_TOKENS = 1_500;
const WRAPUP_MIN_VIDEOS = 3;

/** Embeddings for search, priced in hundredths of a cent; a generous allowance per video or question. */
const SMALL_CALLS = 0.001;

/** Dollars for one call at its limits, at the price of the model that's set. */
const callCost = (model: string, inputTokens: number, outputTokens: number) => {
  const price = priceOf(model, inputTokens);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};

/** A call plus the cheap model's second look, in case a safety filter blocks it by mistake. */
const withFallback = (model: string, inputTokens: number, outputTokens: number) => callCost(model, inputTokens, outputTokens) + callCost(MODELS.fallback, inputTokens, outputTokens);

const textTokens = (chars: number) => Math.ceil(chars * TOKENS_PER_CHAR);
/** One frame plus its "Frame 3, at 0:12:" label. */
const FRAME_TOKENS = Math.ceil(FRAME_PIXELS / 750) + 10;

/** The most one video can cost, in dollars. */
export function worstVideoCost(): number {
  const read = callCost(MODELS.read, SCAN_MAX * FRAME_TOKENS + READ_PROMPT_TOKENS, READ_MAX_TOKENS);
  const watch = withFallback(MODELS.watch, FRAME_COUNT * FRAME_TOKENS + textTokens(WATCH_TEXT_CHARS), WATCH_MAX_TOKENS);
  const hear = (MAX_SECONDS / 60) * TRANSCRIBE_PER_MINUTE;
  return read + watch + hear + wrapUpShare() + SMALL_CALLS;
}

/** Each video's share of the most a scroll's wrap-up can cost (one wrap-up needs at least 3 videos). It runs later, so Knowing Plus adds it to each video. */
export function wrapUpShare(): number {
  return withFallback(MODELS.bot, textTokens(WRAPUP_TEXT_CHARS), WRAPUP_MAX_TOKENS) / WRAPUP_MIN_VIDEOS;
}

/** The most one question can cost, in dollars: an answer, or a Fix / Add what it says, either one asked by voice. */
export function worstQuestionCost(): number {
  const answer = withFallback(MODELS.bot, textTokens(ASK_SYSTEM_CHARS + HISTORY_CHARS + QUESTION_CHARS), ANSWER_MAX_TOKENS);
  // Fix something and Add what it says use the watching model.
  const rewrite = withFallback(MODELS.watch, textTokens(REWRITE_TEXT_CHARS), REWRITE_MAX_TOKENS);
  const voice = (VOICE_MAX_SECONDS / 60) * TRANSCRIBE_PER_MINUTE;
  return Math.max(answer, rewrite) + voice + SMALL_CALLS;
}

/** The most a bundle can cost, in dollars: every video and every question at its worst. */
export function worstPackCost(pack: { videos: number; questions: number }): number {
  return pack.videos * worstVideoCost() + pack.questions * worstQuestionCost();
}

/** Stars a bundle sells for: enough that its worst case uses at most SAFETY of the payout, rounded up to a multiple of 50. */
export function packPrice(pack: { videos: number; questions: number }): number {
  return Math.ceil(worstPackCost(pack) / (PAYOUT_PER_STAR * SAFETY) / 50) * 50;
}

/** Every bundle on sale with its price, smallest first. */
export function pricedPacks(): Pack[] {
  return PACK_SIZES.map((size) => ({ ...size, stars: packPrice(size) }));
}

/**
 * What a month of Knowing Plus may really cost before it stops (plan.ts), in
 * dollars: SAFETY of what its Stars pay out. Its use is measured, not guessed
 * (meter.ts), so one plan can never cost more than it brings in, even used to
 * the max every day. Only the request already running when it's reached can go
 * past it, and that's far smaller than the other 15%.
 */
export function planBudget(stars: number): number {
  return stars * PAYOUT_PER_STAR * SAFETY;
}
