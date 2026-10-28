/**
 * Pure helpers for video processing: where to grab frames, how to split
 * audio, and how to encode it as WAV. Kept free of browser APIs so they can
 * be unit tested.
 */
import { VIDEO } from "./constants";

/**
 * Evenly spaced timestamps (seconds) to grab frames at. Skips the very first
 * and last moments, which are often black or a logo.
 */
export function frameTimes(durationSec: number, count: number = VIDEO.frames): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || count <= 0) return [];
  const step = durationSec / (count + 1);
  return Array.from({ length: count }, (_, i) => Math.round(step * (i + 1) * 100) / 100);
}

/** Split `total` samples into [start, end) ranges of at most `size` samples. */
export function chunkRanges(total: number, size: number): Array<[number, number]> {
  if (total <= 0 || size <= 0) return [];
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < total; start += size) ranges.push([start, Math.min(total, start + size)]);
  return ranges;
}

/** Format seconds as m:ss (or h:mm:ss for long videos). */
export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Average any number of channels into one mono channel. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) out[i] += channel[i] / channels.length;
  return out;
}

/** Encode mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** True when a chunk is effectively silent, so it isn't worth transcribing. */
export function isSilent(samples: Float32Array, threshold = 0.01): boolean {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length === 0 || Math.sqrt(sum / samples.length) < threshold;
}
