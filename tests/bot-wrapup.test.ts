import { describe, expect, it, vi } from "vitest";
import { MemoryStore, newUser } from "@/lib/bot/store";
import type { Brain, Save, TelegramApi } from "@/lib/bot/types";
import { QUIET_MS, SITTING_GAP_MS, sendWrapUps, trackSitting } from "@/lib/bot/wrapup";

const T0 = Date.parse("2026-10-30T08:00:00Z");

function save(id: string, userId = 7): Save {
  return { id, userId, title: `Save ${id}`, topic: "Siege, Bank", type: "setup", summary: "", steps: [], details: "", needsWords: false, words: "", source: "", sourceUrl: "", practiced: 0, createdAt: new Date(T0).toISOString() };
}

function setup() {
  const store = new MemoryStore();
  const sent: Array<{ chatId: number; html: string; buttons?: unknown }> = [];
  const tg = { sendMessage: vi.fn(async (chatId: number, html: string, buttons?: unknown) => (sent.push({ chatId, html, buttons }), 1)) } as unknown as TelegramApi;
  const brain = { wrapUp: vi.fn(async ({ kept }: { kept: Save[] }) => `From that scroll you kept **${kept.length}**.`) } as unknown as Brain;
  const alerts: string[] = [];
  return { store, sent, deps: { tg, store, brain, alert: async (t: string) => void alerts.push(t) }, brain, alerts };
}

/** A user who shared `ids` a minute apart, starting at T0. */
async function shared(store: MemoryStore, ids: string[], userId = 7) {
  const user = newUser(userId);
  ids.forEach((id, i) => {
    trackSitting(user, id, T0 + i * 60_000);
    store.saves.unshift(save(id, userId));
  });
  await store.saveUser(user);
  return T0 + (ids.length - 1) * 60_000;
}

describe("trackSitting", () => {
  it("groups shares close together and starts over after a long gap", () => {
    const user = newUser(7);
    trackSitting(user, "a", T0);
    trackSitting(user, "b", T0 + 5 * 60_000);
    expect(user.sitting?.ids).toEqual(["a", "b"]);
    trackSitting(user, "c", T0 + 5 * 60_000 + SITTING_GAP_MS + 1);
    expect(user.sitting?.ids).toEqual(["c"]);
  });
});

describe("sendWrapUps", () => {
  it("waits until they've stopped sharing, then sends one wrap-up with a button per save", async () => {
    const { store, sent, deps, brain } = setup();
    const last = await shared(store, ["a", "b", "c"]);
    expect(await sendWrapUps(deps, last + QUIET_MS - 1)).toBe(0);
    expect(await sendWrapUps(deps, last + QUIET_MS)).toBe(1);
    expect(sent[0]?.chatId).toBe(7);
    expect(sent[0]?.html).toContain("<b>3</b>");
    expect(sent[0]?.buttons).toEqual([[{ text: "Save a", callback_data: "show:a" }], [{ text: "Save b", callback_data: "show:b" }], [{ text: "Save c", callback_data: "show:c" }]]);
    expect(vi.mocked(brain.wrapUp).mock.calls[0]?.[0].kept.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(await sendWrapUps(deps, last + 2 * QUIET_MS)).toBe(0);
    expect((await store.getUser(7)).sitting).toBeNull();
  });

  it("skips short sittings, since each video already got its own reply", async () => {
    const { store, sent, deps } = setup();
    const last = await shared(store, ["a", "b"]);
    expect(await sendWrapUps(deps, last + QUIET_MS)).toBe(0);
    expect(sent).toEqual([]);
    expect((await store.getUser(7)).sitting).toBeNull();
  });

  it("leaves out saves that were deleted or replaced in the meantime", async () => {
    const { store, deps, brain } = setup();
    const last = await shared(store, ["a", "b", "c", "d"]);
    await store.deleteSave(7, "b");
    await sendWrapUps(deps, last + QUIET_MS);
    expect(vi.mocked(brain.wrapUp).mock.calls[0]?.[0].kept.map((s) => s.id)).toEqual(["a", "c", "d"]);
  });

  it("tells the owner if one wrap-up fails and still clears the sitting", async () => {
    const { store, deps, brain, alerts } = setup();
    const last = await shared(store, ["a", "b", "c"]);
    vi.mocked(brain.wrapUp).mockRejectedValueOnce(new Error("api down"));
    expect(await sendWrapUps(deps, last + QUIET_MS)).toBe(0);
    expect(alerts[0]).toContain("api down");
    expect((await store.getUser(7)).sitting).toBeNull();
  });
});
