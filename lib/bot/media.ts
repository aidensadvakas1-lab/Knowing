/**
 * Getting something Claude can watch out of a shared link or video file:
 * frames (JPEG, base64) via ffmpeg, and speech via the transcription API.
 * Every step fails soft into `notes`, so a bad download still leaves the
 * caption to work from.
 */
import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { fetchSource } from "../fetch-source";
import { fetchRetry } from "../net";
import { isAiConfigured } from "../server";
import { isTranscriptionConfigured, transcribeAudio } from "../transcribe";
import { FRAME_COUNT, FRAME_PIXELS, MAX_SECONDS, PLAN_MAX_SECONDS, SCAN_MAX, VOICE_MAX_SECONDS } from "./costs";
import { isVideoFileLink, LOGIN_WALLED, platformName, sendTheFileNote } from "./platforms";
import { chargeAudio } from "./meter";
import { readScreenText } from "./screen";
import { isTikTok, resolveTikTok } from "./tiktok";
import { NoTranscription, type Media, type WatchInput } from "./types";

export { FRAME_COUNT, MAX_SECONDS, PLAN_MAX_SECONDS, SCAN_MAX };
/** Never read more often than this per second; a caption stays up longer than half a second. */
const SCAN_FPS = 2;
/** Biggest video we'll download for a watch of `seconds`: about 200 KB a second, between 60 and 360 MB. TikToks are usually 2 to 20 MB a minute. */
export const maxVideoBytes = (seconds: number) => Math.min(360, Math.max(60, Math.ceil((seconds * 200) / 1024))) * 1024 * 1024;
/** Past this length, frames are taken by jumping to each moment, so a long video isn't decoded end to end. */
export const SEEK_FROM = 300;
/** Speech is heard in pieces this long, side by side, so a long video is quick and stays under the service's limit. */
export const HEAR_CHUNK_SECONDS = 600;

/** Download a URL into memory, refusing anything over `maxBytes`. */
export async function downloadBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetchRetry(url, { signal, headers: { "user-agent": "Mozilla/5.0 (KnowingBot)" } }, "Downloading the video");
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

/** Download a URL straight to a file, so a long video never sits in memory. Refuses anything over `maxBytes`. */
export async function downloadToFile(url: string, path: string, maxBytes: number): Promise<void> {
  const res = await fetchRetry(url, { headers: { "user-agent": "Mozilla/5.0 (KnowingBot)" } }, "Downloading the video");
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  if (Number(res.headers.get("content-length") || 0) > maxBytes) throw new Error("That video is too large.");
  const file = await open(path, "w");
  try {
    const reader = res.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("That video is too large.");
      }
      await file.write(value);
    }
  } finally {
    await file.close();
  }
}

function ffmpeg(args: string[], timeout = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg is not available on this server"));
    execFile(ffmpegPath, ["-hide_banner", ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
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

/** When each frame left the filter, from ffmpeg's showinfo lines ("pts_time:12.5"), in seconds. */
export function shownTimes(ffmpegOutput: string): number[] {
  return [...ffmpegOutput.matchAll(/\bpts_time:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Math.max(0, Number(m[1])));
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

/** Run `work` on each item, a few at a time. */
async function inBatches<T, R>(items: T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map((item, j) => work(item, i + j)))));
  return out;
}

/** One frame at each of `times` (seconds), by jumping straight there. Frames that can't be taken are left out, with their times. */
async function seekFrames(input: string, dir: string, prefix: string, times: number[]): Promise<{ frames: string[]; times: number[] }> {
  const got = await inBatches(times, 6, async (t, i) => {
    const out = join(dir, `${prefix}${String(i).padStart(3, "0")}.jpg`);
    try {
      await ffmpeg(["-loglevel", "error", "-ss", t.toFixed(2), "-i", input, "-vf", SCALE, "-frames:v", "1", "-q:v", "5", out]);
      return { frame: (await readFile(out)).toString("base64"), t };
    } catch {
      return null;
    }
  });
  const kept = got.filter((g): g is { frame: string; t: number } => Boolean(g));
  return { frames: kept.map((g) => g.frame), times: kept.map((g) => g.t) };
}

/** Evenly spaced moments for reading the screen of a long video: SCAN_MAX of them, each in the middle of its stretch. */
export function scanTimes(durationSec: number): number[] {
  const gap = durationSec / SCAN_MAX;
  return Array.from({ length: SCAN_MAX }, (_, i) => Math.round((i + 0.5) * gap * 100) / 100);
}

type Watched = { frames: string[]; frameTimes: number[]; transcript: string; screenText: string; notes: string[]; cut: boolean };

/** Frames, speech and on-screen text from one video. Only the first `limit` seconds count. */
async function watchVideoBytes(video: Buffer, durationHint: number, limit = MAX_SECONDS): Promise<Watched> {
  const dir = await mkdtemp(join(tmpdir(), "knowing-"));
  try {
    const input = join(dir, "in.mp4");
    await writeFile(input, video);
    return await watchVideoFile(input, dir, durationHint, limit);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A video already on disk, in its own folder `dir`. */
async function watchVideoFile(input: string, dir: string, durationHint: number, limit: number): Promise<Watched> {
  const notes: string[] = [];
  const jpegs = async (prefix: string) => {
    const names = (await readdir(dir)).filter((n) => new RegExp(`^${prefix}\\d+\\.jpg$`).test(n)).sort();
    return Promise.all(names.map(async (n) => (await readFile(join(dir, n))).toString("base64")));
  };
  const full = durationHint || (await probeDuration(input));
  // Past the limit nothing is watched, heard or read, so a long video costs no more than one at the limit.
  const duration = Math.min(full, limit);
  const cut = full > limit;
  if (cut) notes.push(`It's over ${limit / 60} minutes long, so I watched the first ${limit / 60}.`);
  const long = duration > SEEK_FROM;

  let frames: string[] = [];
  let frameTimes: number[] = [];
  try {
    if (long) {
      ({ frames, times: frameTimes } = await seekFrames(input, dir, "f", frameFilterTimes(FRAME_COUNT, duration)));
      if (!frames.length) throw new Error("No frames");
    } else {
      await ffmpeg(["-loglevel", "error", "-t", String(limit), "-i", input, "-vf", frameFilter(FRAME_COUNT, duration), "-frames:v", String(FRAME_COUNT), "-q:v", "5", join(dir, "f%02d.jpg")]);
      frames = await jpegs("f");
      frameTimes = frameFilterTimes(FRAME_COUNT, duration).slice(0, frames.length);
    }
  } catch (error) {
    console.error("Frame extraction failed", error);
    notes.push("Couldn't pull frames from the video.");
  }

  // Hearing and reading the screen run side by side, and either can fail without losing the save.
  const [transcript, screenText] = await Promise.all([hear(input, dir, duration, limit, notes), readScreen(input, dir, duration, limit, jpegs)]);
  return { frames, frameTimes, transcript, screenText, notes, cut };
}

/** The speech in a video, or "" when there's no audio or no transcription key. A long one is heard in pieces, side by side. */
async function hear(input: string, dir: string, duration: number, limit: number, notes: string[]): Promise<string> {
  if (!isTranscriptionConfigured()) {
    notes.push("I can't hear audio yet (no OPENAI_API_KEY), so I only looked at it.");
    return "";
  }
  try {
    const pieces = Math.max(1, Math.ceil((duration || limit) / HEAR_CHUNK_SECONDS));
    const words = await inBatches(Array.from({ length: pieces }, (_, i) => i), 3, async (i) => {
      const audio = join(dir, `audio${i}.m4a`);
      const start = i * HEAR_CHUNK_SECONDS;
      const length = Math.min(HEAR_CHUNK_SECONDS, limit - start);
      await ffmpeg(["-loglevel", "error", ...(start ? ["-ss", String(start)] : []), "-t", String(length), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio], 120_000);
      return transcribeAudio(new Blob([new Uint8Array(await readFile(audio))], { type: "audio/mp4" }), undefined, "audio.m4a");
    });
    chargeAudio(duration);
    return words.map((w) => w.trim()).filter(Boolean).join(" ");
  } catch (error) {
    // No audio track, or the transcription service failed.
    console.error("Audio failed", error);
    return "";
  }
}

/** The text shown on screen across the whole video, or "" if it can't be read. */
async function readScreen(input: string, dir: string, duration: number, limit: number, jpegs: (prefix: string) => Promise<string[]>): Promise<string> {
  if (!isAiConfigured()) return "";
  try {
    if (duration > SEEK_FROM) {
      const { frames, times } = await seekFrames(input, dir, "s", scanTimes(duration));
      return await readScreenText(frames, times);
    }
    // showinfo logs when each kept frame was taken (mpdecimate drops still ones, so they aren't evenly spaced).
    const log = await ffmpeg(["-nostats", "-loglevel", "info", "-t", String(limit), "-i", input, "-vf", `${scanFilter(duration)},showinfo`, "-fps_mode", "vfr", "-frames:v", String(SCAN_MAX), "-q:v", "5", join(dir, "s%02d.jpg")]);
    const frames = await jpegs("s");
    const times = shownTimes(log).slice(0, frames.length);
    return await readScreenText(frames, times.length === frames.length ? times : []);
  } catch (error) {
    console.error("Reading the screen failed", error);
    return "";
  }
}

/** Download a video to disk and watch it. */
async function watchLink(url: string, durationHint: number, limit: number): Promise<Watched> {
  const dir = await mkdtemp(join(tmpdir(), "knowing-"));
  try {
    const input = join(dir, "in.mp4");
    await downloadToFile(url, input, maxVideoBytes(limit));
    return await watchVideoFile(input, dir, durationHint, limit);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The words in a voice message, from its first VOICE_MAX_SECONDS only, so a long one costs no more than a short one. */
async function hearVoiceBytes(voice: Buffer, durationHint: number): Promise<{ text: string; cut: boolean }> {
  if (!isTranscriptionConfigured()) throw new NoTranscription();
  const dir = await mkdtemp(join(tmpdir(), "knowing-voice-"));
  try {
    const input = join(dir, "voice.ogg");
    await writeFile(input, voice);
    const duration = durationHint || (await probeDuration(input));
    const audio = join(dir, "voice.m4a");
    await ffmpeg(["-loglevel", "error", "-t", String(VOICE_MAX_SECONDS), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
    const text = await transcribeAudio(new Blob([new Uint8Array(await readFile(audio))], { type: "audio/mp4" }), undefined, "voice.m4a");
    chargeAudio(Math.min(duration, VOICE_MAX_SECONDS));
    return { text: text.trim(), cut: duration > VOICE_MAX_SECONDS };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
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
    async fromLink(url: string, maxSeconds = MAX_SECONDS): Promise<WatchInput> {
      const limit = Math.min(maxSeconds, PLAN_MAX_SECONDS);
      if (isTikTok(url)) {
        try {
          const post = await resolveTikTok(url);
          if (post.images.length) {
            return { frames: await imagesToFrames(post.images), transcript: "", caption: post.caption, notes: [] };
          }
          const watched = await watchLink(post.videoUrl, post.durationSec, limit);
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
      if (isVideoFileLink(url)) return { ...(await watchLink(url, 0, limit)), caption: "" };
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

    async fromTelegramFile(fileId: string, durationSec: number, limit = MAX_SECONDS): Promise<WatchInput> {
      const bytes = await downloadBytes(await fileUrl(fileId), 20 * 1024 * 1024);
      const watched = await watchVideoBytes(bytes, durationSec, Math.min(limit, PLAN_MAX_SECONDS));
      return { ...watched, caption: "" };
    },

    async hearVoice(fileId: string, durationSec: number): Promise<{ text: string; cut: boolean }> {
      if (!isTranscriptionConfigured()) throw new NoTranscription();
      return hearVoiceBytes(await downloadBytes(await fileUrl(fileId), 20 * 1024 * 1024), durationSec);
    },
  };
}
