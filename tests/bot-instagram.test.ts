import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dmLink, instagramEvents, linkCode, readLinkCode, signatureMatches } from "@/lib/bot/instagram";
import { htmlText, instagramCaption, postTitle, xPostText } from "@/lib/bot/posts";

describe("Instagram link codes", () => {
  it("round-trips, ignores case and surrounding words, and refuses made-up ones", () => {
    const code = linkCode("key", 8429146259);
    expect(code).toMatch(/^know-[0-9a-z]+-[0-9a-f]{8}$/);
    expect(readLinkCode("key", code)).toBe(8429146259);
    expect(readLinkCode("key", `hi! here's my code: ${code.toUpperCase()} thanks`)).toBe(8429146259);
    expect(readLinkCode("other", code)).toBe(0);
    expect(readLinkCode("key", code.replace(/-[0-9a-f]{8}$/, "-00000000"))).toBe(0);
    expect(readLinkCode("key", "what was that recipe?")).toBe(0);
    expect(readLinkCode("", code)).toBe(0);
  });

  it("makes a DM link to the account", () => {
    expect(dmLink("getknowing")).toBe("https://ig.me/m/getknowing");
  });
});

describe("Meta's webhook signature", () => {
  const body = JSON.stringify({ object: "instagram", entry: [] });
  const sig = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;

  it("accepts Meta's signature of the exact body", () => {
    expect(signatureMatches("app-secret", body, sig)).toBe(true);
  });

  it("refuses a wrong secret, a changed body, a missing header, or no secret set", () => {
    expect(signatureMatches("other", body, sig)).toBe(false);
    expect(signatureMatches("app-secret", `${body} `, sig)).toBe(false);
    expect(signatureMatches("app-secret", body, null)).toBe(false);
    expect(signatureMatches("app-secret", body, "sha256=abc")).toBe(false);
    expect(signatureMatches("", body, sig)).toBe(false);
  });
});

describe("reading Instagram DMs from a webhook", () => {
  const delivery = (messaging: unknown[]) => ({ object: "instagram", entry: [{ id: "BIZ", time: 1, messaging }] });

  it("reads a shared Reel, a text message and a ref, and skips echoes and other events", () => {
    const events = instagramEvents(
      delivery([
        { sender: { id: "U1" }, recipient: { id: "BIZ" }, message: { mid: "m1", attachments: [{ type: "ig_reel", payload: { url: "https://lookaside.fbsbx.com/v", title: "Pasta", reel_video_id: "9" } }] } },
        { sender: { id: "U2" }, message: { mid: "m2", text: "know-abc-12345678" } },
        { sender: { id: "BIZ" }, message: { mid: "m3", text: "our own reply", is_echo: true } },
        { sender: { id: "U3" }, read: { mid: "m1" } },
        { sender: { id: "U4" }, referral: { ref: "know-abc-12345678", source: "IGME" } },
        { sender: { id: "U5" }, message: { mid: "m5", attachments: [{ type: "audio", payload: { url: "https://x/a.mp4" } }] } },
      ]),
    );
    expect(events).toEqual([
      { sender: "U1", mid: "m1", text: "", media: { type: "ig_reel", url: "https://lookaside.fbsbx.com/v", title: "Pasta" }, ref: "" },
      { sender: "U2", mid: "m2", text: "know-abc-12345678", media: null, ref: "" },
      { sender: "U4", mid: "", text: "", media: null, ref: "know-abc-12345678" },
    ]);
  });

  it("reads shared posts and Facebook reels too", () => {
    const events = instagramEvents(
      delivery([
        { sender: { id: "U1" }, message: { mid: "a", attachments: [{ type: "ig_post", payload: { url: "https://cdn/p.jpg", title: "Caption" } }] } },
        { sender: { id: "U1" }, message: { mid: "b", attachments: [{ type: "reel", payload: { url: "https://cdn/r.mp4" } }] } },
      ]),
    );
    expect(events.map((e) => e.media?.type)).toEqual(["ig_post", "reel"]);
  });

  it("ignores anything that isn't an Instagram delivery", () => {
    expect(instagramEvents({ object: "page", entry: [] })).toEqual([]);
    expect(instagramEvents(null)).toEqual([]);
    expect(instagramEvents({ object: "instagram", entry: "nope" })).toEqual([]);
  });
});

describe("post text from embeds", () => {
  it("turns embed HTML into plain text", () => {
    expect(htmlText("Hi&nbsp;there &amp; <b>you</b><br>next &#39;line&#x27; &#128512;")).toBe("Hi there & you\nnext 'line' 😀");
  });

  it("takes an X post's words, without the picture link", () => {
    expect(xPostText('<blockquote><p lang="en">Go <a href="#">#fast</a> pic.twitter.com/xyz</p>&mdash; Kay</blockquote>')).toBe("Go #fast");
  });

  it("takes an Instagram caption without the embed's boilerplate", () => {
    expect(instagramCaption("<div>View this post on Instagram</div><p>Line one</p><p>A post shared by Chef (@chef)</p>")).toBe("Line one");
  });

  it("titles a post by who posted it and how it starts", () => {
    expect(postTitle("X", "Three drills that fixed my first step\nmore", "Coach Kay")).toBe("Coach Kay: Three drills that fixed my first step");
    expect(postTitle("X", "a".repeat(10) + " " + "word ".repeat(20), "")).toMatch(/…$/);
    expect(postTitle("Instagram", "", "")).toBe("Instagram post");
  });
});
