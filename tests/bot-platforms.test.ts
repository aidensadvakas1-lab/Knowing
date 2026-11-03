import { describe, expect, it } from "vitest";
import { isVideoFile, isVideoFileLink, LOGIN_WALLED, platformName, sendTheFileNote } from "@/lib/bot/platforms";

describe("platformName", () => {
  it("names the app a shared link is from", () => {
    expect(platformName("https://www.instagram.com/reel/C9abc123/?igsh=xyz")).toBe("Instagram");
    expect(platformName("https://vm.tiktok.com/ZMabc/")).toBe("TikTok");
    expect(platformName("https://youtube.com/shorts/abc")).toBe("YouTube");
    expect(platformName("https://x.com/a/status/1")).toBe("X");
    expect(platformName("https://fb.watch/abc/")).toBe("Facebook");
    expect(platformName("https://www.threads.net/@a/post/x")).toBe("Threads");
    expect(platformName("https://example.com/video")).toBe("");
    expect(platformName("not a link")).toBe("");
  });
});

describe("video files", () => {
  it("spots links straight to a video file", () => {
    expect(isVideoFileLink("https://cdn.example.com/clip.MP4?x=1")).toBe(true);
    expect(isVideoFileLink("https://cdn.example.com/clip.webm")).toBe(true);
    expect(isVideoFileLink("https://example.com/watch")).toBe(false);
  });

  it("takes any video sent as a file, by its type or its name", () => {
    expect(isVideoFile({ mime_type: "video/quicktime" })).toBe(true);
    expect(isVideoFile({ mime_type: "application/octet-stream", file_name: "IMG_0042.MOV" })).toBe(true);
    expect(isVideoFile({ file_name: "clip.mkv" })).toBe(true);
    expect(isVideoFile({ mime_type: "application/pdf", file_name: "notes.pdf" })).toBe(false);
    expect(isVideoFile(undefined)).toBe(false);
  });

  it("tells people how to get a walled app's video watched", () => {
    expect(LOGIN_WALLED.has("Instagram")).toBe(true);
    expect(sendTheFileNote("Instagram")).toBe("Instagram doesn't let me download videos from a link. To have me watch this one, save it in Instagram (or screen-record it) and send me the file. Any video format works.");
  });
});
