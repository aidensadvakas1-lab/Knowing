import { describe, expect, it } from "vitest";
import { answerText, mdToHtml, reactionButtons, reactionText, saveButtons, saveCard, savedList, stepButtons, stepText } from "@/lib/bot/format";
import type { Save } from "@/lib/bot/types";

const drill: Save = {
  id: "d1", userId: 1, title: "Split dodge <weak hand>", topic: "Lacrosse, Dodging", type: "drill", summary: "", steps: ["Jog 10 yards", "Plant & split", "Shoot"],
  details: "", needsWords: true, sourceUrl: "", words: "", source: "", practiced: 0, createdAt: "",
};

describe("mdToHtml", () => {
  it("escapes HTML and converts bold, italics and code", () => {
    expect(mdToHtml("**a** <b> *c* `d`")).toBe("<b>a</b> &lt;b&gt; <i>c</i> <code>d</code>");
  });
});

describe("saveCard / saveButtons", () => {
  it("escapes, numbers the steps and offers Start now and Add what it says", () => {
    const card = saveCard(drill, ["Only read the caption."]);
    expect(card).toContain("Split dodge &lt;weak hand&gt;");
    expect(card).toContain("2. Plant &amp; split");
    expect(card).toContain("Only read the caption.");
    expect(saveButtons(drill).flat().map((b) => b.callback_data)).toEqual(["open:d1", "words:d1"]);
    expect(saveButtons({ ...drill, type: "setup", needsWords: false }).flat()).toEqual([]);
  });
});

describe("steps", () => {
  it("pages through and ends with Done, all within Telegram's 64-byte button limit", () => {
    expect(stepText(drill, 1)).toContain("Step 2 of 3");
    expect(stepButtons(drill, 0).flat().map((b) => b.callback_data)).toEqual(["run:d1:1"]);
    expect(stepButtons(drill, 2).flat().map((b) => b.callback_data)).toEqual(["run:d1:1", "done:d1"]);
    for (const b of [...stepButtons(drill, 1).flat(), ...saveButtons(drill).flat()]) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe("savedList", () => {
  it("groups by the first part of the topic", () => {
    const list = savedList([drill, { ...drill, id: "d2", title: "Bank", topic: "Siege, Bank", type: "setup" }]);
    expect(list).toContain("<b>Lacrosse</b>");
    expect(list).toContain("<b>Siege</b>");
    expect(savedList([])).toContain("Nothing saved yet");
  });
});

describe("reaction", () => {
  it("leads with the reaction and keeps the steps behind a button", () => {
    const t = reactionText("A **split** dodge.", drill);
    expect(t).toContain("A <b>split</b> dodge.");
    expect(t).toContain("Saved: Split dodge &lt;weak hand&gt;");
    expect(t).not.toContain("Jog 10 yards");
    expect(reactionButtons(drill).flat().map((b) => b.callback_data)).toEqual(["show:d1", "open:d1", "words:d1"]);
    const old = { ...drill, id: "o1" };
    expect(reactionButtons(drill, old).flat().map((b) => b.callback_data).slice(0, 2)).toEqual(["keep:d1", "repl:d1:o1"]);
  });
});

describe("answerText", () => {
  it("names the saves it used", () => {
    expect(answerText("Do **this**", [drill])).toContain("From your save: Split dodge &lt;weak hand&gt;");
    expect(answerText("Hi", [])).toBe("Hi");
  });
});
