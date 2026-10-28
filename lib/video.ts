/**
 * Browser-side video processing. The video never leaves the device whole:
 * Knowing grabs a few frames as small JPEGs and pulls the audio out as short
 * 16 kHz WAV chunks, and only those are sent to the server.
 */
import { VIDEO } from "./constants";
import { chunkRanges, encodeWav, frameTimes, isSilent, mixToMono } from "./video-math";

/** One frame grabbed from the video. */
export interface VideoFrame {
  /** Seconds into the video. */
  at: number;
  /** Base64 JPEG data, without the `data:` prefix. */
  data: string;
}

/** One chunk of audio, ready to upload for transcription. */
export interface AudioChunk {
  /** Seconds into the video where this chunk starts. */
  start: number;
  wav: Blob;
}

/** A video file problem the user can fix. */
export class VideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoError";
  }
}

/** Load a video element for a file and wait for its metadata. */
async function loadVideo(file: File): Promise<{ video: HTMLVideoElement; release: () => void }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  const release = () => {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new VideoError("This browser can't open that video. Try an MP4 or MOV file."));
    });
  } catch (error) {
    release();
    throw error;
  }
  return { video, release };
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = time;
  });
}

/** Read the video's length in seconds and check it against the limits. */
export async function checkVideo(file: File): Promise<number> {
  if (file.size > VIDEO.maxFileBytes) {
    throw new VideoError(`That file is too big. Videos can be up to ${Math.round(VIDEO.maxFileBytes / 1024 / 1024)} MB.`);
  }
  const { video, release } = await loadVideo(file);
  const duration = video.duration;
  release();
  if (!Number.isFinite(duration) || duration <= 0) throw new VideoError("Couldn't read how long that video is.");
  if (duration > VIDEO.maxDurationSec) {
    throw new VideoError(`That video is too long. Videos can be up to ${VIDEO.maxDurationSec / 60} minutes.`);
  }
  return duration;
}

/** Grab evenly spaced frames as small JPEGs. */
export async function extractFrames(file: File, count: number = VIDEO.frames): Promise<VideoFrame[]> {
  const { video, release } = await loadVideo(file);
  try {
    const scale = Math.min(1, VIDEO.frameMaxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx || !video.videoWidth) return [];
    const frames: VideoFrame[] = [];
    for (const at of frameTimes(video.duration, count)) {
      await seek(video, at);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", VIDEO.jpegQuality).split(",")[1] ?? "";
      if (data && data.length <= VIDEO.frameChars) frames.push({ at, data });
    }
    return frames;
  } finally {
    release();
  }
}

/**
 * Pull the audio out as mono 16 kHz WAV chunks. Silent chunks are skipped.
 * Returns an empty list when the video has no audio track.
 */
export async function extractAudio(file: File): Promise<AudioChunk[]> {
  const bytes = await file.arrayBuffer();
  // Decoding into a 16 kHz context resamples as it decodes, which keeps memory low.
  const ctx = new OfflineAudioContext(1, 1, VIDEO.sampleRate);
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch {
    return [];
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const mono = mixToMono(channels);
  const rate = decoded.sampleRate;
  return chunkRanges(mono.length, VIDEO.chunkSec * rate)
    .map(([start, end]) => ({ start, samples: mono.subarray(start, end) }))
    .filter(({ samples }) => !isSilent(samples))
    .map(({ start, samples }) => ({ start: start / rate, wav: new Blob([encodeWav(samples, rate)], { type: "audio/wav" }) }));
}
