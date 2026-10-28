import { describe, expect, it } from "vitest";
import { ChatRequestSchema, cleanExtraction, describeZodError, LearnRequestSchema } from "@/lib/validate";

const turn = (role: "user" | "assistant", content = "hi") => ({ role, content });

describe("ChatRequestSchema", () => {
  it("accepts a minimal request and fills defaults", () => {
    const parsed = ChatRequestSchema.parse({ messages: [turn("user")] });
    expect(parsed.items).toEqual([]);
    expect(parsed.profile).toEqual({});
  });

  it("requires the last message to be from the user", () => {
    const result = ChatRequestSchema.safeParse({ messages: [turn("user"), turn("assistant")] });
    expect(result.success).toBe(false);
    if (!result.success) expect(describeZodError(result.error)).toMatch(/last message/);
  });

  it("rejects empty conversations and oversized messages", () => {
    expect(ChatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ messages: [turn("user", "x".repeat(9_000))] }).success).toBe(false);
  });

  it("rejects unknown item kinds", () => {
    const bad = { id: "1", kind: "podcast", createdAt: 1 };
    expect(ChatRequestSchema.safeParse({ messages: [turn("user")], items: [bad] }).success).toBe(false);
  });
});

describe("LearnRequestSchema", () => {
  it("needs a link or content", () => {
    expect(LearnRequestSchema.safeParse({ kind: "note" }).success).toBe(false);
    expect(LearnRequestSchema.safeParse({ kind: "note", content: "Learn SQL" }).success).toBe(true);
    expect(LearnRequestSchema.safeParse({ kind: "video", url: "https://youtu.be/dQw4w9WgXcQ" }).success).toBe(true);
  });
});

describe("cleanExtraction", () => {
  it("trims, caps and lowercases", () => {
    const out = cleanExtraction({
      title: "  A title  ",
      takeaways: [" one ", "", "two", "3", "4", "5", "6", "7"],
      tags: ["#Startups", "AI", "Business", "extra"],
    });
    expect(out.title).toBe("A title");
    expect(out.takeaways).toEqual(["one", "two", "3", "4", "5", "6"]);
    expect(out.tags).toEqual(["startups", "ai", "business"]);
  });

  it("survives junk input", () => {
    expect(cleanExtraction({ title: null, takeaways: "nope", tags: 5 })).toEqual({ title: "", takeaways: [], tags: [] });
  });
});
