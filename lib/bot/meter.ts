/**
 * Measures what one video or question really costs, in dollars, from what
 * each AI call reports it used. Knowing Plus (plan.ts) adds it up, so a plan
 * slows down and stops before it costs more than it pays. Everything a use
 * calls (watching, reading the screen, hearing, answering) is counted, however
 * deep it runs, because the meter follows the work through AsyncLocalStorage.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PLAN_MAX_SECONDS, priceOf, TRANSCRIBE_PER_MINUTE } from "./costs";

const meters = new AsyncLocalStorage<{ dollars: number }>();

/** Searches, embeddings and the like: tiny, and counted as one small amount. */
const SMALL_CALLS = 0.001;

/** Add dollars to the use that's running, if one is being measured. */
export function charge(dollars: number): void {
  const meter = meters.getStore();
  if (meter && Number.isFinite(dollars) && dollars > 0) meter.dollars += dollars;
}

interface ClaudeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** One Claude call, at its model's price (costs.ts priceOf). */
export function chargeClaude(model: string, usage: ClaudeUsage | null | undefined): void {
  const prompt = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  const price = priceOf(model, prompt);
  const input = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) * 1.25 + (usage?.cache_read_input_tokens ?? 0) * 0.1;
  charge((input * price.input + (usage?.output_tokens ?? 0) * price.output) / 1_000_000);
}

/** Hearing `seconds` of audio. An unknown length counts as the longest there can be. */
export function chargeAudio(seconds: number): void {
  const heard = seconds > 0 ? Math.min(seconds, PLAN_MAX_SECONDS) : PLAN_MAX_SECONDS;
  charge((heard / 60) * TRANSCRIBE_PER_MINUTE);
}

/** Run `work`, then hand what it cost to `done`, even if it threw. */
export async function metered<T>(work: () => Promise<T>, done: (dollars: number) => Promise<void>): Promise<T> {
  const meter = { dollars: SMALL_CALLS };
  try {
    return await meters.run(meter, work);
  } finally {
    await done(meter.dollars).catch((error) => console.error("Recording a cost failed", error));
  }
}

/** What `work` cost, in dollars. */
export async function costOf(work: () => Promise<unknown>): Promise<number> {
  let dollars = 0;
  await metered(work, async (d) => void (dollars = d));
  return dollars;
}
