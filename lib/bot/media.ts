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
import { isTranscriptionConfigured, transcribeAudio } from "../transcribe";
import { isTikTok, resolveTikTok } from "./tiktok";
import type { Media, WatchInput } from "./types";

/** Frames shown to Claude per video. */
export const FRAME_COUNT = 8;
/** Longest side of each frame, in pixels. */
const FRAME_SIDE = 768;
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

/** The ffmpeg filter that spreads `count` frames across `durationSec` and shrinks them. */
export function frameFilter(count: number, durationSec: number): string {
  const fps = durationSec > 0 ? `fps=${count}/${Math.max(1, durationSec).toFixed(2)}` : "fps=1/2";
  const scale = `scale='if(gt(iw,ih),min(${FRAME_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${FRAME_SIDE},ih))'`;
  return `${fps},${scale}`;
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

/** Frames plus speech from one video file. */
async function watchVideoBytes(video: Buffer, durationHint: number): Promise<{ frames: string[]; transcript: string; notes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "knowing-"));
  const notes: string[] = [];
  try {
    const input = join(dir, "in.mp4");
    await writeFile(input, video);
    const duration = durationHint || (await probeDuration(input));

    let frames: string[] = [];
    try {
      await ffmpeg(["-loglevel", "error", "-i", input, "-vf", frameFilter(FRAME_COUNT, duration), "-frames:v", String(FRAME_COUNT), "-q:v", "5", join(dir, "f%02d.jpg")]);
      const names = (await readdir(dir)).filter((n) => /^f\d+\.jpg$/.test(n)).sort();
      frames = await Promise.all(names.map(async (n) => (await readFile(join(dir, n))).toString("base64")));
    } catch (error) {
      console.error("Frame extraction failed", error);
      notes.push("Couldn't pull frames from the video.");
    }

    let transcript = "";
    if (isTranscriptionConfigured()) {
      try {
        const audio = join(dir, "audio.m4a");
        await ffmpeg(["-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
        transcript = await transcribeAudio(new Blob([new Uint8Array(await readFile(audio))], { type: "audio/mp4" }), undefined, "audio.m4a");
      } catch (error) {
        // No audio track, or the transcription service failed.
        console.error("Audio failed", error);
      }
    } else {
      notes.push("I can't hear audio yet (no OPENAI_API_KEY), so I only looked at it.");
    }
    return { frames, transcript, notes };
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
        await ffmpeg(["-loglevel", "error", "-i", src, "-vf", frameFilter(1, 0).split(",")[1] ?? "", "-frames:v", "1", "-q:v", "5", jpg]);
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
      // YouTube transcripts and articles: text only.
      const fetched = await fetchSource(url);
      return { frames: [], transcript: fetched.text, caption: fetched.title, notes: fetched.warning ? [fetched.warning] : [] };
    },

    async fromTelegramFile(fileId: string, durationSec: number): Promise<WatchInput> {
      const bytes = await downloadBytes(await fileUrl(fileId), 20 * 1024 * 1024);
      const watched = await watchVideoBytes(bytes, durationSec);
      return { ...watched, caption: "" };
    },
  };
}
