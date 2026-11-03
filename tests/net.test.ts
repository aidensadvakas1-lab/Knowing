import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRetry, isNetworkError, NetworkError } from "@/lib/net";

/** What Node's fetch throws when the connection drops. */
const dropped = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Runs a fetchRetry call with the waits skipped. */
async function run<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const result = call();
  result.catch(() => {});
  await vi.runAllTimersAsync();
  return result;
}

describe("fetchRetry", () => {
  it("tries again when the connection drops, so one blip doesn't lose anything", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const res = await run(() => fetchRetry("https://example.test", {}, "Supabase"));
    expect(await res.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("tries again when a service is busy (503, 429), not when it refuses (400)", async () => {
    const busy = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", busy);
    expect((await run(() => fetchRetry("https://example.test"))).status).toBe(200);
    expect(busy).toHaveBeenCalledTimes(3);

    const refused = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", refused);
    expect((await run(() => fetchRetry("https://example.test"))).status).toBe(400);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("after 3 tries, says which service it couldn't reach and why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(dropped())));
    const error = await run(() => fetchRetry("https://example.test", {}, "Supabase POST saves")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe("Supabase POST saves: couldn't connect after 3 tries (ECONNRESET)");
  });

  it("doesn't try again after a cancel or a mistake in the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    vi.stubGlobal("fetch", fetch);
    await expect(run(() => fetchRetry("https://example.test", { signal: controller.signal }))).rejects.toThrow("aborted");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(isNetworkError(new TypeError("Failed to parse URL from nope"))).toBe(false);
    expect(isNetworkError(dropped())).toBe(true);
  });
});
