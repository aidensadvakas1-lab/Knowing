import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/instagram/route";

// The route pulls in server-only modules, which refuse to load outside Next.
vi.mock("server-only", () => ({}));

const signed = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const post = (body: string, signature?: string) =>
  POST(new Request("https://knowing.test/api/instagram", { method: "POST", body, headers: signature ? { "x-hub-signature-256": signature } : {} }));

afterEach(() => vi.unstubAllEnvs());

describe("/api/instagram", () => {
  it("answers Meta's check with the challenge only when the verify token matches", async () => {
    vi.stubEnv("INSTAGRAM_VERIFY_TOKEN", "long random phrase");
    const ok = await GET(new Request("https://knowing.test/api/instagram?hub.mode=subscribe&hub.verify_token=long%20random%20phrase&hub.challenge=12345"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const wrong = await GET(new Request("https://knowing.test/api/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345"));
    expect(wrong.status).toBe(403);
  });

  it("refuses the check when no verify token is set", async () => {
    vi.stubEnv("INSTAGRAM_VERIFY_TOKEN", "");
    const res = await GET(new Request("https://knowing.test/api/instagram?hub.mode=subscribe&hub.verify_token=&hub.challenge=1"));
    expect(res.status).toBe(403);
  });

  it("refuses deliveries without Meta's signature, and accepts either app secret", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "ig-secret");
    vi.stubEnv("META_APP_SECRET", "meta-secret");
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect((await post(body)).status).toBe(403);
    expect((await post(body, signed(body, "someone-else"))).status).toBe(403);
    expect((await post(body, signed(body, "ig-secret"))).status).toBe(200);
    expect((await post(body, signed(body, "meta-secret"))).status).toBe(200);
  });

  it("refuses everything when no secret is set", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "");
    vi.stubEnv("META_APP_SECRET", "");
    const body = "{}";
    expect((await post(body, signed(body, ""))).status).toBe(403);
  });
});
