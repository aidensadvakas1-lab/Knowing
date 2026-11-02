/**
 * Getting something Claude can watch out of a shared link or video file:
 * frames (JPEG, base64) via ffmpeg, and speech via the transcription API.
 * Every step fails soft into `notes`, so a bad download still leaves the
 * caption to work from.
 */
import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { fetchSource } from "../fetch-source";
import { isAiConfigured } from "../server";
import { isTranscriptionConfigured, transcribeAudio } from "../transcribe";
import { FRAME_COUNT, FRAME_PIXELS, MAX_SECONDS, SCAN_MAX } from "./costs";
import { isVideoFileLink, LOGIN_WALLED, platformName, sendTheFileNote } from "./platforms";
import { readScreenText } from "./screen";
import { isTikTok, resolveTikTok } from "./tiktok";
import type { Media, WatchInput } from "./types";

export { FRAME_COUNT, MAX_SECONDS, SCAN_MAX };
/** Never read more often than this per second; a caption stays up longer than half a second. */
const SCAN_FPS = 2;
/** Biggest video we'll download. TikToks are usually 2 to 20 MB. */
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/** Download a URL into memory, refusing anything over `maxBytes`. */
export async function downloadBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal, headers: { "user-agent": "Mozilla/5.0 (KnowingBot)" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("That video is too large.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("That video is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg is not available on this server"));
    execFile(ffmpegPath, ["-hide_banner", ...args], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve(String(stderr));
    });
  });
}

/** Read a "Duration: 00:00:31.20" line from ffmpeg's output, in seconds. */
export function parseDuration(ffmpegOutput: string): number {
  const m = ffmpegOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/**
 * Shrinks each frame to at most FRAME_PIXELS, keeping its shape: 540 by 960 for
 * an upright video, big enough to tell a wall from a ceiling. It has commas
 * inside, so never split a filter string on them.
 */
export const SCALE = `scale='trunc(min(iw,sqrt(${FRAME_PIXELS}*iw/ih))/2)*2':-2`;

/** The ffmpeg filter that spreads `count` frames across `durationSec` and shrinks them. */
export function frameFilter(count: number, durationSec: number): string {
  const fps = durationSec > 0 ? `fps=${count}/${Math.max(1, durationSec).toFixed(2)}` : "fps=1/2";
  return `${fps},${SCALE}`;
}

/** When each frame from frameFilter is taken, in seconds: the first at 0, then evenly spaced. */
export function frameFilterTimes(count: number, durationSec: number): number[] {
  const gap = durationSec > 0 ? Math.max(1, durationSec) / count : 2;
  return Array.from({ length: count }, (_, i) => Math.round(i * gap * 100) / 100);
}

/**
 * The ffmpeg filter for reading on-screen text: frames about every second
 * (up to SCAN_MAX across the whole video), dropping ones that barely changed,
 * so a still screen costs one frame and a new line of text gets its own.
 */
export function scanFilter(durationSec: number): string {
  const rate = durationSec > 0 ? Math.min(SCAN_FPS, SCAN_MAX / durationSec) : 1;
  return `fps=${rate.toFixed(3)},mpdecimate,${SCALE}`;
}

async function probeDuration(file: string): Promise<number> {
  try {
    await ffmpeg(["-i", file]);
    return 0;
  } catch (error) {
    // With no output file, ffmpeg exits with an error after printing the input's details.
    return parseDuration(String((error as { stderr?: string }).stderr ?? ""));
  }
}

/** Frames, speech and on-screen text from one video file. */
async function watchVideoBytes(video: Buffer, durationHint: number): Promise<{ frames: string[]; frameTimes: number[]; transcript: string; screenText: string; notes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "knowing-"));
  const notes: string[] = [];
  const jpegs = async (prefix: string) => {
    const names = (await readdir(dir)).filter((n) => new RegExp(`^${prefix}\\d+\\.jpg$`).test(n)).sort();
    return Promise.all(names.map(async (n) => (await readFile(join(dir, n))).toString("base64")));
  };
  try {
    const input = join(dir, "in.mp4");
    await writeFile(input, video);
    const full = durationHint || (await probeDuration(input));
    // Past MAX_SECONDS nothing is watched, heard or read, so a long video costs no more than a short one.
    const duration = Math.min(full, MAX_SECONDS);
    if (full > MAX_SECONDS) notes.push(`It's over ${MAX_SECONDS / 60} minutes long, so I watched the first ${MAX_SECONDS / 60}.`);

    let frames: string[] = [];
    try {
      await ffmpeg(["-loglevel", "error", "-t", String(MAX_SECONDS), "-i", input, "-vf", frameFilter(FRAME_COUNT, duration), "-frames:v", String(FRAME_COUNT), "-q:v", "5", join(dir, "f%02d.jpg")]);
      frames = await jpegs("f");
    } catch (error) {
      console.error("Frame extraction failed", error);
      notes.push("Couldn't pull frames from the video.");
    }
    const frameTimes = frameFilterTimes(FRAME_COUNT, duration).slice(0, frames.length);

    // Hearing and reading the screen run side by side, and either can fail without losing the save.
    const [transcript, screenText] = await Promise.all([hear(input, dir, notes), readScreen(input, dir, duration, jpegs)]);
    return { frames, frameTimes, transcript, screenText, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The speech in a video, or "" when there's no audio or no transcription key. */
async function hear(input: string, dir: string, notes: string[]): Promise<string> {
  if (!isTranscriptionConfigured()) {
    notes.push("I can't hear audio yet (no OPENAI_API_KEY), so I only looked at it.");
    return "";
  }
  try {
    const audio = join(dir, "audio.m4a");
    await ffmpeg(["-loglevel", "error", "-t", String(MAX_SECONDS), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
    return await transcribeAudio(new Blob([new Uint8Array(await readFile(audio))], { type: "audio/mp4" }), undefined, "audio.m4a");
  } catch (error) {
    // No audio track, or the transcription service failed.
    console.error("Audio failed", error);
    return "";
  }
}

/** The text shown on screen across the whole video, or "" if it can't be read. */
async function readScreen(input: string, dir: string, duration: number, jpegs: (prefix: string) => Promise<string[]>): Promise<string> {
  if (!isAiConfigured()) return "";
  try {
    await ffmpeg(["-loglevel", "error", "-t", String(MAX_SECONDS), "-i", input, "-vf", scanFilter(duration), "-fps_mode", "vfr", "-frames:v", String(SCAN_MAX), "-q:v", "5", join(dir, "s%02d.jpg")]);
    return await readScreenText(await jpegs("s"));
  } catch (error) {
    console.error("Reading the screen failed", error);
    return "";
  }
}

/** Photo-mode posts: convert each image to a small JPEG. */
async function imagesToFrames(urls: string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "knowing-img-"));
  try {
    const out: string[] = [];
    for (const [i, url] of urls.slice(0, FRAME_COUNT).entries()) {
      try {
        const src = join(dir, `src${i}`);
        await writeFile(src, await downloadBytes(url, 15 * 1024 * 1024));
        const jpg = join(dir, `img${i}.jpg`);
        await ffmpeg(["-loglevel", "error", "-i", src, "-vf", SCALE, "-frames:v", "1", "-q:v", "5", jpg]);
        out.push((await readFile(jpg)).toString("base64"));
      } catch (error) {
        console.error("Image failed", error);
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The real implementation, used by the webhook. */
export function createMedia(fileUrl: (fileId: string) => Promise<string>): Media {
  return {
    async fromLink(url: string): Promise<WatchInput> {
      if (isTikTok(url)) {
        try {
          const post = await resolveTikTok(url);
          if (post.images.length) {
            return { frames: await imagesToFrames(post.images), transcript: "", caption: post.caption, notes: [] };
          }
          const watched = await watchVideoBytes(await downloadBytes(post.videoUrl, MAX_VIDEO_BYTES), post.durationSec);
          return { ...watched, caption: post.caption };
        } catch (error) {
          console.error("TikTok download failed", error);
          const fallback = await fetchSource(url);
          return {
            frames: [],
            transcript: "",
            caption: fallback.text,
            notes: ["TikTok wouldn't let me download this one, so I only read its caption."],
          };
        }
      }
      // A link straight to a video file: watch it like one sent to the bot.
      if (isVideoFileLink(url)) return { ...(await watchVideoBytes(await downloadBytes(url, MAX_VIDEO_BYTES), 0)), caption: "" };
      const platform = platformName(url);
      // Instagram, X, Facebook and the like don't let the bot download their videos, and show it a
      // login wall, so their page text would be junk. Say how to get it watched instead.
      if (LOGIN_WALLED.has(platform)) return { frames: [], transcript: "", caption: "", notes: [sendTheFileNote(platform)] };
      // YouTube transcripts, Reddit posts and articles: text only.
      const fetched = await fetchSource(url);
      const notes = fetched.warning ? [fetched.warning] : [];
      if (platform && !fetched.text) notes.splice(0, notes.length, sendTheFileNote(platform));
      return { frames: [], transcript: fetched.text, caption: fetched.title, notes };
    },

    async fromTelegramFile(fileId: string, durationSec: number): Promise<WatchInput> {
      const bytes = await downloadBytes(await fileUrl(fileId), 20 * 1024 * 1024);
      const watched = await watchVideoBytes(bytes, durationSec);
      return { ...watched, caption: "" };
    },
  };
}
