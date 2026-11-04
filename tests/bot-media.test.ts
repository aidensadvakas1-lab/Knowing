import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const readScreenText = vi.hoisted(() => vi.fn(async (frames: string[], _times?: number[]) => (frames.length ? "npx -y firecrawl-mcp" : "")));
vi.mock("@/lib/bot/screen", () => ({ readScreenText }));
const { createMedia, frameFilter, frameFilterTimes, maxVideoBytes, parseDuration, scanFilter, scanTimes, shownTimes, FRAME_COUNT, MAX_SECONDS, PLAN_MAX_SECONDS, SCAN_MAX, SEEK_FROM } = await import("@/lib/bot/media");
const { NoTranscription } = await import("@/lib/bot/types");
const { FRAME_PIXELS } = await import("@/lib/bot/costs");

/** Width and height of a JPEG, from its start-of-frame marker. */
function jpegSize(base64: string): { width: number; height: number } {
  const b = Buffer.from(base64, "base64");
  for (let i = 2; i < b.length - 9; ) {
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error("not a JPEG");
}

/** A test video made by ffmpeg, served as the Telegram file. */
function serveClip(size: string, seconds: number, rate = 10) {
  const file = join(mkdtempSync(join(tmpdir(), "knowing-test-")), "clip.mp4");
  execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=${seconds}`, "-pix_fmt", "yuv420p", file]);
  const bytes = readFileSync(file);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  return createMedia(async () => "https://files/clip.mp4");
}

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
  it("spreads a long video's screen reads evenly, and allows bigger downloads for longer watches", () => {
    const times = scanTimes(600);
    expect(times).toHaveLength(SCAN_MAX);
    expect(times[0]).toBe(5);
    expect(times.at(-1)).toBe(595);
    expect(maxVideoBytes(MAX_SECONDS)).toBe(60 * 1024 * 1024);
    expect(maxVideoBytes(PLAN_MAX_SECONDS)).toBe(352 * 1024 * 1024);
  });
  it("knows when each frame is taken", () => {
    expect(frameFilterTimes(4, 8)).toEqual([0, 2, 4, 6]);
    expect(frameFilterTimes(3, 0)).toEqual([0, 2, 4]);
  });
});

describe("createMedia (real ffmpeg)", () => {
  it("shrinks frames to at most FRAME_PIXELS, keeping upright videos at 540 by 960", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const upright = await serveClip("1080x1920", 1).fromTelegramFile("F", 1);
    expect(jpegSize(upright.frames[0]!)).toEqual({ width: 540, height: 960 });
    const square = await serveClip("1080x1080", 1).fromTelegramFile("F", 1);
    const { width, height } = jpegSize(square.frames[0]!);
    expect(width).toBe(height);
    expect(width * height).toBeLessThanOrEqual(FRAME_PIXELS);
    const small = await serveClip("320x568", 1).fromTelegramFile("F", 1);
    expect(jpegSize(small.frames[0]!)).toEqual({ width: 320, height: 568 });
  }, 30_000);

  it("only watches the first MAX_SECONDS of a long video, and says so", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const got = await serveClip("64x64", MAX_SECONDS + 60, 1).fromTelegramFile("F", MAX_SECONDS + 60);
    expect(got.notes.join(" ")).toContain("so I watched the first 5");
    expect(Math.max(...(got.frameTimes ?? []))).toBeLessThan(MAX_SECONDS);
    expect(got.frames.length).toBeGreaterThanOrEqual(FRAME_COUNT - 1);
  }, 30_000);

  it("watches up to 30 minutes on Knowing Plus, jumping to each moment of a long video", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    readScreenText.mockClear();
    const got = await serveClip("64x64", SEEK_FROM + 100, 1).fromTelegramFile("F", SEEK_FROM + 100, PLAN_MAX_SECONDS);
    expect(got.cut).toBe(false);
    expect(got.notes.join(" ")).not.toContain("watched the first");
    expect(got.frames.length).toBeGreaterThanOrEqual(FRAME_COUNT - 1);
    expect(Math.max(...(got.frameTimes ?? []))).toBeGreaterThan(SEEK_FROM);
    const [frames, times] = readScreenText.mock.calls[0]!;
    expect(frames.length).toBeGreaterThanOrEqual(SCAN_MAX - 2);
    expect(times).toHaveLength(frames.length);
    expect(got.screenText).toBe("npx -y firecrawl-mcp");
  }, 60_000);

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
    // Each frame comes with when it was taken, so the text can say when it showed up.
    const times = readScreenText.mock.calls[0]?.[1] ?? [];
    expect(times).toHaveLength(frames.length);
    expect(times[0]).toBe(0);
    expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true);
    expect(times.at(-1)).toBeLessThan(6);
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

  it("hears a long video in 10-minute pieces and joins them in order", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const dir = mkdtempSync(join(tmpdir(), "knowing-test-"));
    const file = join(dir, "long.mp4");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1:duration=700", "-f", "lavfi", "-i", "sine=frequency=440:duration=700", "-shortest", "-pix_fmt", "yuv420p", file]);
    const bytes = readFileSync(file);
    let piece = 0;
    const fetchMock = vi.fn(async (url: string) => (String(url).includes("openai") ? Response.json({ text: `part ${++piece}` }) : new Response(bytes)));
    vi.stubGlobal("fetch", fetchMock);
    const got = await createMedia(async () => "https://files/long.mp4").fromTelegramFile("F", 700, PLAN_MAX_SECONDS);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("openai"))).toHaveLength(2);
    expect(got.transcript.split(" ").sort().join(" ")).toBe("1 2 part part");
  }, 60_000);

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

  it("says to send the file for an Instagram link, instead of saving its login page", async () => {
    const fetch = vi.fn(async () => new Response("<html>Log in to Instagram</html>"));
    vi.stubGlobal("fetch", fetch);
    const got = await createMedia(async () => "").fromLink("https://www.instagram.com/reel/C9abc123/?igsh=xyz");
    expect(got).toEqual({ frames: [], transcript: "", caption: "", notes: [expect.stringContaining("send me the file")] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("watches a link straight to a video file", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    serveClip("540x960", 2);
    const got = await createMedia(async () => "").fromLink("https://cdn.example.com/clip.mov");
    expect(got.frames.length).toBeGreaterThan(0);
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

describe("shownTimes", () => {
  it("reads when each frame was taken from ffmpeg's showinfo lines", () => {
    const log = "[Parsed_showinfo_2 @ 0x1] config in time_base: 1/2\n[Parsed_showinfo_2 @ 0x1] n:   0 pts:      0 pts_time:0       duration:1\n[Parsed_showinfo_2 @ 0x1] n:   1 pts:      5 pts_time:2.5     duration:1";
    expect(shownTimes(log)).toEqual([0, 2.5]);
    expect(shownTimes("nothing here")).toEqual([]);
  });
});

describe("hearVoice", () => {
  /** A voice message made by ffmpeg, served as the Telegram file. */
  function serveVoice(seconds: number) {
    const file = join(mkdtempSync(join(tmpdir(), "knowing-test-")), "voice.ogg");
    execFileSync(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-c:a", "libopus", "-b:a", "16k", file]);
    return readFileSync(file);
  }

  it("hears only the first minute of a long voice message, and says it was cut", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const voice = serveVoice(75);
    let heardSeconds = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("openai")) return new Response(voice);
      const audio = (init?.body as FormData).get("file") as Blob;
      const out = join(mkdtempSync(join(tmpdir(), "knowing-test-")), "sent.m4a");
      writeFileSync(out, Buffer.from(await audio.arrayBuffer()));
      try {
        execFileSync(ffmpegPath!, ["-hide_banner", "-i", out], { stdio: "pipe" });
      } catch (error) {
        heardSeconds = parseDuration(String((error as { stderr?: Buffer }).stderr ?? ""));
      }
      return Response.json({ text: " how many sets of chest press? " });
    }));
    const got = await createMedia(async () => "https://files/voice.ogg").hearVoice("V", 75);
    expect(got).toEqual({ text: "how many sets of chest press?", cut: true });
    expect(heardSeconds).toBeGreaterThan(55);
    expect(heardSeconds).toBeLessThanOrEqual(60.5);
  }, 30_000);

  it("hears a short one whole", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const voice = serveVoice(3);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("openai") ? Response.json({ text: "hi" }) : new Response(voice))));
    expect(await createMedia(async () => "https://files/voice.ogg").hearVoice("V", 0)).toEqual({ text: "hi", cut: false });
  }, 30_000);

  it("says plainly when speech-to-text isn't set up", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createMedia(async () => "https://files/voice.ogg").hearVoice("V", 3)).rejects.toBeInstanceOf(NoTranscription);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
