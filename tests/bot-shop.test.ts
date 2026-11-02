import { describe, expect, it } from "vitest";
import { buyButtons, invoiceFor, priceList, readPack } from "@/lib/bot/shop";
import { readWallet } from "@/lib/bot/store";

describe("shop", () => {
  it("makes invoices Telegram accepts and reads their payload back", () => {
    const invoice = invoiceFor({ kind: "questions", count: 100, stars: 750 });
    expect(invoice.title).toBe("100 more questions");
    expect(invoice.stars).toBe(750);
    expect(invoice.title.length).toBeLessThanOrEqual(32);
    expect(invoice.description.length).toBeLessThanOrEqual(255);
    expect(invoice.description).toContain("/terms");
    expect(readPack(invoice.payload)).toEqual({ kind: "questions", count: 100, stars: 750 });
    expect(readPack("pack:hats:10:100")).toBeNull();
    expect(readPack("pack:videos:100")).toBeNull(); // from before pack sizes
    expect(readPack("something else")).toBeNull();
  });

  it("labels the buy buttons with each pack and its price", () => {
    const packs = [{ kind: "videos" as const, count: 10, stars: 150 }, { kind: "questions" as const, count: 20, stars: 150 }, { kind: "questions" as const, count: 40, stars: 300 }];
    expect(buyButtons(packs, "videos")).toEqual([[{ text: "10 more videos, 150 ⭐", callback_data: "buy:videos:10" }]]);
    expect(buyButtons(packs)).toEqual([
      [{ text: "10 videos, 150 ⭐", callback_data: "buy:videos:10" }, { text: "20 questions, 150 ⭐", callback_data: "buy:questions:20" }],
      [{ text: "40 questions, 300 ⭐", callback_data: "buy:questions:40" }],
    ]);
    expect(priceList(packs, "questions")).toBe("20 questions for 150 ⭐, 40 for 300 ⭐");
  });
});

describe("readWallet", () => {
  it("reads an empty or broken wallet as nothing bought", () => {
    expect(readWallet(undefined)).toEqual({ videos: 0, questions: 0, paid: [] });
    expect(readWallet({ videos: -3, questions: "x", paid: "no" })).toEqual({ videos: 0, questions: 0, paid: [] });
  });

  it("keeps valid payments and drops broken ones", () => {
    const wallet = readWallet({ videos: 10, questions: 2.7, paid: [{ charge: "c1", kind: "videos", count: 20, stars: 300, at: "2026-11-02" }, { charge: 5, kind: "videos" }, { charge: "c2", kind: "hats" }] });
    expect(wallet).toEqual({ videos: 10, questions: 2, paid: [{ charge: "c1", kind: "videos", count: 20, stars: 300, at: "2026-11-02" }] });
  });

  it("reads payments from before pack sizes as the old 10 videos or 20 questions", () => {
    const wallet = readWallet({ paid: [{ charge: "c1", kind: "videos", stars: 100, at: "x" }, { charge: "c2", kind: "questions", stars: 100, at: "x" }] });
    expect(wallet.paid.map((p) => p.count)).toEqual([10, 20]);
  });
});
