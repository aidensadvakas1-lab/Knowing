import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const readScreenText = vi.hoisted(() => vi.fn(async (frames: string[]) => (frames.length ? "npx -y firecrawl-mcp" : "")));
vi.mock("@/lib/bot/screen", () => ({ readScreenText }));
const { createMedia, frameFilter, frameFilterTimes, parseDuration, scanFilter, FRAME_COUNT, SCAN_MAX } = await import("@/lib/bot/media");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseDuration / frameFilter", () => {
  it("reads ffmpeg's duration line", () => {
    expect(parseDuration("  Duration: 00:01:02.50, start: 0")).toBe(62.5);
    expect(parseDuration("nothing")).toBe(0);
  });
  it("spreads frames across the video", () => {
    expect(frameFilter(8, 32)).toMatch(/^fps=8\/32\.00,scale=/);
    expect(frameFilter(8, 0)).toMatch(/^fps=1\/2,/);
  });
  it("reads the screen about every second, at most twice a second, dropping repeats", () => {
    expect(scanFilter(20)).toMatch(/^fps=2\.000,mpdecimate,scale=/);
    expect(scanFilter(120)).toMatch(/^fps=0\.500,mpdecimate,/);
    expect(scanFilter(0)).toMatch(/^fps=1\.000,mpdecimate,/);
  });
  it("knows when each frame is taken", () => {
    expect(frameFilterTimes(4, 8)).toEqual([0, 2, 4, 6]);
    expect(frameFilterTimes(3, 0)).toEqual([0, 2, 4]);
  });
});

describe("createMedia (real ffmpeg)", () => {
  it("pulls frames out of a video file sent to the bot", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const dir = mkdtempSync(join(tmpdir(), "knowing-test-"));
    const file = join(dir, "clip.mp4");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=10:duration=6", "-pix_fmt", "yuv420p", file]);
    const bytes = readFileSync(file);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } })));
    const media = createMedia(async () => "https://files/clip.mp4");
    const got = await media.fromTelegramFile("F", 0);
    expect(got.frames.length).toBeGreaterThanOrEqual(FRAME_COUNT - 1);
    expect(Buffer.from(got.frames[0]!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(got.frameTimes).toHaveLength(got.frames.length);
    expect(got.frameTimes?.[1]).toBeCloseTo(6 / FRAME_COUNT);
    expect(got.notes.join(" ")).toContain("can't hear");
    expect(got.screenText).toBe("");
  }, 30_000);

  it("reads the text on screen from frames about a second apart", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    readScreenText.mockClear();
    const dir = mkdtempSync(join(tmpdir(), "knowing-test-"));
    const file = join(dir, "moving.mp4");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=10:duration=6", "-pix_fmt", "yuv420p", file]);
    const bytes = readFileSync(file);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    const got = await createMedia(async () => "https://files/moving.mp4").fromTelegramFile("F", 6);
    expect(got.screenText).toBe("npx -y firecrawl-mcp");
    const frames = readScreenText.mock.calls[0]?.[0] ?? [];
    expect(frames.length).toBeGreaterThan(FRAME_COUNT / 2);
    expect(frames.length).toBeLessThanOrEqual(SCAN_MAX);
    expect(Buffer.from(frames[0]!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 30_000);

  it("reads a still screen once instead of every second", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    readScreenText.mockClear();
    const dir = mkdtempSync(join(tmpdir(), "knowing-test-"));
    const file = join(dir, "still.mp4");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=540x960:r=10:d=8", "-pix_fmt", "yuv420p", file]);
    const bytes = readFileSync(file);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    await createMedia(async () => "https://files/still.mp4").fromTelegramFile("F", 8);
    expect(readScreenText.mock.calls[0]?.[0]).toHaveLength(1);
  }, 30_000);

  it("hears the audio through the transcription service", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const dir = mkdtempSync(join(tmpdir(), "knowing-test-"));
    const file = join(dir, "talk.mp4");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", file]);
    const bytes = readFileSync(file);
    const fetchMock = vi.fn(async (url: string) => (String(url).includes("openai") ? Response.json({ text: "put Mira on lockers" }) : new Response(bytes)));
    vi.stubGlobal("fetch", fetchMock);
    const got = await createMedia(async () => "https://files/talk.mp4").fromTelegramFile("F", 4);
    expect(got.transcript).toBe("put Mira on lockers");
    expect(got.frames.length).toBeGreaterThan(0);
  }, 30_000);

  it("turns a photo post's images into frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "knowing-test-"));
    const png = join(dir, "slide.png");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=1:duration=1", "-frames:v", "1", png]);
    const image = readFileSync(png);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("tikwm") ? Response.json({ code: 0, data: { title: "Install steps", images: ["https://i/1.png", "https://i/2.png"] } }) : new Response(image),
    ));
    const got = await createMedia(async () => "").fromLink("https://www.tiktok.com/@pro/photo/123");
    expect(got.frames).toHaveLength(2);
    expect(Buffer.from(got.frames[0]!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(got.caption).toBe("Install steps");
  }, 30_000);

  it("falls back to the caption when TikTok can't be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("tikwm") ? Response.json({ code: -1 }) : Response.json({ title: "Bank setup caption", author_name: "pro" }),
    ));
    const got = await createMedia(async () => "").fromLink("https://www.tiktok.com/@pro/video/123");
    expect(got.frames).toEqual([]);
    expect(got.caption).toContain("Bank setup caption");
    expect(got.notes[0]).toContain("caption");
  });
});
