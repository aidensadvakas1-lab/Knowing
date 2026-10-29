import { describe, expect, it } from "vitest";
import { findUrl, isTikTok, parseResolverResponse } from "@/lib/bot/tiktok";

describe("findUrl", () => {
  it("finds the link TikTok's share sheet sends", () => {
    expect(findUrl("Check this out! https://vm.tiktok.com/ZMabc123/ ")).toBe("https://vm.tiktok.com/ZMabc123/");
    expect(findUrl("see (https://example.com/a).")).toBe("https://example.com/a");
    expect(findUrl("no link here")).toBeNull();
  });
});

describe("isTikTok", () => {
  it("matches tiktok hosts only", () => {
    expect(isTikTok("https://vm.tiktok.com/ZMabc/")).toBe(true);
    expect(isTikTok("https://www.tiktok.com/@a/video/1")).toBe(true);
    expect(isTikTok("https://nottiktok.com/x")).toBe(false);
  });
});

describe("parseResolverResponse", () => {
  it("reads a video post and makes relative links absolute", () => {
    const r = parseResolverResponse({ code: 0, data: { play: "/video/media/play/1.mp4", title: " Bank setup ", duration: 31, author: { nickname: "pro" } } }, "https://www.tikwm.com/api/");
    expect(r).toEqual({ videoUrl: "https://www.tikwm.com/video/media/play/1.mp4", images: [], caption: "Bank setup", author: "pro", durationSec: 31 });
  });
  it("reads a photo post", () => {
    const r = parseResolverResponse({ code: 0, data: { play: "x.mp3", images: ["https://i/1.jpg", "https://i/2.jpg"] } });
    expect(r?.images).toHaveLength(2);
    expect(r?.videoUrl).toBe("");
  });
  it("rejects errors and junk", () => {
    expect(parseResolverResponse({ code: -1, msg: "nope" })).toBeNull();
    expect(parseResolverResponse({ code: 0, data: {} })).toBeNull();
    expect(parseResolverResponse("x")).toBeNull();
  });
});
