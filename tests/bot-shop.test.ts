import { describe, expect, it } from "vitest";
import { buyButton, invoiceFor, readPack } from "@/lib/bot/shop";
import { readWallet } from "@/lib/bot/store";

describe("shop", () => {
  it("makes invoices Telegram accepts and reads their payload back", () => {
    const invoice = invoiceFor("questions", 100);
    expect(invoice.title).toBe("20 more questions");
    expect(invoice.title.length).toBeLessThanOrEqual(32);
    expect(invoice.description.length).toBeLessThanOrEqual(255);
    expect(invoice.description).toContain("/terms");
    expect(readPack(invoice.payload)).toEqual({ kind: "questions", stars: 100 });
    expect(readPack("pack:hats:100")).toBeNull();
    expect(readPack("something else")).toBeNull();
  });

  it("labels the buy button with the pack and its price", () => {
    expect(buyButton("videos", 100)).toEqual([[{ text: "10 more videos, 100 ⭐", callback_data: "buy:videos" }]]);
  });
});

describe("readWallet", () => {
  it("reads an empty or broken wallet as nothing bought", () => {
    expect(readWallet(undefined)).toEqual({ videos: 0, questions: 0, paid: [] });
    expect(readWallet({ videos: -3, questions: "x", paid: "no" })).toEqual({ videos: 0, questions: 0, paid: [] });
  });

  it("keeps valid payments and drops broken ones", () => {
    const wallet = readWallet({ videos: 10, questions: 2.7, paid: [{ charge: "c1", kind: "videos", stars: 100, at: "2026-11-02" }, { charge: 5, kind: "videos" }, { charge: "c2", kind: "hats" }] });
    expect(wallet).toEqual({ videos: 10, questions: 2, paid: [{ charge: "c1", kind: "videos", stars: 100, at: "2026-11-02" }] });
  });
});
