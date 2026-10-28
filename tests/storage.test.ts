import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/lib/constants";
import { createBackup, loadItems, loadProfile, mergeItems, newId, parseBackup, readJson, saveItems, writeJson } from "@/lib/storage";
import type { KnowledgeItem } from "@/lib/types";

/** Minimal in-memory localStorage for the node test environment. */
class MemoryStorage {
  private data = new Map<string, string>();
  quotaExceeded = false;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.quotaExceeded) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

const item = (id: string, createdAt: number): KnowledgeItem => ({
  id,
  kind: "note",
  title: id,
  url: "",
  content: "",
  takeaways: [],
  tags: [],
  status: "saved",
  createdAt,
});

describe("readJson / writeJson", () => {
  it("round-trips values", () => {
    expect(writeJson("k", { a: 1 })).toBe(true);
    expect(readJson("k", null)).toEqual({ a: 1 });
  });
  it("returns the fallback for missing or corrupt data", () => {
    expect(readJson("missing", 5)).toBe(5);
    storage.setItem("bad", "{oops");
    expect(readJson("bad", 5)).toBe(5);
  });
  it("reports quota errors", () => {
    storage.quotaExceeded = true;
    expect(writeJson("k", 1)).toBe(false);
  });
});

describe("loaders", () => {
  it("return defaults when nothing is stored", () => {
    expect(loadProfile().goal).toBe("");
    expect(loadItems()).toEqual([]);
  });
  it("drop invalid items but keep valid ones", () => {
    storage.setItem(STORAGE_KEYS.items, JSON.stringify([item("ok", 1), { id: "bad" }]));
    expect(loadItems().map((i) => i.id)).toEqual(["ok"]);
  });
  it("load what was saved", () => {
    saveItems([item("a", 1)]);
    expect(loadItems()).toHaveLength(1);
  });
});

describe("backups", () => {
  it("round-trip through JSON", () => {
    const backup = createBackup({ now: "x", goal: "y", skills: "", time: "", more: "" }, [item("a", 1)], [{ role: "user", content: "hi" }]);
    const restored = parseBackup(JSON.stringify(backup));
    expect(restored.profile.now).toBe("x");
    expect(restored.items).toHaveLength(1);
    expect(restored.chat).toHaveLength(1);
  });
  it("reject files that are not backups", () => {
    expect(() => parseBackup("not json")).toThrow(/valid JSON/);
    expect(() => parseBackup("{}")).toThrow(/Knowing backup/);
  });
  it("merge by id, newest first", () => {
    const merged = mergeItems([item("a", 1), item("b", 2)], [{ ...item("a", 1), title: "updated" }, item("c", 3)]);
    expect(merged.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(merged.find((i) => i.id === "a")?.title).toBe("updated");
  });
});

describe("newId", () => {
  it("returns unique ids", () => expect(new Set(Array.from({ length: 100 }, newId)).size).toBe(100));
});
