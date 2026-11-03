import { describe, expect, it } from "vitest";
import { buyButtons, invoiceFor, packName, priceList, readPack } from "@/lib/bot/shop";
import { readWallet } from "@/lib/bot/store";

describe("shop", () => {
  it("makes invoices Telegram accepts and reads their payload back", () => {
    const invoice = invoiceFor({ videos: 25, questions: 50, stars: 750 });
    expect(invoice.title).toBe("25 videos + 50 questions");
    expect(invoice.stars).toBe(750);
    expect(invoice.title.length).toBeLessThanOrEqual(32);
    expect(invoice.description.length).toBeLessThanOrEqual(255);
    expect(invoice.description).toContain("/terms");
    expect(readPack(invoice.payload)).toEqual({ videos: 25, questions: 50, stars: 750 });
    // Invoices from before bundles still read, for refunds.
    expect(readPack("pack:questions:20:150")).toEqual({ videos: 0, questions: 20, stars: 150 });
    expect(readPack("pack:hats:10:100")).toBeNull();
    expect(readPack("pack:videos:100")).toBeNull(); // from before pack sizes
    expect(readPack("something else")).toBeNull();
  });

  it("labels the buy buttons with each bundle and its price, one a row", () => {
    const packs = [{ videos: 5, questions: 10, stars: 150 }, { videos: 10, questions: 20, stars: 300 }];
    expect(buyButtons(packs)).toEqual([
      [{ text: "5 videos + 10 questions, 150 ⭐", callback_data: "buy:5:10" }],
      [{ text: "10 videos + 20 questions, 300 ⭐", callback_data: "buy:10:20" }],
    ]);
    expect(priceList(packs)).toBe("5 videos + 10 questions for 150 ⭐, 10 + 20 for 300 ⭐");
    expect(packName({ videos: 1, questions: 0 })).toBe("1 video");
  });
});

describe("readWallet", () => {
  it("reads an empty or broken wallet as nothing bought", () => {
    expect(readWallet(undefined)).toEqual({ videos: 0, questions: 0, paid: [], plan: null });
    expect(readWallet({ videos: -3, questions: "x", paid: "no", plan: { until: "soon" } })).toEqual({ videos: 0, questions: 0, paid: [], plan: null });
  });

  it("keeps valid payments and drops broken ones", () => {
    const wallet = readWallet({ videos: 10, questions: 2.7, paid: [{ charge: "c1", videos: 5, questions: 10, stars: 150, at: "2026-11-03" }, { charge: 5, videos: 5 }, { charge: "c2", kind: "hats" }] });
    expect(wallet).toEqual({ videos: 10, questions: 2, paid: [{ charge: "c1", videos: 5, questions: 10, stars: 150, at: "2026-11-03" }], plan: null });
  });

  it("keeps Knowing Plus and its payments", () => {
    const plan = { until: "2026-12-03T00:00:00.000Z", first: "p1", charge: "p2", stars: 500, day: "2026-11-03", videos: 2, questions: 4, cost: 1.25, canceled: true };
    const wallet = readWallet({ paid: [{ charge: "p1", videos: 0, questions: 0, stars: 500, at: "x", plan: true }], plan });
    expect(wallet.plan).toEqual(plan);
    expect(wallet.paid).toEqual([{ charge: "p1", videos: 0, questions: 0, stars: 500, at: "x", plan: true }]);
    // From before `first` was kept: the latest payment names it.
    expect(readWallet({ plan: { ...plan, first: undefined, day: "nope", cost: -1 } }).plan).toMatchObject({ first: "p2", day: "", cost: 0 });
  });

  it("reads payments from before bundles, and from before pack sizes as the old 10 videos or 20 questions", () => {
    const wallet = readWallet({ paid: [{ charge: "c0", kind: "videos", count: 20, stars: 300, at: "x" }, { charge: "c1", kind: "videos", stars: 100, at: "x" }, { charge: "c2", kind: "questions", stars: 100, at: "x" }] });
    expect(wallet.paid.map((p) => [p.videos, p.questions])).toEqual([[20, 0], [10, 0], [0, 20]]);
  });
});
