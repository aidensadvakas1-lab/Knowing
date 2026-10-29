import { describe, expect, it } from "vitest";
import { buildAskSystem, buildWatchPrompt, cleanDraft, parseAnswer, relevantSaves } from "@/lib/bot/prompts";
import { newUser } from "@/lib/bot/store";
import type { Save } from "@/lib/bot/types";

const save = (over: Partial<Save>): Save => ({
  id: "a1",
  userId: 1,
  title: "Bank basement: lockers + CCTV setup",
  topic: "Siege, Bank",
  type: "setup",
  summary: "Basement defense on Bank.",
  steps: ["Reinforce CCTV wall", "Mira on lockers"],
  details: "Castle on server door.",
  needsWords: false,
  sourceUrl: "",
  words: "",
  practiced: 0,
  createdAt: "2026-10-29T00:00:00Z",
  ...over,
});

describe("cleanDraft", () => {
  it("caps and defaults whatever comes back", () => {
    const d = cleanDraft({ title: "  X  ", type: "nonsense", steps: ["a", 3, "", "b"], needsWords: "yes" }, "Fallback");
    expect(d).toMatchObject({ title: "X", type: "info", steps: ["a", "b"], needsWords: false, topic: "" });
    expect(cleanDraft(null, "Fallback").title).toBe("Fallback");
  });
});

describe("buildWatchPrompt", () => {
  it("includes caption, transcript and the note", () => {
    const p = buildWatchPrompt({ caption: "Bank setup", transcript: "put mira here", note: "for ranked", frameCount: 8 });
    expect(p).toContain("8 images");
    expect(p).toContain("Bank setup");
    expect(p).toContain("put mira here");
    expect(p).toContain('"for ranked"');
  });
  it("says when there is no transcript", () => {
    expect(buildWatchPrompt({ caption: "", transcript: "", note: "", frameCount: 0 })).toContain("no transcript");
  });
});

describe("relevantSaves", () => {
  it("ranks saves by shared words", () => {
    const saves = [save({ id: "x", title: "Split dodge drill", topic: "Lacrosse, Dodging", steps: [], details: "", summary: "" }), save({})];
    expect(relevantSaves(saves, "what was my bank setup").map((s) => s.id)).toEqual(["a1"]);
    expect(relevantSaves(saves, "")).toEqual([]);
  });
});

describe("buildAskSystem", () => {
  it("puts the goal, matching saves in full, mindsets, and the rest as an index", () => {
    const mindset = save({ id: "m1", title: "The open arena", topic: "Business, Mindset", type: "mindset", steps: ["No degree needed"], details: "", summary: "Anyone can start." });
    const other = save({ id: "o1", title: "Split dodge drill", topic: "Lacrosse", steps: [], details: "", summary: "Weak hand." });
    const user = { ...newUser(1), goal: "Become a rich entrepreneur" };
    const p = buildAskSystem(user, [save({}), mindset, other], "bank setup?", "2026-10-29");
    expect(p).toContain("THEIR MAIN GOAL: Become a rich entrepreneur");
    expect(p).toContain("Mira on lockers");
    expect(p).toContain("No degree needed");
    expect(p).toContain('[id o1] "Split dodge drill"');
    expect(p).toContain("SWITCH:");
  });
});

describe("parseAnswer", () => {
  it("splits off the control lines and keeps only known ids", () => {
    const a = parseAnswer("1. Reinforce\n2. Mira\nSWITCH: Go to college for AI\nBOTH: Build a business while studying\nSOURCES: a1, zz", ["a1"]);
    expect(a).toEqual({ text: "1. Reinforce\n2. Mira", sources: ["a1"], goal: "", switchTo: "Go to college for AI", both: "Build a business while studying" });
  });
  it("handles a plain answer", () => {
    expect(parseAnswer("Nothing saved on that yet.\nSOURCES: none", [])).toMatchObject({ text: "Nothing saved on that yet.", sources: [] });
    expect(parseAnswer("Hi", []).text).toBe("Hi");
  });
});
