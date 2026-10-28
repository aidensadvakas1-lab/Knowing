import { describe, expect, it } from "vitest";
import { detectSource, extractYouTubeId, isPublicHost, parseHttpUrl, suggestKind } from "@/lib/sources";

describe("parseHttpUrl", () => {
  it("accepts http and https", () => {
    expect(parseHttpUrl("https://example.com")?.hostname).toBe("example.com");
    expect(parseHttpUrl("  http://example.com/x  ")?.pathname).toBe("/x");
  });
  it("rejects other schemes and garbage", () => {
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseHttpUrl("not a url")).toBeNull();
  });
});

describe("extractYouTubeId", () => {
  const id = "dQw4w9WgXcQ";
  it.each([
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ])("finds the id in %s", (url) => expect(extractYouTubeId(url)).toBe(id));

  it("returns null for non-YouTube or malformed links", () => {
    expect(extractYouTubeId(`https://example.com/watch?v=${id}`)).toBeNull();
    expect(extractYouTubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(extractYouTubeId("https://www.youtube.com/@channel")).toBeNull();
  });
});

describe("detectSource and suggestKind", () => {
  it("classifies links", () => {
    expect(detectSource("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(detectSource("https://www.tiktok.com/@user/video/123")).toBe("tiktok");
    expect(detectSource("https://vm.tiktok.com/ZM123/")).toBe("tiktok");
    expect(detectSource("https://paulgraham.com/start.html")).toBe("web");
    expect(detectSource("nope")).toBeNull();
  });

  it("maps sources to item kinds", () => {
    expect(suggestKind("https://youtu.be/dQw4w9WgXcQ")).toBe("video");
    expect(suggestKind("https://www.tiktok.com/@u/video/1")).toBe("tiktok");
    expect(suggestKind("https://example.com")).toBe("article");
    expect(suggestKind("")).toBeNull();
  });

  it("does not mistake look-alike hosts for TikTok", () => {
    expect(detectSource("https://nottiktok.com/x")).toBe("web");
  });
});

describe("isPublicHost", () => {
  it.each(["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "metadata.google.internal"])(
    "blocks %s",
    (host) => expect(isPublicHost(host)).toBe(false),
  );

  it.each(["example.com", "8.8.8.8", "172.32.0.1", "fdroid.org", "2606:4700::1111"])("allows %s", (host) =>
    expect(isPublicHost(host)).toBe(true),
  );
});
