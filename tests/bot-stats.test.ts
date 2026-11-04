import { describe, expect, it } from "vitest";
import { statsText, type StatsData, type StatUser } from "@/lib/bot/stats";
import { readWallet } from "@/lib/bot/store";

const now = new Date("2026-11-03T12:00:00Z");
const person = (id: number, extra: Partial<StatUser> = {}): StatUser => ({
  id,
  usage: { day: "2026-11-03", videos: 0, questions: 0 },
  wallet: readWallet({}),
  referral: { by: 0, name: "", credited: false, rewarded: 0 },
  digest: { on: false, offered: true, sent: "", quiet: 0 },
  active: "2026-11-03T11:00:00Z",
  ...extra,
});
const settings = { ownerId: 7, cap: 150, limits: { videos: 5, questions: 10 } };

describe("statsText", () => {
  const data: StatsData = {
    users: [
      person(7),
      person(1, { usage: { day: "2026-11-03", videos: 5, questions: 10 }, referral: { by: 2, name: "", credited: true, rewarded: 0 }, digest: { on: true, offered: true, sent: "", quiet: 0 } }),
      person(2, {
        usage: { day: "2026-10-01", videos: 5, questions: 3 },
        active: "2026-10-01T00:00:00Z",
        referral: { by: 0, name: "", credited: false, rewarded: 1 },
        wallet: readWallet({ videos: 3, paid: [{ charge: "c1", videos: 5, questions: 10, stars: 150, at: "2026-11-02T00:00:00Z" }, { charge: "c2", stars: 500, at: "2026-11-01T00:00:00Z", plan: true }], plan: { until: "2026-12-01T00:00:00Z", charge: "c2", stars: 500, cost: 4.5 } }),
      }),
      person(3, { usage: { day: "", videos: 0, questions: 0 }, active: "" }),
    ],
    saves: [
      { userId: 1, createdAt: "2026-11-03T10:00:00Z", type: "tip", folder: "Gym" },
      { userId: 1, createdAt: "2026-10-30T10:00:00Z", type: "tip", folder: "Gym" },
      { userId: 2, createdAt: "2026-09-01T10:00:00Z", type: "drill", folder: "Cars" },
      { userId: 7, createdAt: "2026-11-03T10:00:00Z", type: "info", folder: "Mine" },
    ],
    chats: [{ userId: 1, createdAt: "2026-11-03T09:00:00Z" }, { userId: 7, createdAt: "2026-11-03T09:00:00Z" }],
    costs: [
      { day: "2026-11-03", userId: 1, kind: "videos", uses: 2, failed: 1, dollars: 0.1 },
      { day: "2026-11-03", userId: 1, kind: "questions", uses: 4, failed: 0, dollars: 0.08 },
      { day: "2026-10-30", userId: 7, kind: "videos", uses: 1, failed: 0, dollars: 0.05 },
    ],
  };
  const text = statsText(data, settings, now);

  it("counts people, leaving the owner out", () => {
    expect(text).toContain("Joined: 3 of 150 spots. Never used it: 1.");
    expect(text).toContain("New: 1 today, 1 this week, 1 in 30 days.");
    expect(text).toContain("Active: 1 today, 1 this week, 1 in 30 days.");
    expect(text).toContain("Used all free videos: 2. Used all free questions: 1.");
    expect(text).toContain("Came from an invite link: 1. Invite rewards given: 1.");
    expect(text).toContain("Weekly flashback on: 1.");
  });

  it("counts videos and questions", () => {
    expect(text).toContain("1 today, 2 this week, 2 in 30 days, 3 in all.");
    expect(text).toContain("Top folders: Gym 2, Cars 1.");
    expect(text).toContain("<b>💬 Questions asked</b>\n1 today, 1 this week, 1 in 30 days.");
  });

  it("adds up money in and money out", () => {
    expect(text).toContain("Knowing Plus: 1 subscriber (renewal off: 0, slowed: 1, paused: 0).");
    expect(text).toContain("Paid: 650 ⭐ in all (1 Plus payments, 1 refills), about $8.45 to you.");
    expect(text).toContain("Paying people: 1 of 3 (33%).");
    expect(text).toContain("Unused extras people hold: 3 videos, 0 questions.");
    expect(text).toContain("$0.18 today, $0.23 this week, $0.23 in 30 days ($0.05 of it yours).");
    expect(text).toContain("Average: 5.0¢ a video, 2.0¢ a question.");
    expect(text).toContain("Failed and given back (30 days): 1 of 3 videos, 0 of 4 questions.");
    expect(text).toContain("30 days in minus out: $8.22 ahead.");
    expect(text).toContain("<code>1</code> $0.18, <code>7</code> (you) $0.05");
  });

  it("says when costs aren't tracked yet", () => {
    expect(statsText({ ...data, costs: null }, settings, now)).toContain("Not tracked yet. Run the new SQL in Supabase to start.");
  });

  it("lists the most active people", () => {
    expect(text).toContain("<code>1</code>: 2 saves, 1 question in 30 days");
  });
});
