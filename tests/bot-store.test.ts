import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, missingFolderColumn, SupabaseStore } from "@/lib/bot/store";
import type { Save } from "@/lib/bot/types";

const save: Save = { id: "s1", userId: 7, title: "T", topic: "Gym, Legs", folder: "Leg day", type: "tip", summary: "", steps: [], details: "", needsWords: false, sourceUrl: "", words: "", source: "", practiced: 0, createdAt: "2026-11-03T00:00:00Z" };

afterEach(() => vi.unstubAllGlobals());

describe("folders in the database", () => {
  it("still saves a video before the folder column exists, filed by its topic like before", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if ("folder" in body) return new Response(`{"code":"PGRST204","message":"Could not find the 'folder' column of 'saves' in the schema cache"}`, { status: 400 });
        return new Response("", { status: 201 });
      }),
    );
    await new SupabaseStore("https://x.supabase.co", "key").addSave(save);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("folder");
    expect(bodies[1]).toMatchObject({ id: "s1", topic: "Gym, Legs" });
  });

  it("doesn't hide other errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(new SupabaseStore("https://x.supabase.co", "key").addSave(save)).rejects.toThrow("500");
    expect(missingFolderColumn(new Error("Supabase PATCH saves: 400 PGRST204"))).toBe(true);
    expect(missingFolderColumn(new Error("Supabase PATCH saves: 500"))).toBe(false);
  });

  it("moves several saves in one request, only theirs", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body) }), new Response(null, { status: 204 }))));
    await new SupabaseStore("https://x.supabase.co", "key").moveSaves(7, ["a1", "b2"], "Dinner ideas");
    expect(decodeURIComponent(calls[0]!.url)).toBe('https://x.supabase.co/rest/v1/saves?user_id=eq.7&id=in.("a1","b2")');
    expect(JSON.parse(calls[0]!.body)).toEqual({ folder: "Dinner ideas" });
  });

  it("keeps filing rules per person, tidied, and forgets them with /delete", async () => {
    const store = new MemoryStore();
    await store.saveFiling(7, [{ folder: " Car mods ", about: "cars" }, { folder: "", about: "x" }]);
    expect(await store.getFiling(7)).toEqual([{ folder: "Car mods", about: "cars" }]);
    expect(await store.getFiling(8)).toEqual([]);
    await store.deleteUser(7);
    expect(await store.getFiling(7)).toEqual([]);
  });

  it("writes only the collections column, and forgets collections with /delete", async () => {
    const calls: Array<{ url: string; body: string; prefer: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body), prefer: (init.headers as Record<string, string>).prefer ?? "" }), new Response(null, { status: 201 }))));
    await new SupabaseStore("https://x.supabase.co", "key").saveCollections(7, [{ name: " Date night ", ids: ["a1", "a1"] }]);
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/bot_users");
    expect(calls[0]!.prefer).toContain("merge-duplicates");
    expect(JSON.parse(calls[0]!.body)).toEqual({ id: 7, collections: [{ name: "Date night", ids: ["a1"] }] });
    const store = new MemoryStore();
    await store.saveCollections(7, [{ name: "Date night", ids: ["a1"] }]);
    await store.deleteUser(7);
    expect(await store.getCollections(7)).toEqual([]);
  });
});

describe("using one up in the database", () => {
  it("asks the database to do it in one step, and never writes usage with the rest of the user", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body) }), new Response(url.includes("rpc/") ? '"free"' : "", { status: 200 }))));
    const store = new SupabaseStore("https://x.supabase.co", "key");
    expect(await store.spend(7, "videos", { free: 5, planDaily: 0, day: "2026-11-03" })).toBe("free");
    expect(calls[0].url).toContain("/rest/v1/rpc/bot_spend");
    expect(JSON.parse(calls[0].body)).toEqual({ p_id: 7, p_kind: "videos", p_free: 5, p_plan_daily: 0, p_day: "2026-11-03" });
    await store.saveUser({ id: 7, facts: [], turns: [], awaitingWordsFor: null, usage: { day: "", videos: 0, questions: 0 }, sitting: null });
    expect(JSON.parse(calls[1].body)).not.toHaveProperty("usage");
  });

  it("keeps working the old way until the functions are added", async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
        if (url.includes("rpc/")) return new Response('{"code":"PGRST202","message":"Could not find the function public.bot_spend"}', { status: 404 });
        if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify([{ usage: { day: "2026-11-01", videos: 5, questions: 0 }, wallet: { videos: 2 } }]), { status: 200 });
        return new Response(null, { status: 204 });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new SupabaseStore("https://x.supabase.co", "key");
    expect(await store.spend(7, "videos", { free: 5, planDaily: 0, day: "2026-11-03" })).toBe("wallet");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(calls.at(-1)!.body).wallet).toMatchObject({ videos: 1 });
  });
});

describe("costs and /stats in the database", () => {
  it("logs a cost in one step", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body) }), new Response("", { status: 200 }))));
    await new SupabaseStore("https://x.supabase.co", "key").addCost(7, "videos", 0.04, false);
    expect(calls[0].url).toContain("/rest/v1/rpc/bot_add_cost");
    expect(JSON.parse(calls[0].body)).toEqual({ p_id: 7, p_kind: "videos", p_dollars: 0.04, p_ok: false });
  });

  it("reads everything /stats needs a page at a time, and works before bot_costs exists", async () => {
    const urls: string[] = [];
    const users = Array.from({ length: 1_000 }, (_, i) => ({ id: i + 1, usage: { day: "2026-11-01", videos: 1, questions: 0 }, wallet: {}, referral: {}, digest: {}, updated_at: "2026-11-03T00:00:00Z" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("bot_costs")) return new Response('{"code":"42P01","message":"relation \\"bot_costs\\" does not exist"}', { status: 404 });
        if (url.includes("bot_users")) return Response.json(url.includes("offset=0") ? users : [{ ...users[0], id: 1_001 }]);
        if (url.includes("saves")) return Response.json([{ user_id: 5, created_at: "2026-11-03T00:00:00Z", type: "tip", folder: "", topic: "Gym, Legs" }]);
        return Response.json([{ user_id: 5, created_at: "2026-11-03T00:00:00Z" }]);
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await new SupabaseStore("https://x.supabase.co", "key").statsData();
    expect(data.users).toHaveLength(1_001);
    expect(urls.filter((u) => u.includes("bot_users"))).toHaveLength(2);
    expect(data.saves[0]).toEqual({ userId: 5, createdAt: "2026-11-03T00:00:00Z", type: "tip", folder: "Gym" });
    expect(data.chats).toHaveLength(1);
    expect(data.costs).toBeNull();
  });

  it("forgets someone's costs with the rest of them", async () => {
    const store = new MemoryStore();
    await store.addCost(9, "questions", 0.02, true);
    await store.deleteUser(9);
    expect(store.costs).toEqual([]);
  });
});
