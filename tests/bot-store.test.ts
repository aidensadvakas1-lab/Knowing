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
