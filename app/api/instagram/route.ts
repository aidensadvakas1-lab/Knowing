/**
 * GET/POST /api/instagram
 *
 * Meta's webhook for Knowing's Instagram account. GET is Meta checking the
 * webhook when it's added in the App Dashboard. POST is a DM to the account:
 * a link code from /instagram, or a Reel someone shared. It answers Meta right
 * away and does the watching after, like the Telegram webhook.
 *
 * Every POST must carry Meta's signature (X-Hub-Signature-256, made with
 * INSTAGRAM_APP_SECRET or META_APP_SECRET), so nobody else can push videos into someone's library.
 * Setup is in docs/INSTAGRAM.md.
 */
import { after } from "next/server";
import { createDeps, missingSettings, webhookSecrets } from "@/lib/bot/deps";
import { handleInstagram, secretMatches } from "@/lib/bot/handle";
import { instagramEvents, signatureMatches } from "@/lib/bot/instagram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Message ids already handled by this server instance, since Meta sometimes delivers one twice. */
const seen = new Set<string>();
const SEEN_KEPT = 500;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const token = process.env.INSTAGRAM_VERIFY_TOKEN ?? "";
  if (token && params.get("hub.mode") === "subscribe" && secretMatches(params.get("hub.verify_token") ?? "", token)) {
    return new Response(params.get("hub.challenge") ?? "", { headers: { "content-type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  // Meta signs with the app secret; which one (Instagram's or the Meta app's) depends on how the app was set up, so either works.
  if (!webhookSecrets().some((secret) => signatureMatches(secret, raw, signature))) return new Response("Forbidden", { status: 403 });
  // Meta retries anything that isn't a 200, so a missing setting is logged, not retried forever.
  if (missingSettings().length) {
    console.error("Instagram webhook: the bot is missing settings", missingSettings());
    return new Response("ok");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("ok");
  }
  const events = instagramEvents(body).filter((e) => {
    if (!e.mid) return true;
    if (seen.has(e.mid)) return false;
    seen.add(e.mid);
    if (seen.size > SEEN_KEPT) seen.delete(seen.values().next().value!);
    return true;
  });
  if (!events.length) return new Response("ok");
  const deps = createDeps();
  after(async () => {
    for (const event of events) await handleInstagram(event, deps).catch((error) => console.error("Instagram message failed", error));
  });
  return new Response("ok");
}
