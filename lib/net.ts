/**
 * fetch, tried again when the connection drops. A dropped connection
 * ("fetch failed", a reset socket, a timeout) or a busy answer (429, 502,
 * 503, 504) is almost always gone a moment later, so one blip shouldn't lose
 * a video someone just sent. Anything else (a 400, a 404, a refused key) is
 * returned at once, since trying again wouldn't change it.
 */

/** Statuses worth one more try: busy or a gateway between us and them hiccupped. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Waits before the second and third tries. */
const WAITS_MS = [400, 1_200];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The low-level reason a fetch failed, like ECONNRESET, if Node gave one. */
export function networkCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message.slice(0, 80);
  return "";
}

/** A connection that dropped or never opened, as opposed to an answer we didn't like. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|UND_ERR/i.test(`${error.message} ${networkCode(error)}`);
}

export class NetworkError extends Error {
  constructor(label: string, readonly original: unknown) {
    const code = networkCode(original);
    super(`${label}: couldn't connect after ${WAITS_MS.length + 1} tries${code ? ` (${code})` : ""}`);
    this.name = "NetworkError";
  }
}

/**
 * fetch with up to 3 tries. `label` names the service ("Supabase", "Telegram")
 * so an alert says where it broke. A request that was cancelled isn't tried again.
 */
export async function fetchRetry(url: string, init: RequestInit = {}, label = "A request"): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= WAITS_MS.length;
    try {
      const res = await fetch(url, init);
      if (last || !RETRY_STATUSES.has(res.status)) return res;
      // Telegram and others say how long to wait when they're busy; only short waits are worth it here.
      const after = Number(res.headers.get("retry-after") ?? 0) * 1_000;
      await res.body?.cancel().catch(() => {});
      await sleep(after > 0 && after <= 5_000 ? after : (WAITS_MS[attempt] ?? 0));
    } catch (error) {
      if (init.signal?.aborted || !isNetworkError(error)) throw error;
      if (last) throw new NetworkError(label, error);
      await sleep(WAITS_MS[attempt] ?? 0);
    }
  }
}
