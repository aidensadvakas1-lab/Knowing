import { describe, expect, it, vi } from "vitest";
import { handleUpdate, inviteCode, isOutOfCredit, limitText, parseAllowed, resetsIn, secretMatches, spend, type Deps, type Update } from "@/lib/bot/handle";
import { MemoryRetriever } from "@/lib/bot/rag";
import { MemoryStore } from "@/lib/bot/store";
import type { Answer, Brain, InlineButton, Media, Save, SaveDraft, TelegramApi, WatchResult } from "@/lib/bot/types";

interface Sent { chatId: number; html: string; buttons?: InlineButton[][]; id: number }

function setup(opts: { answer?: Partial<Answer>; draft?: Partial<SaveDraft>; watch?: (saves: Save[]) => Partial<WatchResult>; limits?: Deps["limits"]; spots?: number } = {}) {
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
    watch: vi.fn(async ({ saves }: { saves: Save[] }) => ({ draft, reply: "A split dodge drill for your weak hand.", relation: "none" as const, relatedId: "", ...opts.watch?.(saves) })),
    rewrite: vi.fn(async (s: Save) => ({ ...s, steps: ["Exact step"] })),
    answer: vi.fn(async ({ saves }: { saves: Save[] }) => ({ text: "Do the split dodge.", sources: saves.map((s) => s.id), about: [], remember: [], ...opts.answer })),
    wrapUp: vi.fn(async ({ kept }: { kept: Save[] }) => `From that scroll you kept **${kept.length}**.`),
  };
  const media: Media = {
    fromLink: vi.fn(async () => ({ frames: ["aGk="], transcript: "", caption: "dodge tips", notes: [] })),
    fromTelegramFile: vi.fn(async () => ({ frames: ["aGk="], transcript: "say this", caption: "", notes: [] })),
  };
  const store = new MemoryStore();
  const retriever = new MemoryRetriever();
  const alerts: string[] = [];
  const deps: Deps = { tg, store, brain, media, retriever, isAllowed: (id) => id === 7, ownerId: 7, invite: { code: "join-abc123", spots: opts.spots ?? 10, link: async () => "https://t.me/KnowingTestBot?start=join-abc123" }, limits: opts.limits ?? { videos: 50, questions: 50 }, alert: async (t) => void alerts.push(t) };
  return { deps, sent, edits, store, brain, media, retriever, alerts };
}

const text = (t: string, from = 7, name?: string): Update => ({ message: { message_id: 1, chat: { id: from }, from: { id: from, first_name: name }, text: t } });
const tap = (data: string, messageId = 100, from = 7): Update => ({ callback_query: { id: "cb", from: { id: from }, data, message: { message_id: messageId, chat: { id: from } } } });
const datas = (b?: InlineButton[][]) => (b ?? []).flat().map((x) => x.callback_data);

describe("parseAllowed", () => {
  it("reads comma or space separated ids", () => {
    expect([...parseAllowed("1, 22 333,x")]).toEqual([1, 22, 333]);
    expect(parseAllowed(undefined).size).toBe(0);
  });
});

describe("inviteCode", () => {
  it("makes a short code Telegram accepts, the same every time, from the webhook secret", () => {
    const code = inviteCode("s3cret");
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(inviteCode("s3cret")).toBe(code);
    expect(inviteCode("other")).not.toBe(code);
  });
  it("uses KNOWING_INVITE_CODE when it's a valid code", () => {
    expect(inviteCode("s3cret", " summer-beta ")).toBe("summer-beta");
    expect(inviteCode("s3cret", "no spaces allowed")).toBe(inviteCode("s3cret"));
    expect(inviteCode("s3cret", "")).toBe(inviteCode("s3cret"));
  });
});

describe("invite link", () => {
  it("turns away people without the link", async () => {
    const { deps, sent, store } = setup();
    await handleUpdate(text("hi", 99), deps);
    await handleUpdate(text("/start wrong-code", 99), deps);
    expect(sent.map((m) => m.html)).toEqual([expect.stringContaining("invite-only"), expect.stringContaining("invite-only")]);
    expect(await store.hasUser(99)).toBe(false);
  });

  it("lets someone in with the link, welcomes them and tells the owner", async () => {
    const { deps, sent, store, brain } = setup();
    await handleUpdate(text("/start join-abc123", 99, "Sam <3"), deps);
    expect(await store.hasUser(99)).toBe(true);
    expect(sent.find((m) => m.chatId === 7)?.html).toBe("Sam &lt;3 joined Knowing with your invite link. 1 of 10 spots used.");
    expect(sent.find((m) => m.chatId === 99)?.html).toContain("Send me videos");
    await handleUpdate(text("what was that drill?", 99), deps);
    expect(brain.answer).toHaveBeenCalledTimes(1);
  });

  it("stops at the spot limit, without counting people let in through settings", async () => {
    const { deps, sent, store } = setup({ spots: 1 });
    await handleUpdate(text("hello", 7), deps); // the owner, let in through settings
    await handleUpdate(text("/start join-abc123", 98), deps);
    await handleUpdate(text("/start join-abc123", 99, "Alex"), deps);
    expect(await store.hasUser(98)).toBe(true);
    expect(await store.hasUser(99)).toBe(false);
    expect(sent.filter((m) => m.chatId === 99).at(-1)?.html).toContain("full right now");
    expect(sent.filter((m) => m.chatId === 7).at(-1)?.html).toContain("Alex tried to join with your invite link, but all 1 spots are taken");
  });

  it("gives the owner the link and the spots used with /invite, and nobody else", async () => {
    const { deps, sent, brain } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(text("/invite"), deps);
    expect(sent.at(-1)?.html).toContain("https://t.me/KnowingTestBot?start=join-abc123");
    expect(sent.at(-1)?.html).toContain("1 of 10 spots used");
    await handleUpdate(text("/invite", 99), deps);
    expect(sent.at(-1)?.html).not.toContain("t.me");
    expect(brain.answer).toHaveBeenCalledTimes(1);
  });

  it("keeps someone's spot and today's limits after /delete", async () => {
    const { deps, store } = setup({ limits: { videos: 1, questions: 50 } });
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(text("https://vm.tiktok.com/one/", 99), deps);
    await handleUpdate(tap("wipe:yes", 100, 99), deps);
    expect(await store.hasUser(99)).toBe(true);
    const user = await store.getUser(99);
    expect(user.facts).toEqual([]);
    expect(user.usage.videos).toBe(1);
    expect(store.saves.filter((s) => s.userId === 99)).toHaveLength(0);
  });
});

describe("isOutOfCredit and secretMatches", () => {
  it("spots billing errors from Anthropic and OpenAI", () => {
    expect(isOutOfCredit(new Error("Your credit balance is too low"))).toBe(true);
    expect(isOutOfCredit(new Error("429 insufficient_quota"))).toBe(true);
    expect(isOutOfCredit(new Error("timeout"))).toBe(false);
  });
  it("compares secrets exactly", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(secretMatches("", "abc")).toBe(false);
  });
});

describe("handleUpdate", () => {
  it("keeps strangers out, including their button taps", async () => {
    const { deps, sent, brain, store } = setup();
    await handleUpdate(text("hello", 9), deps);
    expect(sent[0]?.html).toContain("invite-only");
    expect(sent[0]?.html).toContain("<code>9</code>");
    await handleUpdate(tap("wipe:yes", 100, 9), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", "Knowing is invite-only for now.");
    expect(brain.answer).not.toHaveBeenCalled();
    expect(await store.hasUser(9)).toBe(false);
  });

  it("watches a shared TikTok link and reacts briefly, with the steps one tap away", async () => {
    const { deps, sent, edits, store, media } = setup();
    await handleUpdate(text("look https://vm.tiktok.com/ZMabc/"), deps);
    expect(media.fromLink).toHaveBeenCalledWith("https://vm.tiktok.com/ZMabc/");
    expect(sent[0]?.html).toBe("Watching…");
    expect(edits[0]?.html).toContain("A split dodge drill for your weak hand.");
    expect(edits[0]?.html).toContain("Saved: Split dodge drill");
    expect(edits[0]?.html).not.toContain("1. Jog");
    expect(datas(edits[0]?.buttons)).toEqual([expect.stringMatching(/^show:/), expect.stringMatching(/^open:/), expect.stringMatching(/^fix:/)]);
    expect(store.saves[0]?.sourceUrl).toBe("https://vm.tiktok.com/ZMabc/");
  });

  it("gives the watcher what's already saved and known, keeps both ways by default and offers Replace", async () => {
    const { deps, edits, store, brain } = setup({ watch: (saves) => (saves[0] ? { relation: "alternative", relatedId: saves[0].id, reply: "This one puts Mira on CCTV, not lockers." } : {}) });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    const oldId = store.saves[0]!.id;
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    expect(vi.mocked(brain.watch).mock.calls[1]?.[0].saves.map((s) => s.id)).toEqual([oldId]);
    const reaction = edits.at(-1)!;
    expect(datas(reaction.buttons)[0]).toBe(`repl:${store.saves[0]!.id}:${oldId}`);
    expect(datas(reaction.buttons)).not.toContainEqual(expect.stringMatching(/^keep:/));
    await handleUpdate(tap(datas(reaction.buttons)[0]!, reaction.id), deps);
    expect(store.saves.map((s) => s.id)).not.toContain(oldId);
    expect(edits.at(-1)?.html).toContain("Replaced the old one");
  });

  it("shows the full steps on request", async () => {
    const { deps, sent, store } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    await handleUpdate(tap(`show:${store.saves[0]!.id}`), deps);
    expect(sent.at(-1)?.html).toContain("1. Jog");
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

  it("answers from saves, names and links them, and remembers facts the user mentions", async () => {
    const { deps, sent, store, brain } = setup({ answer: { remember: ["Plays Siege on PC, Gold rank"] } });
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    await handleUpdate(text("I'm gold on PC. what was that dodge drill?"), deps);
    const reply = sent.at(-1)!;
    expect(reply.html).toContain("Do the split dodge.");
    expect(reply.html).toContain('From your save: <a href="https://vm.tiktok.com/ZMabc/">Split dodge drill</a>');
    expect(datas(reply.buttons)).toEqual([expect.stringMatching(/^open:/)]);
    expect((await store.getUser(7)).facts).toEqual(["Plays Siege on PC, Gold rank"]);
    await handleUpdate(text("and again?"), deps);
    expect(vi.mocked(brain.answer).mock.calls[1]?.[0].user.facts).toEqual(["Plays Siege on PC, Gold rank"]);
  });

  it("says Your video, not From your save, when the answer came from its own knowledge", async () => {
    const { deps, sent, brain } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    vi.mocked(brain.answer).mockImplementationOnce(async ({ saves }) => ({ text: "Your video shows the drill. Here's a warm-up:", sources: [], about: saves.map((s) => s.id), remember: [] }));
    await handleUpdate(text("how do I warm up for it?"), deps);
    const reply = sent.at(-1)!.html;
    expect(reply).toContain('Your video: <a href="https://vm.tiktok.com/ZMabc/">Split dodge drill</a>');
    expect(reply).not.toContain("From your save");
  });

  it("keeps the text read off the screen with the save, so a command shown for a second is found later", async () => {
    const { deps, brain, media, store } = setup();
    vi.mocked(media.fromLink).mockResolvedValueOnce({ frames: ["aGk="], transcript: "", screenText: "npx -y firecrawl-mcp", caption: "5 MCPs", notes: [] });
    await handleUpdate(text("https://vm.tiktok.com/ZMmcp/"), deps);
    expect(vi.mocked(brain.watch).mock.calls[0]?.[0].screenText).toBe("npx -y firecrawl-mcp");
    expect(store.saves[0]?.source).toContain("On screen: npx -y firecrawl-mcp");
  });

  it("indexes the video's own words and hands the matching passages to the answer", async () => {
    const { deps, brain, retriever, store } = setup();
    vi.mocked(deps.media.fromLink).mockResolvedValueOnce({ frames: [], transcript: "plant your left foot then split hard to the right", caption: "dodge", notes: [] });
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    expect(store.saves[0]?.source).toContain("plant your left foot");
    expect(retriever.chunks.some((c) => c.kind === "source")).toBe(true);
    await handleUpdate(text("which foot do I plant on the split?"), deps);
    const retrieved = vi.mocked(brain.answer).mock.calls[0]?.[0].retrieved ?? [];
    expect(retrieved[0]?.save.id).toBe(store.saves[0]!.id);
    expect(retrieved[0]?.passages.join(" ")).toContain("plant your left foot");
  });

  it("drops a replaced save from search", async () => {
    const { deps, edits, store, retriever } = setup({ watch: (saves) => (saves[0] ? { relation: "duplicate", relatedId: saves[0].id } : {}) });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    const oldId = store.saves[0]!.id;
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    await handleUpdate(tap(datas(edits.at(-1)?.buttons)[1]!, edits.at(-1)!.id), deps);
    expect(retriever.chunks.some((c) => c.saveId === oldId)).toBe(false);
  });

  it("still answers when search and chat memory are down", async () => {
    const { deps, brain, retriever, sent } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    vi.spyOn(retriever, "search").mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(retriever, "recall").mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(retriever, "remember").mockRejectedValueOnce(new Error("db down"));
    await handleUpdate(text("split dodge drill?"), deps);
    expect(vi.mocked(brain.answer).mock.calls[0]?.[0].retrieved[0]?.save.title).toBe("Split dodge drill");
    expect(sent.at(-1)?.html).toContain("Do the split dodge.");
  });

  it("knows which video a follow-up means, and their name", async () => {
    const { deps, brain, retriever } = setup({ draft: { title: "Ferrari F80 launch", topic: "Cars, Ferrari", type: "info" }, watch: () => ({ reply: "That's the F80, 1,200 hp." }) });
    const search = vi.spyOn(retriever, "search");
    await handleUpdate(text("https://vm.tiktok.com/ZMcar/"), deps);
    await handleUpdate({ message: { message_id: 2, chat: { id: 7 }, from: { id: 7, first_name: "Aiden" }, text: "how fast is it?" } }, deps);
    const input = vi.mocked(brain.answer).mock.calls[0]![0];
    expect(input.name).toBe("Aiden");
    expect(input.user.turns.slice(0, 2).map((t) => t.content)).toEqual(['[Shared a video, saved as "Ferrari F80 launch" (Cars, Ferrari)]', "That's the F80, 1,200 hp."]);
    expect(search.mock.calls[0]?.[1]).toContain("Ferrari F80 launch");
  });

  it("keeps every chat, and brings back what they said in older ones", async () => {
    const { deps, brain, retriever } = setup();
    await retriever.remember(7, { said: "my tryout is on friday", answered: "Good luck!", at: "2026-10-01T00:00:00Z" });
    await handleUpdate(text("my tryout"), deps);
    expect(vi.mocked(brain.answer).mock.calls[0]?.[0].memories?.map((m) => m.said)).toEqual(["my tryout is on friday"]);
    expect(retriever.memories.map((m) => m.said)).toEqual(["my tryout is on friday", "my tryout"]);
    await handleUpdate(text("my tryout"), deps);
    expect(vi.mocked(brain.answer).mock.calls[1]?.[0].memories?.map((m) => m.said)).toEqual(["my tryout is on friday"]);
  });

  it("shows and forgets remembered facts", async () => {
    const { deps, sent, edits, store } = setup({ answer: { remember: ["Junior in high school"] } });
    await handleUpdate(text("I'm a junior"), deps);
    await handleUpdate(text("/memory"), deps);
    expect(sent.at(-1)?.html).toContain("1. Junior in high school");
    await handleUpdate(tap("forget:0", sent.at(-1)!.id), deps);
    expect((await store.getUser(7)).facts).toEqual([]);
    expect(edits.at(-1)?.html).toContain("Nothing yet");
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

  it("marks a scroll session for the wrap-up, and still saves if that fails", async () => {
    const { deps, store, edits } = setup();
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    expect((await store.getUser(7)).sitting?.last).toBe(store.saves[0]?.createdAt);
    vi.spyOn(store, "touchSitting").mockRejectedValueOnce(new Error("no sitting column"));
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    expect(store.saves).toHaveLength(2);
    expect(edits.at(-1)?.html).toContain("Saved: Split dodge drill");
  });

  it("takes the next message as a correction after Fix something, without touching the video's words", async () => {
    const { deps, store, brain, sent } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    const id = store.saves[0]!.id;
    await handleUpdate(tap(`fix:${id}`), deps);
    expect(sent.at(-1)?.html).toContain("What did I get wrong");
    await handleUpdate(text("the barrier goes on the wall, not the ceiling"), deps);
    expect(brain.rewrite).toHaveBeenCalledWith(expect.objectContaining({ id }), "the barrier goes on the wall, not the ceiling", "fix");
    expect(brain.answer).not.toHaveBeenCalled();
    expect(store.saves[0]?.words).toBe("");
    expect(sent.at(-1)?.html).toContain("Fixed.");
    expect((await store.getUser(7)).awaitingWordsFor).toBeNull();
  });

  it("tells the user when something fails instead of going silent, and alerts the owner", async () => {
    const { deps, sent, brain, alerts } = setup();
    vi.mocked(brain.answer).mockRejectedValueOnce(new Error("boom"));
    await handleUpdate(text("hi"), deps);
    expect(sent.at(-1)?.html).toContain("went wrong");
    expect(alerts[0]).toContain("boom");
  });

  it("says it's paused, not broken, when the API is out of credit", async () => {
    const { deps, edits, store, brain, alerts } = setup();
    vi.mocked(brain.watch).mockRejectedValueOnce(new Error("400 Your credit balance is too low to access the Anthropic API"));
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    expect(edits.at(-1)?.html).toContain("paused");
    expect(alerts[0]).toContain("Out of API credit");
    expect(store.saves).toHaveLength(0);
  });

  it("stops at the daily limits", async () => {
    const { deps, sent, brain, media } = setup({ limits: { videos: 1, questions: 1 } });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    expect(media.fromLink).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)?.html).toContain("daily limit");
    await handleUpdate(text("what was that drill?"), deps);
    await handleUpdate(text("and the other one?"), deps);
    expect(brain.answer).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)?.html).toContain("daily limit");
  });

  it("says when the limits reset, at midnight UTC", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(resetsIn(at("2026-11-02T18:00:00Z"))).toBe("in about 6 hours");
    expect(resetsIn(at("2026-11-02T22:40:00Z"))).toBe("in about 1 hour");
    expect(resetsIn(at("2026-11-02T23:30:00Z"))).toBe("in under an hour");
    expect(limitText("videos", 5, at("2026-11-02T18:00:00Z"))).toBe("That's 5 videos today, the daily limit, so I didn't save this one. Send it again in about 6 hours.");
    expect(limitText("questions", 10, at("2026-11-02T18:00:00Z"))).toBe("That's 10 questions today, the daily limit. You can ask more in about 6 hours.");
  });

  it("resets the limits on a new day", () => {
    const user = { id: 7, facts: [], turns: [], awaitingWordsFor: null, usage: { day: "2000-01-01", videos: 9, questions: 9 }, sitting: null };
    expect(spend(user, "videos", 1)).toBe(true);
    expect(user.usage.videos).toBe(1);
    expect(spend(user, "videos", 1)).toBe(false);
  });

  it("deletes everything only after confirming", async () => {
    const { deps, sent, edits, store } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    await handleUpdate(text("/delete"), deps);
    expect(sent.at(-1)?.html).toContain("1 save");
    expect(datas(sent.at(-1)?.buttons)).toEqual(["wipe:yes", "wipe:no"]);
    await handleUpdate(tap("wipe:no"), deps);
    expect(store.saves).toHaveLength(1);
    await handleUpdate(tap("wipe:yes"), deps);
    expect(store.saves).toHaveLength(0);
    expect((await store.getUser(7)).turns).toEqual([]);
    expect(edits.at(-1)?.html).toContain("Deleted");
  });
});
