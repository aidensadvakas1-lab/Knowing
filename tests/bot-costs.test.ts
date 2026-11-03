import { describe, expect, it } from "vitest";
import {
  ASK_SYSTEM_CHARS,
  HISTORY_CHARS,
  packPrice,
  PAYOUT_PER_STAR,
  pricedPacks,
  REWRITE_TEXT_CHARS,
  SAFETY,
  WATCH_TEXT_CHARS,
  WRAPUP_TEXT_CHARS,
  worstPackCost,
  worstQuestionCost,
  worstVideoCost,
} from "@/lib/bot/costs";
import { buildAskSystem, buildFixPrompt, buildRewritePrompt, buildWatchPrompt, buildWrapUpPrompt, recentHistory } from "@/lib/bot/prompts";
import { RULES_KEPT } from "@/lib/bot/folders";
import { aboutKnowing } from "@/lib/bot/profile";
import { PACK_SIZES } from "@/lib/bot/shop";
import { newUser } from "@/lib/bot/store";
import { COLLECTIONS_KEPT } from "@/lib/bot/collections";
import type { Save } from "@/lib/bot/types";

const long = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

/** A save with every field at its longest. */
const bigSave = (i: number): Save => ({
  id: `s${i}`,
  userId: 1,
  title: long(100),
  topic: long(60),
  type: i % 5 ? "setup" : "mindset",
  summary: long(240),
  steps: Array.from({ length: 12 }, () => long(240)),
  details: long(3_000),
  words: long(8_000),
  source: long(20_000),
  needsWords: false,
  sourceUrl: `https://www.tiktok.com/@a/video/${i}`,
  createdAt: "2026-11-02T00:00:00Z",
  practiced: 0,
});

describe("worst-case costs", () => {
  it("never sells a pack for less than its worst case costs, with room to spare", () => {
    for (const pack of pricedPacks()) {
      const pays = pack.stars * PAYOUT_PER_STAR;
      expect(worstPackCost(pack), `${pack.videos} + ${pack.questions}`).toBeLessThanOrEqual(pays * SAFETY);
    }
  });

  it("puts every bundle on sale at a round price", () => {
    const packs = pricedPacks();
    expect(packs.map((p) => ({ videos: p.videos, questions: p.questions }))).toEqual(PACK_SIZES);
    for (const p of packs) expect(p.stars % 50).toBe(0);
  });

  it("sells one refill, videos and questions together, at the price Aiden picked", () => {
    expect(pricedPacks().map((p) => `${p.videos} videos + ${p.questions} questions: ${p.stars}`)).toEqual(["5 videos + 10 questions: 150"]);
    // Bigger bundles would still be priced from their worst case, at the same price per item.
    expect(packPrice({ videos: 10, questions: 20 })).toBe(300);
    expect(packPrice({ videos: 25, questions: 50 })).toBe(750);
  });

  it("keeps one video and one question cheap enough to matter", () => {
    expect(worstVideoCost()).toBeLessThan(0.2);
    expect(worstQuestionCost()).toBeLessThan(0.1);
  });
});

describe("the limits the worst case relies on", () => {
  const user = { ...newUser(1), facts: Array.from({ length: 40 }, () => long(160)), turns: Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: long(4_000) })) };
  const saves = Array.from({ length: 150 }, (_, i) => bigSave(i));
  const memories = Array.from({ length: 4 }, () => ({ said: long(4_000), answered: long(4_000), at: "2026-11-01T00:00:00Z" }));
  /** As many filing rules as are kept, as long as they can be. */
  const rules = Array.from({ length: RULES_KEPT }, (_, i) => ({ folder: `${long(36)}${i}`, about: long(120) }));
  /** Everything Knowing knows about itself, for the owner (the longest version). */
  const about = aboutKnowing({ limits: { videos: 5, questions: 10 }, packs: pricedPacks(), open: true }, true);

  it("caps the text sent with a video's frames", () => {
    const prompt = buildWatchPrompt({ caption: long(9_000), transcript: long(60_000), screenText: long(9_000), note: long(4_096), frameCount: 20, facts: user.facts, saves });
    expect(prompt.length).toBeLessThanOrEqual(WATCH_TEXT_CHARS);
  });

  it("still caps it when they have a folder for everything", () => {
    const many = saves.map((s, i) => ({ ...s, topic: `${long(38)}${i}, part` }));
    const prompt = buildWatchPrompt({ caption: long(9_000), transcript: long(60_000), screenText: long(9_000), note: long(4_096), frameCount: 20, facts: user.facts, saves: many, rules });
    expect(prompt.length).toBeLessThanOrEqual(WATCH_TEXT_CHARS);
  });

  it("caps Fix something and Add what it says", () => {
    expect(buildRewritePrompt(bigSave(1), long(20_000)).length).toBeLessThanOrEqual(REWRITE_TEXT_CHARS);
    expect(buildFixPrompt(bigSave(1), long(20_000)).length).toBeLessThanOrEqual(REWRITE_TEXT_CHARS);
  });

  it("caps an answer's instructions, however much they've saved, said and told it", () => {
    const retrieved = saves.slice(0, 6).map((save) => ({ save, passages: [long(2_000), long(2_000)] }));
    const system = buildAskSystem(user, saves, retrieved, "2026-11-02", { name: long(200), memories, usage: long(600), rules, about });
    expect(about.length).toBeLessThan(6_000);
    expect(system.length).toBeLessThanOrEqual(ASK_SYSTEM_CHARS);
    expect(system).toContain("THEIR SAVES THAT MATCH THIS QUESTION:\n[id s0]");
  });

  it("still fits the best match when they have every collection there can be, each full", () => {
    const retrieved = saves.slice(0, 6).map((save) => ({ save, passages: [long(2_000), long(2_000)] }));
    const collections = Array.from({ length: COLLECTIONS_KEPT }, (_, i) => ({ name: `${long(36)}${i}`, ids: saves.map((s) => s.id) }));
    const system = buildAskSystem(user, saves, retrieved, "2026-11-02", { name: long(200), memories, usage: long(600), rules, collections, about });
    expect(system.length).toBeLessThanOrEqual(ASK_SYSTEM_CHARS);
    expect(system).toContain("THEIR COLLECTIONS");
    expect(system).toContain("THEIR SAVES THAT MATCH THIS QUESTION:\n[id s0]");
  });

  it("sends only the newest chat that fits, starting with something they said", () => {
    const history = recentHistory(user.turns);
    expect(history.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(HISTORY_CHARS);
    expect(history[0]?.role).toBe("user");
    expect(history.at(-1)).toEqual({ role: "assistant", content: long(2_000) });
    expect(recentHistory([{ role: "assistant", content: "hi" }, { role: "user", content: "yo" }])).toEqual([{ role: "user", content: "yo" }]);
  });

  it("caps the wrap-up after a scroll session", () => {
    expect(buildWrapUpPrompt(saves.slice(0, 30), saves, user.facts).length).toBeLessThanOrEqual(WRAPUP_TEXT_CHARS);
  });
});
