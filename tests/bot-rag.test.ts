import { describe, expect, it } from "vitest";
import { chunkSave, cosine, fuseRanks, groupHits, MemoryRetriever, searchQuery, splitText, type Embedder } from "@/lib/bot/rag";
import type { Save } from "@/lib/bot/types";

const save = (over: Partial<Save>): Save => ({
  id: "a1", userId: 1, title: "Bank basement: lockers + CCTV", topic: "Siege, Bank", type: "setup", summary: "Basement defense.",
  steps: ["Reinforce CCTV wall", "Mira on lockers"], details: "", needsWords: false, sourceUrl: "", words: "", source: "", practiced: 0, createdAt: "", ...over,
});

/**
 * A toy embedder that knows a few synonyms, standing in for real semantic
 * embeddings: "one-way mirror" and "Mira" land close together.
 */
const CONCEPTS: Record<string, string[]> = {
  mirror: ["mira", "mirror", "one-way", "window"],
  dodge: ["dodge", "split", "juke", "beat"],
  bank: ["bank", "basement", "lockers", "cctv"],
  sat: ["sat", "reading", "test", "score"],
};
const fake: Embedder = {
  async embed(texts) {
    return texts.map((t) => Object.values(CONCEPTS).map((words) => (words.some((w) => t.toLowerCase().includes(w)) ? 1 : 0)));
  },
};

describe("splitText", () => {
  it("keeps short text whole and splits long text with overlap", () => {
    expect(splitText("  hi there ")).toEqual(["hi there"]);
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = splitText(long, 300, 50);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join(" ")).toContain("Sentence number 59");
  });
});

describe("chunkSave", () => {
  it("makes a card chunk, a details chunk and labeled source chunks", () => {
    const chunks = chunkSave(save({ details: "Castle on server", source: "Transcript: put Mira on the lockers wall" }));
    expect(chunks.map((c) => c.kind)).toEqual(["card", "details", "source"]);
    expect(chunks[2]?.text.startsWith("Bank basement: lockers + CCTV (Siege, Bank, setup)")).toBe(true);
  });
});

describe("fuseRanks", () => {
  it("rewards items ranked well in both lists", () => {
    const fused = fuseRanks([["a", "b", "c"], ["b", "c"]], (x) => x);
    expect(fused[0]?.item).toBe("b");
    expect(fused.map((f) => f.item)).toEqual(["b", "c", "a"]);
  });
});

describe("groupHits", () => {
  it("orders saves by their best chunk and keeps passages from the video", () => {
    const g = groupHits([
      { saveId: "x", kind: "source", text: "T (t)\nFrom the video: exact words", score: 3 },
      { saveId: "y", kind: "card", text: "card", score: 2 },
      { saveId: "x", kind: "card", text: "card", score: 1 },
    ]);
    expect(g).toEqual([{ saveId: "x", passages: ["exact words"] }, { saveId: "y", passages: [] }]);
  });
});

describe("searchQuery", () => {
  it("adds the previous message only for follow-ups", () => {
    expect(searchQuery("and the other one?", "bank setup")).toBe("and the other one? bank setup");
    expect(searchQuery("what was the full setup for bank basement with castle on server", "x")).toBe("what was the full setup for bank basement with castle on server");
  });
});

describe("MemoryRetriever", () => {
  const saves = [
    save({}),
    save({ id: "d1", title: "Split dodge drill", topic: "Lacrosse, Dodging", type: "drill", summary: "Beat your defender.", steps: ["Jog", "Plant left", "Split right"] }),
    save({ id: "s1", title: "Active recall for SAT reading", topic: "SAT, Reading", type: "plan", summary: "Study method.", steps: ["Read", "Recall"] }),
  ];

  it("finds saves by exact words without embeddings", async () => {
    const r = new MemoryRetriever();
    for (const s of saves) await r.index(s);
    expect((await r.search(1, "split dodge"))[0]?.saveId).toBe("d1");
  });

  it("finds saves by meaning when the words differ", async () => {
    const words = new MemoryRetriever();
    const hybrid = new MemoryRetriever(fake);
    for (const s of saves) { await words.index(s); await hybrid.index(s); }
    const q = "where does the one-way window go";
    expect((await words.search(1, q)).map((h) => h.saveId)).not.toContain("a1");
    expect((await hybrid.search(1, q))[0]?.saveId).toBe("a1");
  });

  it("only searches the asking user's saves, and forgets removed ones", async () => {
    const r = new MemoryRetriever(fake);
    await r.index(save({ userId: 2, id: "other" }));
    await r.index(save({}));
    expect((await r.search(1, "bank")).every((h) => h.saveId === "a1")).toBe(true);
    await r.remove(1, "a1");
    expect(await r.search(1, "bank")).toEqual([]);
  });

  it("cosine handles zero vectors", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
});
