import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { transcribeAudio, transcribeErrorFor, TranscribeError } = await import("@/lib/transcribe");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("transcribeErrorFor", () => {
  it("maps statuses to stable codes", () => {
    expect(transcribeErrorFor(401).code).toBe("not_configured");
    expect(transcribeErrorFor(429).code).toBe("rate_limited");
    expect(transcribeErrorFor(413).code).toBe("too_large");
    expect(transcribeErrorFor(500).code).toBe("upstream_error");
  });
});

describe("transcribeAudio", () => {
  it("posts the audio with the key and model and returns the text", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchMock = vi.fn(async () => Response.json({ text: "  hello there  " }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(new Blob(["x"], { type: "audio/wav" }))).resolves.toBe("hello there");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect((init.body as FormData).get("model")).toBeTruthy();
  });

  it("uses a custom endpoint when set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.stubEnv("KNOWING_TRANSCRIBE_URL", "https://api.groq.com/openai/v1/audio/transcriptions");
    const fetchMock = vi.fn(async () => Response.json({ text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribeAudio(new Blob(["x"]));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("groq.com");
  });

  it("throws a coded error on failure", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(transcribeAudio(new Blob(["x"]))).rejects.toBeInstanceOf(TranscribeError);
  });
});
