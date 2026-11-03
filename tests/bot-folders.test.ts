import { describe, expect, it } from "vitest";
import { addRules, cleanFolderName, dropRules, folderKey, folderNames, folderOf, folders, folderShelf, matchFolder, readRules, renameRules, RULES_KEPT, sectionOf, sections, UNSORTED } from "@/lib/bot/folders";
import { folderList, folderView, mergeButtons, moveButtons } from "@/lib/bot/format";
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
    const key = folderKey("Cooking");
    expect(view.buttons).toEqual([
      [{ text: "1", callback_data: "show:a" }, { text: "2", callback_data: "show:b" }],
      [{ text: "✏️ Rename", callback_data: `frn:${key}` }, { text: "🔀 Merge", callback_data: `fmg:${key}` }, { text: "🗑 Delete", callback_data: `fdl:${key}` }],
      [{ text: "« All folders", callback_data: "folders:" }],
    ]);
    expect(folderView(saves, "nope")).toBeNull();
    expect(folderList([]).html).toContain("No folders yet");
  });
});

describe("moving and organizing", () => {
  const big = [
    ...["Legs", "Legs", "Legs", "Arms", "Arms", "Back"].map((part, i) => save(`g${i}`, `Gym, ${part}`)),
    save("g6", "Gym"),
    save("g7", "Gym, Core"),
  ];

  it("files a save by its own folder, and old saves by the first part of the topic", () => {
    expect(folderOf({ ...save("a", "Travel, Tokyo"), folder: "Japan trip" })).toBe("Japan trip");
    expect(folderOf({ ...save("a", "Travel, Tokyo"), folder: "  " })).toBe("Travel");
    expect(cleanFolderName('  "Dinner | ideas"\n ')).toBe("Dinner ideas");
    expect(cleanFolderName("x".repeat(60))).toHaveLength(40);
    expect(matchFolder("gym", [save("a", "Gym, Legs")])).toBe("Gym");
    expect(matchFolder("Car mods", [save("a", "Gym, Legs")])).toBe("Car mods");
  });

  it("keeps Unsorted last, whatever its size", () => {
    const got = folders([save("a", "Gym"), { ...save("b", "x"), folder: UNSORTED }, { ...save("c", "x"), folder: UNSORTED }]);
    expect(got.map((f) => f.name)).toEqual(["Gym", UNSORTED]);
  });

  it("splits a big folder into sections by the second part of the topic, with the rest under Other", () => {
    const gym = folders(big)[0]!;
    expect(sections(gym)?.map((s) => `${s.name} ${s.saves.length}`)).toEqual(["Legs 3", "Arms 2", "Other 3"]);
    expect(sectionOf(save("x", "Gym"), "Gym")).toBe("");
    expect(sectionOf(save("x", "Travel"), "Japan trip")).toBe("Travel");
    expect(sections({ name: "Gym", saves: big.slice(0, 5) })).toBeNull();
    expect(sections({ name: "Gym", saves: big.map((s) => ({ ...s, topic: "Gym, Legs" })) })).toBeNull();
  });

  it("shows sections, the folder's rule, and rename, merge and delete in a folder", () => {
    const view = folderView(big, folderKey("Gym"), [{ folder: "gym", about: "anything about lifting" }])!;
    expect(view.html).toContain("<b>Legs</b>\n1. Video g0");
    expect(view.html).toContain("<b>Arms</b>\n4. Video g3");
    expect(view.html).toContain("📌 New videos about anything about lifting come here.");
    const datas = view.buttons.flat().map((b) => b.callback_data);
    expect(datas).toContain(`frl:${folderKey("Gym")}`);
    // Numbers follow the sections: Legs, then Arms, then Other.
    expect(datas.slice(0, 8)).toEqual(["show:g0", "show:g1", "show:g2", "show:g3", "show:g4", "show:g5", "show:g6", "show:g7"]);
  });

  it("offers the other folders when moving a video or merging a folder, and a new folder", () => {
    const saves = [save("a", "Gym"), save("b", "Cooking"), save("c", "Cooking"), { ...save("d", "Travel"), folder: "Japan trip" }];
    const move = moveButtons(saves[0]!, saves, "r").flat();
    expect(move.map((b) => b.text)).toEqual(["Cooking", "Japan trip", "➕ New folder", "« Back"]);
    expect(move[0]?.callback_data).toBe(`mvto:a:${folderKey("Cooking")}:r`);
    expect(move.at(-1)?.callback_data).toBe("mvback:a:r");
    expect(mergeButtons(saves, folderKey("Cooking")).flat().map((b) => b.callback_data)).toEqual([`fmgto:${folderKey("Cooking")}:${folderKey("Gym")}`, `fmgto:${folderKey("Cooking")}:${folderKey("Japan trip")}`, `folder:${folderKey("Cooking")}`]);
  });

  it("shows Claude each folder with its newest titles and rules, including rules for folders still empty", () => {
    const saves = [{ ...save("a", "Travel, Tokyo"), folder: "Japan trip" }, save("b", "Gym")];
    expect(folderShelf(saves, [{ folder: "Japan trip", about: "anything in Japan" }, { folder: "Car mods", about: "cars" }])).toEqual([
      'Gym (1): "Video b"',
      'Japan trip (1): "Video a". Rule: anything in Japan',
      "Car mods (0, nothing in it yet). Rule: cars",
    ]);
  });

  it("keeps rules tidy: no repeats, renamed with their folder, dropped with it", () => {
    const rules = addRules([{ folder: "Car mods", about: "cars" }], [{ folder: "car mods", about: "Cars" }, { folder: "Gym", about: "lifting" }]);
    expect(rules).toEqual([{ folder: "car mods", about: "Cars" }, { folder: "Gym", about: "lifting" }]);
    expect(renameRules(rules, "CAR MODS", "Builds")).toEqual([{ folder: "Builds", about: "Cars" }, { folder: "Gym", about: "lifting" }]);
    expect(dropRules(rules, "gym")).toEqual([{ folder: "car mods", about: "Cars" }]);
    expect(readRules([{ folder: "", about: "x" }, { folder: "A", about: "" }, "junk", { folder: "B", about: "b" }])).toEqual([{ folder: "B", about: "b" }]);
    expect(addRules([], Array.from({ length: 30 }, (_, i) => ({ folder: `F${i}`, about: "x" })))).toHaveLength(RULES_KEPT);
  });
});
