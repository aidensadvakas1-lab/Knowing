import { describe, expect, it } from "vitest";
import { ChatStreamParser, encodeEvent } from "@/lib/chat-stream";

describe("ChatStreamParser", () => {
  it("round-trips events split across arbitrary chunk boundaries", () => {
    const wire = encodeEvent({ type: "text", text: "Hel" }) + encodeEvent({ type: "text", text: "lo\n" }) + encodeEvent({ type: "done", stopReason: "end_turn" });
    const parser = new ChatStreamParser();
    const events = [];
    for (let i = 0; i < wire.length; i += 7) events.push(...parser.push(wire.slice(i, i + 7)));
    events.push(...parser.flush());
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo\n" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("skips malformed lines instead of throwing", () => {
    const parser = new ChatStreamParser();
    expect(parser.push("not json\n" + encodeEvent({ type: "error", code: "internal", error: "x" }))).toEqual([
      { type: "error", code: "internal", error: "x" },
    ]);
  });
});
