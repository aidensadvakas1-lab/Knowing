/**
 * Knowing Plus: a monthly Telegram Stars subscription that gives videos and
 * questions every day, instead of buying refills. Unused ones don't carry over.
 *
 * It can't sell at a loss: every video and question on the plan is measured
 * in real dollars (meter.ts), and once a month's use gets near what the plan
 * pays (costs.ts planBudget), the daily amount drops to a little, then stops
 * until it renews. Free ones and bought extras still work then. The terms say so.
 *
 * The plan lives in the wallet (bot_users.wallet), so it needs no SQL.
 * https://core.telegram.org/bots/api#createinvoicelink (subscription_period)
 */
import { planBudget } from "./costs";
import type { InlineButton, Invoice, PackKind, Plan } from "./types";

/** What the plan gives and costs. Aiden picked 5 videos + 10 questions a day. */
export interface PlanOffer {
  name: string;
  videos: number;
  questions: number;
  /** The daily amount once a month's use reaches PLAN_SLOW_AT of what it pays. */
  slowVideos: number;
  slowQuestions: number;
  /** Stars every 30 days. */
  stars: number;
}

export const PLAN: PlanOffer = { name: "Knowing Plus", videos: 5, questions: 10, slowVideos: 1, slowQuestions: 3, stars: 500 };

/** Telegram only takes 30 days for a subscription. */
export const PLAN_PERIOD_SECONDS = 2_592_000;
/** Share of the month's budget after which the plan slows down. */
export const PLAN_SLOW_AT = 0.7;
/** A renewal payment can land a little after the month ends; the plan keeps working meanwhile. */
const RENEWAL_GRACE_MS = 2 * 60 * 60 * 1_000;

export type PlanLevel = "full" | "slow" | "paused";

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** True while the paid month (plus a short wait for the renewal payment) lasts. */
export function planActive(plan: Plan | null | undefined, now = new Date()): plan is Plan {
  if (!plan) return false;
  const until = Date.parse(plan.until);
  return Number.isFinite(until) && now.getTime() < until + (plan.canceled ? 0 : RENEWAL_GRACE_MS);
}

/** How much of this month's budget is used: full, slowed down, or paused until it renews. */
export function planLevel(plan: Plan): PlanLevel {
  const budget = planBudget(plan.stars);
  if (plan.cost >= budget) return "paused";
  return plan.cost >= budget * PLAN_SLOW_AT ? "slow" : "full";
}

/** What the plan gives each day right now, after the cost guard. Everyone on it gets PLAN's amounts. */
export function planDaily(plan: Plan): Record<PackKind, number> {
  const level = planLevel(plan);
  if (level === "paused") return { videos: 0, questions: 0 };
  return level === "slow" ? { videos: PLAN.slowVideos, questions: PLAN.slowQuestions } : { videos: PLAN.videos, questions: PLAN.questions };
}

/** A new UTC day starts the counts again. */
function rollDay(plan: Plan, now: Date): void {
  const day = utcDay(now);
  if (plan.day === day) return;
  plan.day = day;
  plan.videos = 0;
  plan.questions = 0;
}

/** How many of these the plan has left today (0 when it isn't active). */
export function planLeft(plan: Plan | null | undefined, kind: PackKind, now = new Date()): number {
  if (!planActive(plan, now)) return 0;
  const used = plan.day === utcDay(now) ? plan[kind] : 0;
  return Math.max(0, planDaily(plan)[kind] - used);
}

/** Use one from today's plan. Changes `plan`; the caller saves it. False when there's none left today. */
export function usePlan(plan: Plan | null | undefined, kind: PackKind, now = new Date()): boolean {
  if (planLeft(plan, kind, now) < 1 || !plan) return false;
  rollDay(plan, now);
  plan[kind] += 1;
  return true;
}

/** Give one back to today's plan (a video that couldn't be saved). Changes `plan`. */
export function refundPlan(plan: Plan | null | undefined, kind: PackKind, now = new Date()): void {
  if (plan && plan.day === utcDay(now)) plan[kind] = Math.max(0, plan[kind] - 1);
}

/** "Dec 3" */
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "in 5 h" (or "in 40 min") until the counts start again at midnight UTC. */
export function untilReset(now = new Date()): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const minutes = Math.max(1, Math.ceil((midnight - now.getTime()) / 60_000));
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

/** "5 videos + 10 questions every day for 500 ⭐ a month" */
export const planDeal = (offer: PlanOffer) => `${offer.videos} videos + ${offer.questions} questions every day for ${offer.stars} ⭐ a month`;

/** The button that opens the plan's offer. */
export const planButton = (offer: PlanOffer): InlineButton => ({ text: `⭐ ${offer.name}: ${offer.videos} + ${offer.questions} a day, ${offer.stars} ⭐/month`, callback_data: "plan:get" });

/** What the plan says before they pay, so nothing about it is a surprise. */
export function planOfferText(offer: PlanOffer): string {
  return `<b>${offer.name}</b>
${offer.videos} videos and ${offer.questions} questions <b>every day</b>, for ${offer.stars} ⭐ a month.
It watches videos up to <b>30 minutes</b> long (5 without it).

• They start again every day at midnight UTC. Unused ones don't carry over.
• It renews every 30 days through Telegram. Cancel any time with /plan; it keeps working until the month ends.
• Fair use: if a month's use gets very heavy, it drops to ${offer.slowVideos} video and ${offer.slowQuestions} questions a day, and at most pauses until it renews. Your free ones and extras still work.

By paying you agree to the /terms.`;
}

export function planInvoice(offer: PlanOffer): Invoice {
  return {
    title: offer.name,
    description: `${offer.videos} videos + ${offer.questions} questions every day, and videos up to 30 minutes. Renews every 30 days; cancel any time with /plan. Fair use applies. By paying you agree to the /terms.`,
    payload: `plan:${offer.stars}`,
    stars: offer.stars,
  };
}

/** The Stars price in a plan payment's payload, or 0 if it isn't a plan payment. */
export function readPlanPayload(payload: string): number {
  const match = /^plan:(\d+)$/.exec(payload);
  return match ? Number(match[1]) : 0;
}

/** /plan for someone on it: today's numbers, when it renews or ends, and how the fair-use guard stands. */
export function planStatus(plan: Plan, now = new Date()): string {
  const offer = PLAN;
  const daily = planDaily(plan);
  const level = planLevel(plan);
  const when = plan.canceled ? `It ends on ${shortDate(plan.until)} (renewal is off).` : `It renews on ${shortDate(plan.until)} for ${plan.stars} ⭐.`;
  const lines = [`<b>${offer.name}</b> is on.`];
  if (level === "paused") {
    lines.push(`This month's fair use is used up, so it's paused until ${shortDate(plan.until)}. Your free ones and extras still work.`);
  } else {
    lines.push(`Today: ${planLeft(plan, "videos", now)} of ${daily.videos} videos and ${planLeft(plan, "questions", now)} of ${daily.questions} questions left. They start again at midnight UTC (${untilReset(now)}).`);
    if (level === "slow") lines.push(`This month has been heavy, so it's ${offer.slowVideos} video and ${offer.slowQuestions} questions a day until it renews.`);
  }
  lines.push(when);
  return lines.join("\n");
}

/** Under /plan: turn renewal off, or back on. */
export function planButtons(plan: Plan): InlineButton[][] {
  return [[plan.canceled ? { text: "Turn renewal back on", callback_data: "plan:resume" } : { text: "Cancel renewal", callback_data: "plan:cancel" }]];
}

/** Told once when the cost guard changes the plan, so it never seems broken. */
export function levelNotice(level: PlanLevel, plan: Plan): string {
  const offer = PLAN;
  if (level === "slow") return `Heads up: you've used ${offer.name} a lot this month, so it's ${offer.slowVideos} video and ${offer.slowQuestions} questions a day until it renews on ${shortDate(plan.until)}.`;
  return `You've reached this month's fair use for ${offer.name}, so it's paused until it renews on ${shortDate(plan.until)}. Your free ones and extras still work.`;
}
