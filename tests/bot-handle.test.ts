import { describe, expect, it, vi } from "vitest";
import { asksAboutUsage, handleUpdate, inviteCode, isOutOfCredit, limitText, parseAllowed, resetsIn, secretMatches, spend, usageText, type Deps, type Update } from "@/lib/bot/handle";
import { MemoryRetriever } from "@/lib/bot/rag";
import { MemoryStore } from "@/lib/bot/store";
import type { Answer, Brain, InlineButton, Media, Save, SaveDraft, TelegramApi, WatchResult } from "@/lib/bot/types";

interface Sent { chatId: number; html: string; buttons?: InlineButton[][]; id: number }

function setup(opts: { answer?: Partial<Answer>; draft?: Partial<SaveDraft>; watch?: (saves: Save[]) => Partial<WatchResult>; limits?: Deps["limits"]; spots?: number; packStars?: number } = {}) {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  let nextId = 100;
  const tg: TelegramApi = {
    sendMessage: vi.fn(async (chatId, html, buttons) => { const id = nextId++; sent.push({ chatId, html, buttons, id }); return id; }),
    editMessage: vi.fn(async (chatId, id, html, buttons) => { edits.push({ chatId, html, buttons, id }); }),
    answerCallback: vi.fn(async () => {}),
    typing: vi.fn(async () => {}),
    sendInvoice: vi.fn(async () => {}),
    answerPreCheckout: vi.fn(async () => {}),
    refundStars: vi.fn(async () => {}),
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
  const deps: Deps = { tg, store, brain, media, retriever, isAllowed: (id) => id === 7, ownerId: 7, invite: { code: "join-abc123", spots: opts.spots ?? 10, link: async () => "https://t.me/KnowingTestBot?start=join-abc123" }, limits: opts.limits ?? { videos: 50, questions: 50 }, packStars: opts.packStars ?? 100, alert: async (t) => void alerts.push(t) };
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

const paid = (charge: string, from = 99, payload = "pack:videos:100", stars = 100): Update => ({
  message: { message_id: 2, chat: { id: from }, from: { id: from, first_name: "Sam" }, successful_payment: { currency: "XTR", total_amount: stars, invoice_payload: payload, telegram_payment_charge_id: charge } },
});
const checkout = (payload = "pack:videos:100", amount = 100, from = 99): Update => ({ pre_checkout_query: { id: "pc", from: { id: from }, currency: "XTR", total_amount: amount, invoice_payload: payload } });

describe("buying extras with Stars", () => {
  it("offers a pack when the free ones run out, and sends a Stars invoice when tapped", async () => {
    const { deps, sent } = setup({ limits: { videos: 1, questions: 1 } });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    expect(sent.at(-1)?.html).toContain("Or get 10 more videos now. They never expire.");
    expect(datas(sent.at(-1)?.buttons)).toEqual(["buy:videos"]);
    await handleUpdate(tap("buy:videos"), deps);
    expect(deps.tg.sendInvoice).toHaveBeenCalledWith(7, expect.objectContaining({ title: "10 more videos", payload: "pack:videos:100", stars: 100 }));
    await handleUpdate(text("q1"), deps);
    await handleUpdate(text("q2"), deps);
    expect(datas(sent.at(-1)?.buttons)).toEqual(["buy:questions"]);
  });

  it("says so when Telegram won't make the payment screen, instead of doing nothing", async () => {
    const { deps, sent } = setup({ limits: { videos: 1, questions: 1 } });
    await handleUpdate(text("/start join-abc123", 99), deps);
    vi.mocked(deps.tg.sendInvoice).mockRejectedValueOnce(new Error("sendInvoice: Bad Request: STARS_INVOICE_INVALID"));
    await handleUpdate(tap("buy:questions", 100, 99), deps);
    expect(sent.find((m) => m.chatId === 99 && m.html.includes("payment screen"))?.html).toContain("nothing was charged");
    expect(sent.at(-1)).toMatchObject({ chatId: 7, html: expect.stringContaining("STARS_INVOICE_INVALID") });
  });

  it("explains a buy button tapped after buying was turned off", async () => {
    const { deps, sent } = setup({ packStars: 0 });
    await handleUpdate(tap("buy:videos"), deps);
    expect(deps.tg.sendInvoice).not.toHaveBeenCalled();
    expect(sent.at(-1)?.html).toBe("Buying extras is turned off right now.");
  });

  it("shows no buy button when buying is turned off", async () => {
    const { deps, sent } = setup({ limits: { videos: 1, questions: 1 }, packStars: 0 });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    expect(sent.at(-1)?.html).toContain("daily limit");
    expect(sent.at(-1)?.buttons).toBeUndefined();
  });

  it("approves a checkout only at the current price, and only for people with access", async () => {
    const { deps } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(checkout(), deps);
    expect(deps.tg.answerPreCheckout).toHaveBeenLastCalledWith("pc", true, undefined);
    await handleUpdate(checkout("pack:videos:50", 50), deps);
    expect(deps.tg.answerPreCheckout).toHaveBeenLastCalledWith("pc", false, expect.stringContaining("price has changed"));
    await handleUpdate(checkout("pack:videos:100", 100, 55), deps);
    expect(deps.tg.answerPreCheckout).toHaveBeenLastCalledWith("pc", false, expect.stringContaining("invite-only"));
  });

  it("stops a checkout when it couldn't record the purchase, so nobody pays for nothing", async () => {
    const { deps, alerts, store } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    store.getWallet = vi.fn(async () => { throw new Error("column bot_users.wallet does not exist"); });
    await handleUpdate(checkout(), deps);
    expect(deps.tg.answerPreCheckout).toHaveBeenLastCalledWith("pc", false, expect.stringContaining("weren't charged"));
    expect(alerts[0]).toContain("supabase.sql");
  });

  it("adds a pack once per payment, then uses it after the free ones", async () => {
    const { deps, sent, store, media } = setup({ limits: { videos: 1, questions: 50 } });
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(paid("ch1"), deps);
    await handleUpdate(paid("ch1"), deps); // Telegram sent it twice
    expect((await store.getWallet(99)).videos).toBe(10);
    expect((await store.getWallet(99)).paid).toHaveLength(1);
    expect(sent.filter((m) => m.chatId === 99).at(-1)?.html).toContain("10 more videos added, so you have 10 extra videos");
    expect(sent.filter((m) => m.chatId === 7).at(-1)?.html).toBe("Sam paid 100 ⭐ for 10 more videos. To refund it: <code>/refund 99 ch1</code>");
    await handleUpdate(text("https://vm.tiktok.com/free/", 99), deps);
    await handleUpdate(text("https://vm.tiktok.com/extra/", 99), deps);
    expect(media.fromLink).toHaveBeenCalledTimes(2);
    expect((await store.getWallet(99)).videos).toBe(9);
  });

  it("refunds with the owner's /refund and takes the pack back off", async () => {
    const { deps, sent, store } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(paid("ch1"), deps);
    await handleUpdate(text("/refund 99 ch1"), deps);
    expect(deps.tg.refundStars).toHaveBeenCalledWith(99, "ch1");
    expect(await store.getWallet(99)).toEqual({ videos: 0, questions: 0, paid: [] });
    expect(sent.filter((m) => m.chatId === 99).at(-1)?.html).toBe("Your payment of 100 ⭐ was refunded.");
    await handleUpdate(text("/refund 99 ch1", 99), deps); // only the owner can refund
    expect(deps.tg.refundStars).toHaveBeenCalledTimes(1);
  });

  it("answers /terms and passes /support and /paysupport to the owner, who can /reply", async () => {
    const { deps, sent } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(paid("ch1"), deps);
    await handleUpdate(text("/terms", 99), deps);
    expect(sent.at(-1)?.html).toContain("Knowing terms");
    await handleUpdate(text("/paysupport", 99), deps);
    expect(sent.at(-1)?.html).toContain("Telegram's own support can't help");
    await handleUpdate(text("/paysupport I paid but got nothing", 99), deps);
    const notice = sent.filter((m) => m.chatId === 7).at(-1)?.html ?? "";
    expect(notice).toContain("Payment problem");
    expect(notice).toContain("<code>/refund 99 ch1</code>");
    expect(notice).toContain("<code>/reply 99 your message</code>");
    await handleUpdate(text("/reply 99 Sorted, check again"), deps);
    expect(sent.filter((m) => m.chatId === 99).at(-1)?.html).toBe("<b>From the owner:</b> Sorted, check again");
  });

  it("keeps what someone bought after /delete", async () => {
    const { deps, store } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(paid("ch1"), deps);
    await handleUpdate(tap("wipe:yes", 100, 99), deps);
    expect((await store.getWallet(99)).videos).toBe(10);
  });
});

describe("usage", () => {
  const at = Date.parse("2026-11-02T18:00:00Z");
  const usage = { day: "2026-11-02", videos: 2, questions: 7 };
  const limits = { videos: 5, questions: 10 };

  it("shows what's left today, when it resets, and what they bought", () => {
    expect(usageText(usage, limits, null, 100, at)).toBe(
      "<b>Free today</b>, back to full in about 6 hours:\nVideos: 3 of 5 left\nQuestions: 3 of 10 left\n\nWhen your free ones run out, you can get 10 more videos or 20 more questions for 100 ⭐ each.",
    );
    expect(usageText(usage, limits, { videos: 1, questions: 20, paid: [] }, 100, at)).toContain("<b>Extras you bought:</b> 1 video and 20 questions. They never expire");
    expect(usageText(usage, limits, null, 0, at)).not.toContain("⭐");
  });

  it("counts from zero on a new day, and never shows less than 0 left", () => {
    expect(usageText({ day: "2026-11-01", videos: 5, questions: 10 }, limits, null, 0, at)).toContain("Videos: 5 of 5 left\nQuestions: 10 of 10 left");
    expect(usageText({ day: "2026-11-02", videos: 9, questions: 10 }, limits, null, 0, at)).toContain("Videos: 0 of 5 left\nQuestions: 0 of 10 left");
  });

  it("spots questions about what's left, but not real questions about videos", () => {
    for (const q of ["How many questions do I have left?", "how many videos left today", "how many more videos can I send", "How many questions can I ask?", "any questions left?", "what's my limit", "My usage", "Whats my daily limit?", "videos remaining?"]) expect(asksAboutUsage(q), q).toBe(true);
    for (const q of ["how many videos have I saved about pasta?", "do you still have my pasta video?", "the video where he turns left", "how do I push my limits in the gym?", "what was the speed limit in that video?", "how many questions are on the SAT?"]) expect(asksAboutUsage(q), q).toBe(false);
  });

  it("answers /usage and \"how many do I have left?\" without using a question, even at the limit", async () => {
    const { deps, sent, brain } = setup({ limits: { videos: 5, questions: 1 } });
    await handleUpdate(text("what was that drill?"), deps);
    await handleUpdate(text("/usage"), deps);
    expect(sent.at(-1)?.html).toContain("Questions: 0 of 1 left");
    await handleUpdate(text("how many questions do I have left?"), deps);
    expect(sent.at(-1)?.html).toContain("Questions: 0 of 1 left");
    expect(sent.at(-1)?.buttons).toBeUndefined();
    expect(brain.answer).toHaveBeenCalledTimes(1);
  });

  it("shows bought extras, and tells the bot the numbers so any wording works", async () => {
    const { deps, sent, brain, store } = setup({ limits: { videos: 5, questions: 10 } });
    await store.saveWallet(7, { videos: 10, questions: 0, paid: [] });
    await handleUpdate(text("/usage"), deps);
    expect(sent.at(-1)?.html).toContain("Extras you bought:</b> 10 videos and 0 questions");
    await handleUpdate(text("can I still send stuff today?"), deps);
    expect(brain.answer).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.stringContaining("Questions: 9 of 10 left") }));
    expect(vi.mocked(brain.answer).mock.calls[0][0].usage).not.toContain("<b>");
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

  it("lists the video under related, not From your save, when the answer came from its own knowledge", async () => {
    const { deps, sent, brain } = setup();
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    vi.mocked(brain.answer).mockImplementationOnce(async ({ saves }) => ({ text: "Your video shows the drill. Here's a warm-up:", sources: [], about: saves.map((s) => s.id), remember: [] }));
    await handleUpdate(text("how do I warm up for it?"), deps);
    const reply = sent.at(-1)!.html;
    expect(reply).toContain('<b>Videos related to this topic:</b>\n• <a href="https://vm.tiktok.com/ZMabc/">Split dodge drill</a>');
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
