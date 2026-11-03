import { describe, expect, it } from "vitest";
import { folderKey, folderNames, folderOf, folders } from "@/lib/bot/folders";
import { folderList, folderView } from "@/lib/bot/format";
import type { Save } from "@/lib/bot/types";

const save = (id: string, topic: string, createdAt = "2026-11-02T10:00:00Z", sourceUrl = ""): Save => ({
  id,
  userId: 1,
  title: `Video ${id}`,
  topic,
  type: "tip",
  summary: "",
  steps: [],
  details: "",
  needsWords: false,
  sourceUrl,
  words: "",
  source: "",
  practiced: 0,
  createdAt,
});

describe("folders", () => {
  it("files each save under the first part of its topic, ignoring capitals", () => {
    expect(folderOf(save("a", "Cooking, Pasta"))).toBe("Cooking");
    expect(folderOf(save("b", ""))).toBe("Other");
    const got = folders([save("a", "gym, Legs"), save("b", "Gym, Chest"), save("c", "Gym"), save("d", "Cars, Porsche")]);
    expect(got.map((f) => [f.name, f.saves.map((s) => s.id)])).toEqual([
      ["Gym", ["a", "b", "c"]],
      ["Cars", ["d"]],
    ]);
    expect(folderNames([save("a", "Gym, Legs"), save("b", "Cars")])).toBe("Cars (1), Gym (1)");
  });

  it("gives every folder a short button id that's the same whatever the capitals", () => {
    expect(folderKey("Готовка, очень длинное название папки с рецептами")).toMatch(/^[0-9a-z]{1,7}$/);
    expect(folderKey("Gym")).toBe(folderKey("gym"));
    expect(folderKey("Gym")).not.toBe(folderKey("Cars"));
  });

  it("lists the folders as buttons, and a folder's videos with dates, links and number buttons", () => {
    const saves = [save("a", "Cooking, Pasta", "2026-11-02T10:00:00Z", "https://www.tiktok.com/@a/video/1"), save("b", "Cooking, Steak", "2026-10-20T10:00:00Z"), save("c", "Gym")];
    const list = folderList(saves);
    expect(list.html).toContain("3 videos in 2 folders");
    expect(list.buttons).toEqual([[{ text: "Cooking (2)", callback_data: `folder:${folderKey("Cooking")}` }, { text: "Gym (1)", callback_data: `folder:${folderKey("Gym")}` }]]);
    const view = folderView(saves, folderKey("Cooking"))!;
    expect(view.html).toContain('1. <a href="https://www.tiktok.com/@a/video/1">Video a</a> <i>(Tip, Nov 2)</i>');
    expect(view.html).toContain("2. Video b <i>(Tip, Oct 20)</i>");
    expect(view.buttons).toEqual([[{ text: "1", callback_data: "show:a" }, { text: "2", callback_data: "show:b" }], [{ text: "« All folders", callback_data: "folders:" }]]);
    expect(folderView(saves, "nope")).toBeNull();
    expect(folderList([]).html).toContain("No folders yet");
  });
});
