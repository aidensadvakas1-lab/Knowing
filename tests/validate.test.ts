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

describe("ChatRequestSchema attachments", () => {
  const ok = { messages: [turn("user")] };

  it("accepts images, PDFs and text files", () => {
    const parsed = ChatRequestSchema.parse({
      ...ok,
      attachments: [
        { type: "image", name: "a.png", mediaType: "image/png", data: "iVBORw0KGgo=" },
        { type: "pdf", name: "b.pdf", data: "JVBERi0=" },
        { type: "text", name: "c.txt", text: "hello" },
      ],
    });
    expect(parsed.attachments).toHaveLength(3);
  });

  it("defaults to none and rejects bad or oversized files", () => {
    expect(ChatRequestSchema.parse(ok).attachments).toEqual([]);
    expect(ChatRequestSchema.safeParse({ ...ok, attachments: [{ type: "image", name: "a", mediaType: "image/bmp", data: "AA==" }] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...ok, attachments: [{ type: "pdf", name: "a", data: "not base64!" }] }).success).toBe(false);
    const big = { type: "pdf", name: "a", data: "A".repeat(2_000_000) };
    const result = ChatRequestSchema.safeParse({ ...ok, attachments: [big, big] });
    expect(result.success).toBe(false);
    if (!result.success) expect(describeZodError(result.error)).toMatch(/too big/);
  });
});

describe("LearnRequestSchema", () => {
  it("needs a link or content", () => {
    expect(LearnRequestSchema.safeParse({ kind: "note" }).success).toBe(false);
    expect(LearnRequestSchema.safeParse({ kind: "note", content: "Learn SQL" }).success).toBe(true);
    expect(LearnRequestSchema.safeParse({ kind: "video", url: "https://youtu.be/dQw4w9WgXcQ" }).success).toBe(true);
  });

  it("accepts video frames on their own", () => {
    const parsed = LearnRequestSchema.parse({ kind: "tiktok", frames: [{ at: 1.5, data: "/9j/4AAQSkZJRg==" }], durationSec: 30 });
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.content).toBe("");
  });

  it("rejects frames that aren't base64 and too many frames", () => {
    expect(LearnRequestSchema.safeParse({ kind: "video", frames: [{ at: 0, data: "<script>" }] }).success).toBe(false);
    const many = Array.from({ length: 20 }, (_, i) => ({ at: i, data: "AAAA" }));
    expect(LearnRequestSchema.safeParse({ kind: "video", frames: many }).success).toBe(false);
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
    expect(cleanExtraction({ title: null, takeaways: "nope", tags: 5 })).toEqual({
      title: "",
      takeaways: [],
      tags: [],
      assessment: "",
      visualNotes: "",
    });
  });
});
