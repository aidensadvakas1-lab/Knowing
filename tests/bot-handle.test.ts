import { describe, expect, it, vi } from "vitest";
import { handleUpdate, parseAllowed, type Deps, type Update } from "@/lib/bot/handle";
import { MemoryStore } from "@/lib/bot/store";
import type { Answer, Brain, InlineButton, Media, Save, SaveDraft, TelegramApi } from "@/lib/bot/types";

interface Sent { chatId: number; html: string; buttons?: InlineButton[][]; id: number }

function setup(opts: { answer?: Partial<Answer>; draft?: Partial<SaveDraft> } = {}) {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  let nextId = 100;
  const tg: TelegramApi = {
    sendMessage: vi.fn(async (chatId, html, buttons) => { const id = nextId++; sent.push({ chatId, html, buttons, id }); return id; }),
    editMessage: vi.fn(async (chatId, id, html, buttons) => { edits.push({ chatId, html, buttons, id }); }),
    answerCallback: vi.fn(async () => {}),
    typing: vi.fn(async () => {}),
  };
  const draft: SaveDraft = { title: "Split dodge drill", topic: "Lacrosse, Dodging", type: "drill", summary: "Beat a defender.", steps: ["Jog", "Plant", "Split"], details: "", needsWords: false, ...opts.draft };
  const brain: Brain = {
    watch: vi.fn(async () => draft),
    rewrite: vi.fn(async (s: Save) => ({ ...s, steps: ["Exact step"] })),
    answer: vi.fn(async ({ saves }: { saves: Save[] }) => ({ text: "Do the split dodge.", sources: saves.map((s: Save) => s.id), goal: "", switchTo: "", both: "", ...opts.answer })),
  };
  const media: Media = {
    fromLink: vi.fn(async () => ({ frames: ["aGk="], transcript: "", caption: "dodge tips", notes: [] })),
    fromTelegramFile: vi.fn(async () => ({ frames: ["aGk="], transcript: "say this", caption: "", notes: [] })),
  };
  const store = new MemoryStore();
  const deps: Deps = { tg, store, brain, media, isAllowed: (id) => id === 7 };
  return { deps, sent, edits, store, brain, media };
}

const text = (t: string, from = 7): Update => ({ message: { message_id: 1, chat: { id: 7 }, from: { id: from }, text: t } });
const tap = (data: string, messageId = 100): Update => ({ callback_query: { id: "cb", from: { id: 7 }, data, message: { message_id: messageId, chat: { id: 7 } } } });

describe("parseAllowed", () => {
  it("reads comma or space separated ids", () => {
    expect([...parseAllowed("1, 22 333,x")]).toEqual([1, 22, 333]);
    expect(parseAllowed(undefined).size).toBe(0);
  });
});

describe("handleUpdate", () => {
  it("keeps strangers out and tells them their id", async () => {
    const { deps, sent, brain } = setup();
    await handleUpdate(text("hello", 9), deps);
    expect(sent[0]?.html).toContain("<code>9</code>");
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("watches a shared TikTok link and saves a card with Start now", async () => {
    const { deps, sent, edits, store, media } = setup();
    await handleUpdate(text("look https://vm.tiktok.com/ZMabc/"), deps);
    expect(media.fromLink).toHaveBeenCalledWith("https://vm.tiktok.com/ZMabc/");
    expect(sent[0]?.html).toContain("Watching");
    expect(edits[0]?.html).toContain("Split dodge drill");
    expect(edits[0]?.buttons?.flat()[0]?.callback_data).toMatch(/^open:/);
    expect(store.saves[0]?.sourceUrl).toBe("https://vm.tiktok.com/ZMabc/");
  });

  it("watches a video sent straight to the bot", async () => {
    const { deps, store, media } = setup();
    await handleUpdate({ message: { message_id: 1, chat: { id: 7 }, from: { id: 7 }, video: { file_id: "F", duration: 12 } } }, deps);
    expect(media.fromTelegramFile).toHaveBeenCalledWith("F", 12);
    expect(store.saves).toHaveLength(1);
  });

  it("runs a drill step by step and counts it when done", async () => {
    const { deps, sent, edits, store } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    const id = store.saves[0]!.id;
    await handleUpdate(tap(`open:${id}`), deps);
    expect(sent.at(-1)?.html).toContain("Step 1 of 3");
    await handleUpdate(tap(`run:${id}:2`, sent.at(-1)!.id), deps);
    expect(edits.at(-1)?.html).toContain("Step 3 of 3");
    await handleUpdate(tap(`done:${id}`), deps);
    expect(store.saves[0]?.practiced).toBe(1);
  });

  it("answers from saves and offers to keep, switch or combine the goal", async () => {
    const { deps, sent, store } = setup({ answer: { switchTo: "Go to college for AI", both: "Build a business while studying AI" } });
    await handleUpdate(text("/goal Become a rich entrepreneur"), deps);
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    await handleUpdate(text("what college path for ai engineering?"), deps);
    const reply = sent.at(-1)!;
    expect(reply.html).toContain("From your save: Split dodge drill");
    expect(reply.buttons?.flat().map((b) => b.callback_data)).toEqual(["goal:keep", "goal:switch", "goal:both", expect.stringMatching(/^open:/)]);
    await handleUpdate(tap("goal:both"), deps);
    expect((await store.getUser(7)).goal).toBe("Build a business while studying AI");
    expect(sent.at(-1)?.html).toContain("Goal changed");
  });

  it("sets a goal stated in a question when none is set, without offering a switch", async () => {
    const { deps, sent, store } = setup({ answer: { goal: "Get 1500 on the SAT", switchTo: "x" } });
    await handleUpdate(text("my goal is a 1500 on the SAT, what now?"), deps);
    expect((await store.getUser(7)).goal).toBe("Get 1500 on the SAT");
    expect(sent.at(-1)?.html).toContain("Saved your goal");
  });

  it("takes the next message as a video's words after Add what it says", async () => {
    const { deps, store, brain, sent } = setup({ draft: { needsWords: true } });
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    const id = store.saves[0]!.id;
    await handleUpdate(tap(`words:${id}`), deps);
    await handleUpdate(text("they say plant your left foot"), deps);
    expect(brain.rewrite).toHaveBeenCalled();
    expect(brain.answer).not.toHaveBeenCalled();
    expect(store.saves[0]?.words).toBe("they say plant your left foot");
    expect(sent.at(-1)?.html).toContain("Updated");
  });

  it("tells the user when something fails instead of going silent", async () => {
    const { deps, sent, brain } = setup();
    vi.mocked(brain.answer).mockRejectedValueOnce(new Error("boom"));
    await handleUpdate(text("hi"), deps);
    expect(sent.at(-1)?.html).toContain("went wrong");
  });
});
