import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL } from "@/lib/constants";
import {
  buildExtractionPrompt,
  buildSystemPrompt,
  buildVideoPrompt,
  effectiveGoal,
  isoDate,
  itemToText,
  knowledgeToText,
  profileToText,
} from "@/lib/prompt";
import type { KnowledgeItem } from "@/lib/types";

const item = (overrides: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id: "1",
  kind: "tiktok",
  title: "How YC picks founders",
  url: "https://www.tiktok.com/@yc/video/1",
  content: "Founders who ship fast win.",
  takeaways: ["Ship a project every month"],
  tags: ["startups"],
  status: "done",
  createdAt: Date.UTC(2026, 9, 1),
  ...overrides,
});

describe("isoDate", () => {
  it("formats epoch ms as YYYY-MM-DD", () => expect(isoDate(Date.UTC(2026, 0, 5))).toBe("2026-01-05"));
  it("returns an empty string for missing values", () => {
    expect(isoDate(undefined)).toBe("");
    expect(isoDate(Number.NaN)).toBe("");
  });
});

describe("effectiveGoal", () => {
  it("falls back to the default goal", () => {
    expect(effectiveGoal({})).toBe(DEFAULT_GOAL);
    expect(effectiveGoal({ goal: "   " })).toBe(DEFAULT_GOAL);
  });
  it("uses the user's goal when set", () => expect(effectiveGoal({ goal: "Start a company" })).toBe("Start a company"));
});

describe("profileToText", () => {
  it("marks empty fields so the model knows to ask", () => {
    const text = profileToText({ now: "High school junior" });
    expect(text).toContain("Where they are now: High school junior");
    expect(text).toContain("Skills and experience: (not filled in yet)");
    expect(text).toContain(`Main goal: ${DEFAULT_GOAL}`);
  });
});

describe("itemToText", () => {
  it("includes title, kind, link, date, takeaways and notes", () => {
    const text = itemToText(item());
    expect(text).toContain("### How YC picks founders (TikTok, https://www.tiktok.com/@yc/video/1, added 2026-10-01)");
    expect(text).toContain("- Ship a project every month");
    expect(text).toContain("Founders who ship fast win.");
  });

  it("caps long content", () => {
    expect(itemToText(item({ content: "x".repeat(10_000) })).length).toBeLessThan(2_000);
  });
});

describe("knowledgeToText", () => {
  it("orders newest first", () => {
    const text = knowledgeToText([item({ id: "a", title: "Old", createdAt: 1 }), item({ id: "b", title: "New", createdAt: 2 })]);
    expect(text.indexOf("New")).toBeLessThan(text.indexOf("Old"));
  });

  it("drops older items once the budget is used", () => {
    const text = knowledgeToText(
      [item({ id: "a", title: "Old", createdAt: 1 }), item({ id: "b", title: "New", createdAt: 2 })],
      itemToText(item({ title: "New" })).length + 5,
    );
    expect(text).toContain("New");
    expect(text).not.toContain("Old");
  });

  it("says when nothing has been taught", () => expect(knowledgeToText([])).toMatch(/Nothing yet/));
});

describe("buildSystemPrompt", () => {
  it("contains the profile, the knowledge and today's date", () => {
    const prompt = buildSystemPrompt({ now: "College freshman" }, [item()], new Date(Date.UTC(2026, 9, 28)));
    expect(prompt).toContain("College freshman");
    expect(prompt).toContain("How YC picks founders");
    expect(prompt).toContain("Today's date is 2026-10-28");
  });
});

describe("buildExtractionPrompt", () => {
  it("includes the goal and content", () => {
    const prompt = buildExtractionPrompt({ kind: "video", title: "", url: "", content: "Learn linear algebra", goal: "" });
    expect(prompt).toContain(DEFAULT_GOAL);
    expect(prompt).toContain("Type: Video");
    expect(prompt).toContain("Learn linear algebra");
  });
});

describe("buildVideoPrompt", () => {
  it("includes the transcript, frame times and length", () => {
    const prompt = buildVideoPrompt({
      kind: "tiktok",
      title: "",
      url: "",
      content: "[0:00] Start with customers.",
      goal: "",
      frameTimes: [5, 65],
      durationSec: 125,
    });
    expect(prompt).toContain("Start with customers.");
    expect(prompt).toContain("0:05, 1:05");
    expect(prompt).toContain("Length: 2:05");
    expect(prompt).toContain(DEFAULT_GOAL);
  });

  it("tells the model to work from frames when there is no speech", () => {
    const prompt = buildVideoPrompt({ kind: "video", title: "", url: "", content: "", goal: "g", frameTimes: [1] });
    expect(prompt).toContain("No speech was transcribed");
  });
});

describe("itemToText with an assessment", () => {
  it("includes the assessment", () => {
    expect(itemToText(item({ assessment: "Mostly hype." }))).toContain("Your assessment: Mostly hype.");
  });
});
