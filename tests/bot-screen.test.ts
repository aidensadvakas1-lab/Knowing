import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const create = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server", () => ({ getAnthropic: () => ({ messages: { create } }) }));
const { cleanScreenText, readScreenText, SCREEN_TEXT_PROMPT, SCREEN_TIMES_PROMPT } = await import("@/lib/bot/screen");
const { READ_PROMPT_TOKENS, TOKENS_PER_CHAR } = await import("@/lib/bot/costs");
const { MODELS } = await import("@/lib/constants");

describe("cleanScreenText", () => {
  it("keeps the text and drops a NONE", () => {
    expect(cleanScreenText("  npx -y firecrawl-mcp\nPERPLEXITY_API_KEY \n")).toBe("npx -y firecrawl-mcp\nPERPLEXITY_API_KEY");
    expect(cleanScreenText("NONE")).toBe("");
    expect(cleanScreenText("none.")).toBe("");
    expect(cleanScreenText("x".repeat(7_000))).toHaveLength(6_000);
  });
});

describe("readScreenText", () => {
  it("sends every frame to the cheap model with the copy-it-exactly prompt", async () => {
    create.mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "claude mcp add playwright npx @playwright/mcp@latest" }] });
    const text = await readScreenText(["AAA", "BBB"]);
    expect(text).toBe("claude mcp add playwright npx @playwright/mcp@latest");
    const [body, options] = create.mock.calls[0]!;
    expect(body.model).toBe(MODELS.read);
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: SCREEN_TEXT_PROMPT });
    expect(body.messages[0].content.filter((b: { type: string }) => b.type === "image")).toHaveLength(2);
    expect(options).toMatchObject({ maxRetries: 0 });
    expect(SCREEN_TEXT_PROMPT).toContain("word for word");
  });
  it("labels each frame with its time when it has them, so each line says when it showed up", async () => {
    create.mockClear();
    create.mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "0:12 npm install firecrawl-mcp" }] });
    expect(await readScreenText(["AAA", "BBB"], [0, 12.4])).toBe("0:12 npm install firecrawl-mcp");
    const content = create.mock.calls[0]![0].messages[0].content;
    expect(content[0].text).toContain(SCREEN_TIMES_PROMPT);
    expect(content.map((b: { type: string; text?: string }) => b.text ?? b.type)).toEqual([expect.any(String), "At 0:00:", "image", "At 0:12:", "image"]);
    // Times that don't match the frames are left out rather than mislabel them.
    create.mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "x" }] });
    await readScreenText(["AAA", "BBB"], [0]);
    expect(create.mock.calls[1]![0].messages[0].content[0].text).toBe(SCREEN_TEXT_PROMPT);
  });

  it("fits its instructions in what the cost math allows for them", () => {
    expect(Math.ceil((SCREEN_TEXT_PROMPT.length + SCREEN_TIMES_PROMPT.length + 2) * TOKENS_PER_CHAR)).toBeLessThan(READ_PROMPT_TOKENS);
  });

  it("skips the call with no frames, and comes back empty on a refusal", async () => {
    create.mockClear();
    expect(await readScreenText([])).toBe("");
    expect(create).not.toHaveBeenCalled();
    create.mockResolvedValueOnce({ stop_reason: "refusal", content: [] });
    expect(await readScreenText(["AAA"])).toBe("");
  });
});
