import { describe, expect, it, vi } from "vitest";
import { MemoryStore, newUser } from "@/lib/bot/store";
import type { Brain, Save, TelegramApi } from "@/lib/bot/types";
import { lastSitting, sendWrapUps, SITTING_GAP_MS, STALE_MS } from "@/lib/bot/wrapup";

const T0 = Date.parse("2026-10-30T08:00:00Z");
const MIN = 60_000;

function save(id: string, at: number, userId = 7): Save {
  return { id, userId, title: `Save ${id}`, topic: "Siege, Bank", type: "setup", summary: "", steps: [], details: "", needsWords: false, words: "", source: "", sourceUrl: "", practiced: 0, createdAt: new Date(at).toISOString() };
}

function setup() {
  const store = new MemoryStore();
  const sent: Array<{ chatId: number; html: string; buttons?: unknown }> = [];
  const tg = { sendMessage: vi.fn(async (chatId: number, html: string, buttons?: unknown) => (sent.push({ chatId, html, buttons }), 1)) } as unknown as TelegramApi;
  const brain = { wrapUp: vi.fn(async ({ kept }: { kept: Save[] }) => `From that scroll you kept **${kept.length}**.`) } as unknown as Brain;
  const alerts: string[] = [];
  return { store, sent, deps: { tg, store, brain, alert: async (t: string) => void alerts.push(t) }, brain, alerts };
}

/** User 7 saved these videos at these minutes after T0, the way the bot records them. Returns the last time. */
async function shared(store: MemoryStore, minutes: Record<string, number>) {
  await store.saveUser(newUser(7));
  let last = 0;
  for (const [id, m] of Object.entries(minutes)) {
    const s = save(id, T0 + m * MIN);
    await store.addSave(s);
    await store.touchSitting(7, s.createdAt);
    last = Date.parse(s.createdAt);
  }
  return last;
}

const keptIds = (brain: Brain) => vi.mocked(brain.wrapUp).mock.calls.at(-1)?.[0].kept.map((s) => s.id);

describe("lastSitting", () => {
  it("takes the newest run of saves made close together, oldest first", () => {
    const saves = [save("d", T0 + 40 * MIN), save("c", T0 + 30 * MIN), save("b", T0 + 20 * MIN), save("a", T0)];
    expect(lastSitting(saves).map((s) => s.id)).toEqual(["b", "c", "d"]);
    expect(lastSitting([])).toEqual([]);
  });
});

describe("sendWrapUps", () => {
  it("waits until they've stopped sharing, then sends one wrap-up with a button per save", async () => {
    const { store, sent, deps, brain } = setup();
    const last = await shared(store, { a: 0, b: 1, c: 2 });
    expect(await sendWrapUps(deps, last + SITTING_GAP_MS - 1)).toBe(0);
    expect(await sendWrapUps(deps, last + SITTING_GAP_MS)).toBe(1);
    expect(sent[0]?.chatId).toBe(7);
    expect(sent[0]?.html).toContain("<b>3</b>");
    expect(sent[0]?.buttons).toEqual([[{ text: "Save a", callback_data: "show:a" }], [{ text: "Save b", callback_data: "show:b" }], [{ text: "Save c", callback_data: "show:c" }]]);
    expect(keptIds(brain)).toEqual(["a", "b", "c"]);
    expect(await sendWrapUps(deps, last + 2 * SITTING_GAP_MS)).toBe(0);
    expect((await store.getUser(7)).sitting).toBeNull();
  });

  it("only covers the latest scroll, not one from earlier", async () => {
    const { store, deps, brain } = setup();
    const last = await shared(store, { old1: 0, old2: 1, old3: 2, a: 60, b: 61, c: 62 });
    await sendWrapUps(deps, last + SITTING_GAP_MS);
    expect(keptIds(brain)).toEqual(["a", "b", "c"]);
    expect(vi.mocked(brain.wrapUp).mock.calls[0]?.[0].others.map((s) => s.id)).toEqual(["old3", "old2", "old1"]);
  });

  it("keeps every video when several were watched at once and the user row was saved late", async () => {
    const { store, deps, brain } = setup();
    const stale = await store.getUser(7);
    const last = await shared(store, { a: 0, b: 0.2, c: 0.4 });
    await store.saveUser(stale); // a slow watch finishing with an old copy of the user
    expect((await store.getUser(7)).sitting?.last).toBe(new Date(last).toISOString());
    await sendWrapUps(deps, last + SITTING_GAP_MS);
    expect(keptIds(brain)).toEqual(["a", "b", "c"]);
  });

  it("skips short sittings, since each video already got its own reply", async () => {
    const { store, sent, deps } = setup();
    const last = await shared(store, { a: 0, b: 1 });
    expect(await sendWrapUps(deps, last + SITTING_GAP_MS)).toBe(0);
    expect(sent).toEqual([]);
    expect((await store.getUser(7)).sitting).toBeNull();
  });

  it("drops a sitting that's hours old instead of wrapping it up out of nowhere", async () => {
    const { store, sent, deps } = setup();
    const last = await shared(store, { a: 0, b: 1, c: 2 });
    expect(await sendWrapUps(deps, last + STALE_MS + 1)).toBe(0);
    expect(sent).toEqual([]);
    expect((await store.getUser(7)).sitting).toBeNull();
  });

  it("doesn't end a sitting they've added to since it was read", async () => {
    const { store } = setup();
    const last = await shared(store, { a: 0 });
    await store.touchSitting(7, new Date(last + MIN).toISOString());
    expect(await store.closeSitting(7, new Date(last).toISOString())).toBe(false);
    expect((await store.getUser(7)).sitting).not.toBeNull();
  });

  it("tells the owner if one wrap-up fails and doesn't retry it forever", async () => {
    const { store, deps, brain, alerts } = setup();
    const last = await shared(store, { a: 0, b: 1, c: 2 });
    vi.mocked(brain.wrapUp).mockRejectedValueOnce(new Error("api down"));
    expect(await sendWrapUps(deps, last + SITTING_GAP_MS)).toBe(0);
    expect(alerts[0]).toContain("api down");
    expect((await store.getUser(7)).sitting).toBeNull();
  });
});
