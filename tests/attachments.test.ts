import { describe, expect, it } from "vitest";
import { attachedLine, binaryChars, classifyFile, fitsInRequest, type ChatAttachment } from "@/lib/attachments";
import { ATTACHMENTS } from "@/lib/constants";

describe("classifyFile", () => {
  it("sorts by MIME type", () => {
    expect(classifyFile({ name: "a", type: "video/mp4" })).toBe("video");
    expect(classifyFile({ name: "a", type: "image/png" })).toBe("image");
    expect(classifyFile({ name: "a", type: "application/pdf" })).toBe("pdf");
    expect(classifyFile({ name: "a", type: "text/plain" })).toBe("text");
    expect(classifyFile({ name: "a", type: "application/json" })).toBe("text");
  });

  it("falls back to the extension when the type is missing", () => {
    expect(classifyFile({ name: "clip.MOV", type: "" })).toBe("video");
    expect(classifyFile({ name: "photo.heic", type: "" })).toBe("image");
    expect(classifyFile({ name: "notes.md", type: "" })).toBe("text");
    expect(classifyFile({ name: "paper.pdf", type: "" })).toBe("pdf");
  });

  it("rejects what it can't read", () => {
    expect(classifyFile({ name: "deck.pptx", type: "application/vnd.ms-powerpoint" })).toBe("unsupported");
    expect(classifyFile({ name: "app.exe", type: "" })).toBe("unsupported");
  });
});

describe("binary size", () => {
  const image = (chars: number): ChatAttachment => ({ type: "image", name: "a.jpg", mediaType: "image/jpeg", data: "A".repeat(chars) });
  const text: ChatAttachment = { type: "text", name: "a.txt", text: "x".repeat(10_000) };

  it("counts images and PDFs but not text", () => {
    expect(binaryChars([image(100), { type: "pdf", name: "b.pdf", data: "AAAA" }, text])).toBe(104);
  });

  it("knows when files are too big to send together", () => {
    expect(fitsInRequest([image(ATTACHMENTS.totalBinaryChars)])).toBe(true);
    expect(fitsInRequest([image(ATTACHMENTS.totalBinaryChars), image(1)])).toBe(false);
  });
});

describe("attachedLine", () => {
  it("lists names, or nothing", () => {
    expect(attachedLine(["plan.pdf", "clip.mp4"])).toBe("Attached: plan.pdf, clip.mp4");
    expect(attachedLine([])).toBe("");
  });
});
