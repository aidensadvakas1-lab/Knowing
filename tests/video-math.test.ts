import { describe, expect, it } from "vitest";
import { chunkRanges, encodeWav, formatTimestamp, frameTimes, isSilent, mixToMono } from "@/lib/video-math";

describe("frameTimes", () => {
  it("spreads frames evenly and skips the very start and end", () => {
    expect(frameTimes(90, 2)).toEqual([30, 60]);
    const times = frameTimes(61, 8);
    expect(times).toHaveLength(8);
    expect(times[0]).toBeGreaterThan(0);
    expect(times.at(-1)).toBeLessThan(61);
  });

  it("returns nothing for a missing or zero duration", () => {
    expect(frameTimes(0)).toEqual([]);
    expect(frameTimes(Number.NaN)).toEqual([]);
    expect(frameTimes(Infinity)).toEqual([]);
  });
});

describe("chunkRanges", () => {
  it("covers every sample with a short last chunk", () => {
    expect(chunkRanges(250, 100)).toEqual([
      [0, 100],
      [100, 200],
      [200, 250],
    ]);
    expect(chunkRanges(0, 100)).toEqual([]);
  });
});

describe("formatTimestamp", () => {
  it("formats minutes and hours", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(75.9)).toBe("1:15");
    expect(formatTimestamp(3_725)).toBe("1:02:05");
  });
});

describe("mixToMono", () => {
  it("averages channels", () => {
    const out = mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });
});

describe("encodeWav", () => {
  it("writes a valid 16-bit mono PCM header and clamps samples", () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(buf);
    const ascii = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(36)).toBe("data");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(buf.byteLength).toBe(52);
    expect(view.getInt16(46, true)).toBe(32_767);
    expect(view.getInt16(48, true)).toBe(-32_768);
    expect(view.getInt16(50, true)).toBe(32_767);
  });

  it("keeps a 60 second chunk under the hosting body limit", () => {
    expect(encodeWav(new Float32Array(60 * 16_000), 16_000).byteLength).toBeLessThan(4_000_000);
  });
});

describe("isSilent", () => {
  it("tells silence from speech", () => {
    expect(isSilent(new Float32Array(100))).toBe(true);
    expect(isSilent(new Float32Array(100).fill(0.3))).toBe(false);
  });
});
