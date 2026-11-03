import { describe, expect, it } from "vitest";
import { addTo, collectionShelf, COLLECTIONS_KEPT, dropCollection, hasRoomFor, matchCollection, readCollections, removeFrom, renameCollection, swapVideo, videosIn } from "@/lib/bot/collections";
import type { Save } from "@/lib/bot/types";

const save = (id: string, title = id): Save => ({ id, userId: 1, title, topic: "", type: "tip", summary: "", steps: [], details: "", words: "", source: "", needsWords: false, sourceUrl: "", createdAt: "2026-11-03T00:00:00Z", practiced: 0 });

describe("collections", () => {
  it("reads what's stored, tidied: named, no repeats, no bad rows", () => {
    expect(readCollections([{ name: " Date  night ", ids: ["a", "a", "b"] }, { name: "date night", ids: ["c"] }, { name: "", ids: ["d"] }, null, "x"])).toEqual([{ name: "Date night", ids: ["a", "b"] }]);
    expect(readCollections(undefined)).toEqual([]);
  });

  it("adds videos (making a new collection if needed), takes them out, and keeps the spelling they use", () => {
    let all = addTo([], "Date night", ["a"]);
    all = addTo(all, "date night", ["a", "b"]);
    expect(all).toEqual([{ name: "Date night", ids: ["a", "b"] }]);
    expect(matchCollection("DATE NIGHT", all)).toBe("Date night");
    expect(removeFrom(all, "date night", ["a"])).toEqual([{ name: "Date night", ids: ["b"] }]);
    expect(dropCollection(all, "DATE night")).toEqual([]);
  });

  it("merges when renamed to a collection they already have, and moves a replaced video's place to the new one", () => {
    const all = [{ name: "Japan", ids: ["a"] }, { name: "Trips", ids: ["b"] }];
    expect(renameCollection(all, "japan", "Tokyo")).toEqual([{ name: "Tokyo", ids: ["a"] }, { name: "Trips", ids: ["b"] }]);
    expect(renameCollection(all, "Japan", "trips")).toEqual([{ name: "Trips", ids: ["b", "a"] }]);
    expect(swapVideo(all, "a", "z")).toEqual([{ name: "Japan", ids: ["z"] }, { name: "Trips", ids: ["b"] }]);
  });

  it("stops at the most collections there can be", () => {
    const full = Array.from({ length: COLLECTIONS_KEPT }, (_, i) => ({ name: `List ${i}`, ids: [] }));
    expect(hasRoomFor(full, "One more")).toBe(false);
    expect(hasRoomFor(full, "list 3")).toBe(true);
    expect(addTo(full, "One more", ["a"])).toHaveLength(COLLECTIONS_KEPT);
  });

  it("leaves out deleted videos, and shows Claude each collection's videos by id and title", () => {
    const saves = [save("b", "Ramen spots"), save("a", "Pasta alla vodka")];
    const all = [{ name: "Date night", ids: ["a", "gone", "b"] }, { name: "Empty", ids: [] }];
    expect(videosIn(all[0]!, saves).map((s) => s.id)).toEqual(["b", "a"]);
    expect(collectionShelf(all, saves)).toEqual(['Date night (2): [id b] "Ramen spots", [id a] "Pasta alla vodka"', "Empty (0), empty"]);
  });
});
