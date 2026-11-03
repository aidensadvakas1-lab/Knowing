import { describe, expect, it, vi } from "vitest";
import { ageText, flashback, QUIET_LIMIT, sendFlashbacks, spacedPicks } from "@/lib/bot/digest";
import { MemoryStore } from "@/lib/bot/store";
import type { InlineButton, Save, TelegramApi } from "@/lib/bot/types";

const DAY = 86_400_000;
/** A Sunday, 17:00 UTC. */
const SUNDAY = Date.parse("2026-11-08T17:00:00Z");

const save = (id: string, daysOld: number, topic = "Cooking, Pasta"): Save => ({
  id,
  userId: 1,
  title: `Video ${id}`,
  topic,
  type: "tip",
  summary: "",
  steps: [],
  details: "",
  needsWords: false,
  sourceUrl: `https://www.tiktok.com/@a/video/${id}`,
  words: "",
  source: "",
  practiced: 0,
  createdAt: new Date(SUNDAY - daysOld * DAY).toISOString(),
});

function setup() {
  const sent: Array<{ chatId: number; html: string; buttons?: InlineButton[][] }> = [];
  const tg = { sendMessage: vi.fn(async (chatId: number, html: string, buttons?: InlineButton[][]) => (sent.push({ chatId, html, buttons }), 1)) } as unknown as TelegramApi;
  const store = new MemoryStore();
  const alerts: string[] = [];
  return { deps: { tg, store, alert: async (t: string) => void alerts.push(t) }, sent, store, alerts, tg };
}

describe("ageText and spacedPicks", () => {
  it("says how long ago in plain words", () => {
    expect([8, 14, 21, 30, 120, 400].map(ageText)).toEqual(["a week ago", "2 weeks ago", "3 weeks ago", "a month ago", "4 months ago", "over a year ago"]);
  });

  it("picks the video closest to each age, each one once", () => {
    const saves = [save("a", 8), save("b", 9), save("c", 33), save("d", 100)];
    expect(spacedPicks(saves, SUNDAY, [7, 30, 90]).map((s) => s.id)).toEqual(["a", "c", "d"]);
    expect(spacedPicks(saves.slice(0, 1), SUNDAY, [7, 30, 90]).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("flashback", () => {
  it("has nothing to say without saves", () => {
    expect(flashback([], SUNDAY)).toBeNull();
  });

  it("recaps this week by folder, and brings back one from about a month ago", () => {
    const got = flashback([save("w1", 1), save("w2", 2, "Gym, Chest"), save("w3", 3), save("old", 29), save("older", 80)], SUNDAY)!;
    expect(got.html).toContain("You saved 3 videos this week (Cooking 2, Gym 1):");
    expect(got.html).toContain('<a href="https://www.tiktok.com/@a/video/w1">Video w1</a>');
    expect(got.html).toContain("<b>From a month ago:</b>");
    expect(got.html).toContain("Video old");
    expect(got.html).not.toContain("Video older");
    expect(got.buttons.flat().map((b) => b.callback_data)).toEqual(["show:w1", "show:w2", "show:w3", "show:old", "folders:new", "digest:stop"]);
  });

  it("brings back older ones, spaced out, in a week with no saves", () => {
    const got = flashback([save("a", 9), save("b", 12), save("c", 31), save("d", 95)], SUNDAY)!;
    expect(got.html).toContain("Worth another look:");
    expect(got.html).toContain("Video a</a> <i>(saved a week ago)</i>");
    expect(got.html).toContain("Video c</a> <i>(saved a month ago)</i>");
    expect(got.html).toContain("Video d</a> <i>(saved 3 months ago)</i>");
    expect(got.html).not.toContain("Video b");
  });
});

describe("sendFlashbacks", () => {
  it("sends only on Sundays, only to people who turned it on, and once a week however often it runs", async () => {
    const { deps, sent, store } = setup();
    store.saves = [{ ...save("x", 2), userId: 1 }, { ...save("y", 2), userId: 2 }];
    await store.saveDigest(1, { on: true, offered: true, sent: "", quiet: 0 });
    await store.saveDigest(2, { on: false, offered: true, sent: "", quiet: 0 });
    expect(await sendFlashbacks(deps, SUNDAY - DAY)).toBe(0);
    expect(await sendFlashbacks(deps, SUNDAY)).toBe(1);
    expect(sent.map((m) => m.chatId)).toEqual([1]);
    expect(await sendFlashbacks(deps, SUNDAY + 60_000)).toBe(0);
    expect(await sendFlashbacks(deps, SUNDAY + 7 * DAY)).toBe(1);
  });

  it("skips people with nothing saved", async () => {
    const { deps, store } = setup();
    await store.saveDigest(1, { on: true, offered: true, sent: "", quiet: 0 });
    expect(await sendFlashbacks(deps, SUNDAY)).toBe(0);
  });

  it(`pauses after ${QUIET_LIMIT} with no reply, and starts again once they write`, async () => {
    const { deps, store } = setup();
    store.saves = [{ ...save("x", 40), userId: 1 }];
    await store.saveDigest(1, { on: true, offered: true, sent: "", quiet: 0 });
    store.active.set(1, new Date(SUNDAY - 30 * DAY).toISOString());
    const weeks = [0, 1, 2, 3, 4].map((w) => SUNDAY + w * 7 * DAY);
    const counts = [];
    for (const at of weeks) counts.push(await sendFlashbacks(deps, at));
    expect(counts).toEqual([1, 1, 1, 0, 0]);
    store.active.set(1, new Date(weeks[4]! + DAY).toISOString()); // they asked something
    expect(await sendFlashbacks(deps, weeks[4]! + 7 * DAY)).toBe(1);
  });

  it("turns it off for someone who blocked the bot, and tells the owner about other failures", async () => {
    const { deps, store, alerts, tg } = setup();
    store.saves = [{ ...save("x", 2), userId: 1 }, { ...save("y", 2), userId: 2 }];
    await store.saveDigest(1, { on: true, offered: true, sent: "", quiet: 0 });
    await store.saveDigest(2, { on: true, offered: true, sent: "", quiet: 0 });
    vi.mocked(tg.sendMessage)
      .mockRejectedValueOnce(new Error("sendMessage: Forbidden: bot was blocked by the user"))
      .mockRejectedValueOnce(new Error("sendMessage: Too Many Requests"));
    expect(await sendFlashbacks(deps, SUNDAY)).toBe(0);
    expect((await store.getDigest(1)).on).toBe(false);
    expect((await store.getDigest(2)).on).toBe(true);
    expect(alerts).toEqual([expect.stringContaining("Weekly flashback failed for 2")]);
  });
});
