import { describe, expect, it } from "vitest";
import { PAYOUT_PER_STAR, planBudget, SAFETY, worstQuestionCost, worstVideoCost } from "@/lib/bot/costs";
import { charge, chargeAudio, chargeClaude, costOf } from "@/lib/bot/meter";
import { PLAN, PLAN_SLOW_AT, planActive, planDaily, planInvoice, planLeft, planLevel, readPlanPayload, refundPlan, untilReset, usePlan } from "@/lib/bot/plan";
import type { Plan } from "@/lib/bot/types";

const plan = (over: Partial<Plan> = {}): Plan => ({ until: "2026-12-03T10:00:00.000Z", first: "s1", charge: "s1", stars: 500, day: "", videos: 0, questions: 0, cost: 0, canceled: false, ...over });
const noon = new Date("2026-11-03T12:00:00Z");

describe("Knowing Plus", () => {
  it("is 5 videos and 10 questions a day for 500 Stars a month", () => {
    expect(PLAN).toMatchObject({ videos: 5, questions: 10, stars: 500 });
  });

  it("uses up today's, and starts again on a new UTC day", () => {
    const p = plan();
    for (let i = 0; i < 5; i++) expect(usePlan(p, "videos", noon)).toBe(true);
    expect(usePlan(p, "videos", noon)).toBe(false);
    expect(planLeft(p, "questions", noon)).toBe(10);
    refundPlan(p, "videos", noon);
    expect(planLeft(p, "videos", noon)).toBe(1);
    const tomorrow = new Date("2026-11-04T00:00:01Z");
    expect(planLeft(p, "videos", tomorrow)).toBe(5);
    expect(usePlan(p, "videos", tomorrow)).toBe(true);
    expect(p).toMatchObject({ day: "2026-11-04", videos: 1 });
    // Giving one back on another day changes nothing.
    refundPlan(p, "videos", noon);
    expect(p.videos).toBe(1);
  });

  it("works until the month ends, with a short wait for the renewal unless it's canceled", () => {
    expect(planActive(plan(), noon)).toBe(true);
    expect(planActive(plan(), new Date("2026-12-03T11:00:00Z"))).toBe(true);
    expect(planActive(plan(), new Date("2026-12-03T12:30:00Z"))).toBe(false);
    expect(planActive(plan({ canceled: true }), new Date("2026-12-03T10:01:00Z"))).toBe(false);
    expect(planActive(null)).toBe(false);
    expect(usePlan(plan(), "videos", new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });

  it("slows down, then pauses, as a month's real cost nears what it pays", () => {
    const budget = planBudget(500);
    expect(planLevel(plan({ cost: budget * PLAN_SLOW_AT - 0.01 }))).toBe("full");
    expect(planDaily(plan({ cost: budget * PLAN_SLOW_AT }))).toEqual({ videos: 1, questions: 3 });
    expect(planDaily(plan({ cost: budget }))).toEqual({ videos: 0, questions: 0 });
    // Slowing down after using 4 today leaves none, not less than none.
    expect(planLeft(plan({ cost: budget * 0.8, day: "2026-11-03", videos: 4 }), "videos", noon)).toBe(0);
  });

  it("can't cost more than it pays, even when the last use before it pauses is the worst there can be", () => {
    const pays = PLAN.stars * PAYOUT_PER_STAR;
    expect(planBudget(PLAN.stars)).toBeCloseTo(pays * SAFETY, 6);
    expect(planBudget(PLAN.stars) + Math.max(worstVideoCost(), worstQuestionCost())).toBeLessThan(pays);
  });

  it("makes an invoice Telegram accepts, and reads its payload back", () => {
    const invoice = planInvoice(PLAN);
    expect(invoice.title.length).toBeLessThanOrEqual(32);
    expect(invoice.description.length).toBeLessThanOrEqual(255);
    expect(invoice.description).toContain("/terms");
    expect(invoice.payload.length).toBeLessThanOrEqual(128);
    expect(readPlanPayload(invoice.payload)).toBe(500);
    expect(readPlanPayload("bundle:5:10:150")).toBe(0);
  });

  it("says how long until the counts start again", () => {
    expect(untilReset(new Date("2026-11-03T10:00:00Z"))).toBe("in 14 h");
    expect(untilReset(new Date("2026-11-03T23:30:00Z"))).toBe("in 30 min");
  });
});

describe("the cost meter", () => {
  it("adds up what every call in one use cost, however deep it runs", async () => {
    const dollars = await costOf(async () => {
      chargeClaude("claude-sonnet-5-5", { input_tokens: 10_000, output_tokens: 1_000 }); // 2¢ + 1¢
      await Promise.all([
        (async () => chargeClaude("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0 }))(), // 1¢
        (async () => chargeAudio(60))(), // 0.3¢
      ]);
    });
    expect(dollars).toBeCloseTo(0.001 + 0.03 + 0.01 + 0.003, 6);
  });

  it("counts unknown audio as the longest, and ignores charges outside a use", async () => {
    charge(5); // nothing is being measured
    expect(await costOf(async () => chargeAudio(0))).toBeCloseTo(0.001 + 30 * 0.003, 6);
    expect(await costOf(async () => {})).toBeCloseTo(0.001, 6);
  });

  it("still counts what a use cost when it fails", async () => {
    let seen = 0;
    const { metered } = await import("@/lib/bot/meter");
    await expect(metered(async () => (charge(0.2), Promise.reject(new Error("boom"))), async (d) => void (seen = d))).rejects.toThrow("boom");
    expect(seen).toBeCloseTo(0.201, 6);
  });
});
