import { describe, expect, it, vi } from "vitest";
import { folderKey } from "@/lib/bot/folders";
import { asksAboutUsage, folderNameFrom, handleUpdate, inviteCode, isOutOfCredit, limitText, namingFor, parseAllowed, readNaming, secretMatches, spend, usageText, type Deps, type Update } from "@/lib/bot/handle";
import { MemoryRetriever } from "@/lib/bot/rag";
import { MemoryStore } from "@/lib/bot/store";
import { ALL_COMMANDS, COMMANDS, WELCOME } from "@/lib/bot/profile";
import { readReferral, referralCode } from "@/lib/bot/referral";
import { NoTranscription, type Answer, type Brain, type InlineButton, type Media, type Pack, type Save, type SaveDraft, type TelegramApi, type WatchResult } from "@/lib/bot/types";

/** Packs on sale in these tests. */
const PACKS: Pack[] = [
  { kind: "videos", count: 10, stars: 150 },
  { kind: "videos", count: 20, stars: 300 },
  { kind: "questions", count: 20, stars: 150 },
  { kind: "questions", count: 40, stars: 300 },
];
/** 7 is the owner (no limits); 8 is another allowed user, who has them. */
const FRIEND = 8;

interface Sent { chatId: number; html: string; buttons?: InlineButton[][]; id: number }

function setup(opts: { answer?: Partial<Answer>; draft?: Partial<SaveDraft>; watch?: (saves: Save[]) => Partial<WatchResult>; limits?: Deps["limits"]; spots?: number; packs?: Pack[]; heard?: { text: string; cut: boolean }; newcomers?: boolean; open?: { cap: number } } = {}) {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  /** Buttons changed in place (the text stays). */
  const rebuttons: Sent[] = [];
  let nextId = 100;
  const tg: TelegramApi = {
    sendMessage: vi.fn(async (chatId, html, buttons) => { const id = nextId++; sent.push({ chatId, html, buttons, id }); return id; }),
    editMessage: vi.fn(async (chatId, id, html, buttons) => { edits.push({ chatId, html, buttons, id }); }),
    editButtons: vi.fn(async (chatId, id, buttons) => { rebuttons.push({ chatId, html: "", buttons, id }); }),
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
    answer: vi.fn(async ({ saves }: { saves: Save[] }) => ({ text: "Do the split dodge.", sources: saves.map((s) => s.id), about: [], remember: [], moves: [], renames: [], rules: [], collects: [], uncollects: [], ...opts.answer })),
    wrapUp: vi.fn(async ({ kept }: { kept: Save[] }) => `From that scroll you kept **${kept.length}**.`),
  };
  const media: Media = {
    fromLink: vi.fn(async () => ({ frames: ["aGk="], transcript: "", caption: "dodge tips", notes: [] })),
    fromTelegramFile: vi.fn(async () => ({ frames: ["aGk="], transcript: "say this", caption: "", notes: [] })),
    hearVoice: vi.fn(async () => opts.heard ?? { text: "what was that drill?", cut: false }),
  };
  const store = new MemoryStore();
  // The owner and the friend were already asked about the weekly flashback, so it doesn't show up in every test.
  if (!opts.newcomers) for (const id of [7, FRIEND]) store.digests.set(id, { on: false, offered: true, sent: "", quiet: 0 });
  const retriever = new MemoryRetriever();
  const alerts: string[] = [];
  const deps: Deps = { tg, store, brain, media, retriever, isAllowed: (id) => id === 7 || id === FRIEND, ownerId: 7, invite: { code: "join-abc123", spots: opts.spots ?? 10, key: "test-key", link: async (start = "join-abc123") => `https://t.me/KnowingTestBot${start ? `?start=${start}` : ""}` }, limits: opts.limits ?? { videos: 50, questions: 50 }, packs: opts.packs ?? PACKS, alert: async (t) => void alerts.push(t), open: opts.open };
  return { deps, sent, edits, rebuttons, store, brain, media, retriever, alerts };
}

const text = (t: string, from = 7, name?: string): Update => ({ message: { message_id: 1, chat: { id: from }, from: { id: from, first_name: name }, text: t } });
const tap = (data: string, messageId = 100, from = 7): Update => ({ callback_query: { id: "cb", from: { id: from }, data, message: { message_id: messageId, chat: { id: from } } } });
const datas = (b?: InlineButton[][]) => (b ?? []).flat().map((x) => x.callback_data);
const voice = (from = 7, duration = 4): Update => ({ message: { message_id: 1, chat: { id: from }, from: { id: from }, voice: { file_id: "V", duration } } });

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
    expect(sent.find((m) => m.chatId === 99)?.html).toContain("Send me any video");
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

  it("gives the owner the main link and the spots used with /invite, and everyone else their own link", async () => {
    const { deps, sent, brain } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(text("/invite"), deps);
    expect(sent.at(-1)?.html).toContain("https://t.me/KnowingTestBot?start=join-abc123");
    expect(sent.at(-1)?.html).toContain("1 of 10 spots used");
    await handleUpdate(text("/invite", 99), deps);
    expect(sent.at(-1)?.html).toContain(`https://t.me/KnowingTestBot?start=${referralCode("test-key", 99)}`);
    expect(sent.at(-1)?.html).not.toContain("join-abc123");
    expect(sent.at(-1)?.html).toContain("saves a video and asks me something, you get 3 free videos");
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("keeps someone's spot and what they've used after /delete, so it can't hand out new free ones", async () => {
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

describe("links the bot can't open", () => {
  it("doesn't use up a video on an Instagram link, even with none left", async () => {
    const { deps, sent, store } = setup({ limits: { videos: 1, questions: 50 } });
    vi.mocked(deps.media.fromLink).mockResolvedValue({ frames: [], transcript: "", caption: "", notes: ["Instagram doesn't let me download videos from a link."] });
    await handleUpdate(text("https://www.instagram.com/reel/abc/", FRIEND), deps);
    expect((await store.getUser(FRIEND)).usage.videos).toBe(0);
    await handleUpdate(text("https://vm.tiktok.com/one/", FRIEND), deps);
    await handleUpdate(text("https://www.instagram.com/reel/def/", FRIEND), deps);
    expect(sent.at(-1)?.html).not.toContain("out of videos");
    expect(store.saves.filter((s) => s.userId === FRIEND)).toHaveLength(0);
  });
});

describe("public mode", () => {
  it("lets anyone in with any first message, no invite needed, and tells the owner", async () => {
    const { deps, sent, store, brain } = setup({ open: { cap: 0 } });
    await handleUpdate(text("what can you do?", 99, "Sam"), deps);
    expect(await store.hasUser(99)).toBe(true);
    expect(brain.answer).toHaveBeenCalledTimes(1);
    expect(sent.find((m) => m.chatId === 7)?.html).toBe("Sam joined Knowing with the public link. 1 person so far.");
    expect(sent.some((m) => m.chatId === 99 && m.html.includes("invite-only"))).toBe(false);
  });

  it("still records who invited them, so the referral reward works", async () => {
    const { deps, store } = setup({ open: { cap: 0 } });
    await handleUpdate(text(`/start ${referralCode("test-key", FRIEND)}`, 99), deps);
    expect((await store.getReferral(99)).by).toBe(FRIEND);
  });

  it("stops at its cap when one is set", async () => {
    const { deps, sent, store } = setup({ open: { cap: 1 }, spots: 100 });
    await handleUpdate(text("hi", 98), deps);
    await handleUpdate(text("hi", 99, "Alex"), deps);
    expect(await store.hasUser(98)).toBe(true);
    expect(await store.hasUser(99)).toBe(false);
    expect(sent.filter((m) => m.chatId === 7).at(-1)?.html).toContain("raise KNOWING_PUBLIC_SPOTS");
  });

  it("ignores the invite spots, which only apply when it's invite-only", async () => {
    const { deps, store } = setup({ open: { cap: 0 }, spots: 1 });
    await handleUpdate(text("hi", 98), deps);
    await handleUpdate(text("hi", 99), deps);
    expect(await store.hasUser(99)).toBe(true);
  });

  it("gives the owner the plain public link with /invite", async () => {
    const { deps, sent } = setup({ open: { cap: 0 } });
    await handleUpdate(text("hi", 99), deps);
    await handleUpdate(text("/invite"), deps);
    expect(sent.at(-1)?.html).toContain("Knowing is <b>public</b>. Anyone can start it with this link:\nhttps://t.me/KnowingTestBot\n\n1 person joined so far.");
    await handleUpdate(text("/invite", 99), deps);
    expect(sent.at(-1)?.html).not.toContain("invite-only");
  });
});

describe("inviting friends", () => {
  const link = (inviter: number) => `/start ${referralCode("test-key", inviter)}`;

  it("makes a link only the right key can read, and turns away made-up ones", () => {
    const code = referralCode("test-key", 8429146259);
    expect(code).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(readReferral("test-key", code)).toBe(8429146259);
    expect(readReferral("other-key", code)).toBe(0);
    expect(readReferral("test-key", code.replace(/^r[0-9a-z]+_/, "r1_"))).toBe(0);
    expect(readReferral("test-key", "join-abc123")).toBe(0);
    expect(readReferral("", code)).toBe(0);
  });

  it("lets a friend join with someone's own link, using up a spot, and tells both of them", async () => {
    const { deps, sent, store } = setup({ spots: 1 });
    await handleUpdate(text(link(FRIEND), 99, "Sam"), deps);
    expect(await store.hasUser(99)).toBe(true);
    expect((await store.getReferral(99)).by).toBe(FRIEND);
    expect(sent.find((m) => m.chatId === FRIEND)?.html).toBe("Sam joined Knowing with your link. Once they save a video and ask me something, you get 3 free videos.");
    expect(sent.find((m) => m.chatId === 7)?.html).toContain(`Sam joined Knowing with a friend's invite link (<code>${FRIEND}</code>). 1 of 1 spots used.`);
    // The spot is taken, so the next friend has to wait.
    await handleUpdate(text(link(FRIEND), 98), deps);
    expect(await store.hasUser(98)).toBe(false);
    expect(sent.filter((m) => m.chatId === 98).at(-1)?.html).toContain("full right now");
  });

  it("turns away a link that's made up or belongs to someone not in Knowing", async () => {
    const { deps, store } = setup();
    await handleUpdate(text("/start r8_AAAAAAAAAA", 99), deps);
    await handleUpdate(text(link(12345), 98), deps);
    expect(await store.hasUser(99)).toBe(false);
    expect(await store.hasUser(98)).toBe(false);
  });

  it("gives the inviter 3 free videos only once the friend has saved a video and asked something, and only once", async () => {
    const { deps, sent, store } = setup();
    await handleUpdate(text(link(FRIEND), 99, "Sam"), deps);
    await handleUpdate(text("https://vm.tiktok.com/one/", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(0);
    await handleUpdate(text("https://vm.tiktok.com/two/", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(0);
    await handleUpdate(text("what was that drill?", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(3);
    expect(sent.filter((m) => m.chatId === FRIEND).at(-1)?.html).toContain("Sam is using Knowing now, thanks to you, so you got <b>3 free videos</b>");
    await handleUpdate(text("and the second one?", 99), deps);
    await handleUpdate(text("https://vm.tiktok.com/three/", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(3);
    expect((await store.getReferral(FRIEND)).rewarded).toBe(1);
  });

  it("still rewards a friend who saves lots of videos before asking anything", async () => {
    const { deps, store } = setup();
    await handleUpdate(text(link(FRIEND), 99), deps);
    for (const n of [1, 2, 3, 4, 5]) await handleUpdate(text(`https://vm.tiktok.com/v${n}/`, 99), deps);
    await handleUpdate(text("what was in the last one?", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(3);
  });

  it("stops rewarding after 5 friends, and says so in /invite", async () => {
    const { deps, sent, store } = setup({ spots: 20 });
    await store.saveReferral(FRIEND, { by: 0, name: "", credited: false, rewarded: 5 });
    await handleUpdate(text(link(FRIEND), 99), deps);
    await handleUpdate(text("https://vm.tiktok.com/one/", 99), deps);
    await handleUpdate(text("what was that drill?", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(0);
    await handleUpdate(text("/invite", FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("You've earned free videos for 5 friends, the most there is.");
  });

  it("keeps who invited them after /delete, so a wipe can't earn the inviter a second reward", async () => {
    const { deps, store } = setup();
    await handleUpdate(text(link(FRIEND), 99), deps);
    await handleUpdate(text("https://vm.tiktok.com/one/", 99), deps);
    await handleUpdate(text("what was that drill?", 99), deps);
    await handleUpdate(tap("wipe:yes", 100, 99), deps);
    expect(await store.getReferral(99)).toMatchObject({ by: FRIEND, credited: true });
    await handleUpdate(text("https://vm.tiktok.com/two/", 99), deps);
    await handleUpdate(text("and that one?", 99), deps);
    expect((await store.getWallet(FRIEND)).videos).toBe(3);
  });
});

const paid = (charge: string, from = 99, payload = "pack:videos:10:150", stars = 150): Update => ({
  message: { message_id: 2, chat: { id: from }, from: { id: from, first_name: "Sam" }, successful_payment: { currency: "XTR", total_amount: stars, invoice_payload: payload, telegram_payment_charge_id: charge } },
});
const checkout = (payload = "pack:videos:10:150", amount = 150, from = 99): Update => ({ pre_checkout_query: { id: "pc", from: { id: from }, currency: "XTR", total_amount: amount, invoice_payload: payload } });

describe("buying extras with Stars", () => {
  it("offers that kind's packs when someone runs out, and sends a Stars invoice for the one tapped", async () => {
    const { deps, sent } = setup({ limits: { videos: 1, questions: 1 } });
    await handleUpdate(text("https://vm.tiktok.com/one/", FRIEND), deps);
    await handleUpdate(text("https://vm.tiktok.com/two/", FRIEND), deps);
    expect(sent.at(-1)?.html).toBe("You're out of videos (your free one is used up), so I didn't save this one.\n\nGet more to keep going. They never expire.");
    expect(sent.at(-1)?.buttons).toEqual([[{ text: "10 more videos, 150 ⭐", callback_data: "buy:videos:10" }], [{ text: "20 more videos, 300 ⭐", callback_data: "buy:videos:20" }]]);
    await handleUpdate(tap("buy:videos:20", 100, FRIEND), deps);
    expect(deps.tg.sendInvoice).toHaveBeenCalledWith(FRIEND, expect.objectContaining({ title: "20 more videos", payload: "pack:videos:20:300", stars: 300 }));
    await handleUpdate(text("q1", FRIEND), deps);
    await handleUpdate(text("q2", FRIEND), deps);
    expect(datas(sent.at(-1)?.buttons)).toEqual(["buy:questions:20", "buy:questions:40"]);
  });

  it("sells any pack with /buy, before the free ones run out", async () => {
    const { deps, sent } = setup();
    await handleUpdate(text("/buy", FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("Pick a pack.");
    expect(sent.at(-1)?.buttons).toEqual([
      [{ text: "10 videos, 150 ⭐", callback_data: "buy:videos:10" }, { text: "20 questions, 150 ⭐", callback_data: "buy:questions:20" }],
      [{ text: "20 videos, 300 ⭐", callback_data: "buy:videos:20" }, { text: "40 questions, 300 ⭐", callback_data: "buy:questions:40" }],
    ]);
    await handleUpdate(tap("buy:questions:40", 100, FRIEND), deps);
    expect(deps.tg.sendInvoice).toHaveBeenCalledWith(FRIEND, expect.objectContaining({ title: "40 more questions", stars: 300 }));
  });

  it("shows the packs on sale now when an old buy button is tapped", async () => {
    const { deps, sent } = setup();
    await handleUpdate(tap("buy:videos", 100, FRIEND), deps);
    expect(deps.tg.sendInvoice).not.toHaveBeenCalled();
    expect(datas(sent.at(-1)?.buttons)).toEqual(["buy:videos:10", "buy:videos:20"]);
  });

  it("says so when Telegram won't make the payment screen, instead of doing nothing", async () => {
    const { deps, sent } = setup({ limits: { videos: 1, questions: 1 } });
    await handleUpdate(text("/start join-abc123", 99), deps);
    vi.mocked(deps.tg.sendInvoice).mockRejectedValueOnce(new Error("sendInvoice: Bad Request: STARS_INVOICE_INVALID"));
    await handleUpdate(tap("buy:questions:20", 100, 99), deps);
    expect(sent.find((m) => m.chatId === 99 && m.html.includes("payment screen"))?.html).toContain("nothing was charged");
    expect(sent.at(-1)).toMatchObject({ chatId: 7, html: expect.stringContaining("STARS_INVOICE_INVALID") });
  });

  it("explains a buy button tapped after buying was turned off", async () => {
    const { deps, sent } = setup({ packs: [] });
    await handleUpdate(tap("buy:videos:10"), deps);
    expect(deps.tg.sendInvoice).not.toHaveBeenCalled();
    expect(sent.at(-1)?.html).toBe("Buying extras is turned off right now.");
  });

  it("shows no buy button when buying is turned off", async () => {
    const { deps, sent } = setup({ limits: { videos: 1, questions: 1 }, packs: [] });
    await handleUpdate(text("https://vm.tiktok.com/one/", FRIEND), deps);
    await handleUpdate(text("https://vm.tiktok.com/two/", FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("You're out of videos");
    expect(sent.at(-1)?.buttons).toBeUndefined();
  });

  it("approves a checkout only for a pack on sale at its current price, and only for people with access", async () => {
    const { deps } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(checkout(), deps);
    expect(deps.tg.answerPreCheckout).toHaveBeenLastCalledWith("pc", true, undefined);
    for (const [payload, amount] of [["pack:videos:10:100", 100], ["pack:videos:100", 100], ["pack:videos:15:150", 150], ["pack:videos:10:150", 100]] as const) {
      await handleUpdate(checkout(payload, amount), deps);
      expect(deps.tg.answerPreCheckout, payload).toHaveBeenLastCalledWith("pc", false, expect.stringContaining("price has changed"));
    }
    await handleUpdate(checkout("pack:videos:10:150", 150, 55), deps);
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
    expect(sent.filter((m) => m.chatId === 7).at(-1)?.html).toBe("Sam paid 150 ⭐ for 10 more videos. To refund it: <code>/refund 99 ch1</code>");
    await handleUpdate(text("https://vm.tiktok.com/free/", 99), deps);
    await handleUpdate(text("https://vm.tiktok.com/extra/", 99), deps);
    expect(media.fromLink).toHaveBeenCalledTimes(2);
    expect((await store.getWallet(99)).videos).toBe(9);
    await handleUpdate(paid("ch2", 99, "pack:videos:20:300", 300), deps);
    expect((await store.getWallet(99)).videos).toBe(29);
  });

  it("refunds with the owner's /refund and takes the pack back off", async () => {
    const { deps, sent, store } = setup();
    await handleUpdate(text("/start join-abc123", 99), deps);
    await handleUpdate(paid("ch1"), deps);
    await handleUpdate(text("/refund 99 ch1"), deps);
    expect(deps.tg.refundStars).toHaveBeenCalledWith(99, "ch1");
    expect(await store.getWallet(99)).toEqual({ videos: 0, questions: 0, paid: [] });
    expect(sent.filter((m) => m.chatId === 99).at(-1)?.html).toBe("Your payment of 150 ⭐ was refunded.");
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

  it("shows what's left of the free ones, what they bought, and the packs", () => {
    expect(usageText(usage, limits, null, PACKS)).toBe(
      "<b>Free to start</b> (given once, they don't refill):\nVideos: 3 of 5 left\nQuestions: 3 of 10 left\n\n<b>Get more any time</b> with /buy: 10 videos for 150 ⭐, 20 for 300 ⭐; 20 questions for 150 ⭐, 40 for 300 ⭐. They never expire.",
    );
    expect(usageText(usage, limits, { videos: 1, questions: 20, paid: [] }, PACKS)).toContain("<b>Extras:</b> 1 video and 20 questions, bought or earned with /invite. They never expire");
    expect(usageText(usage, limits, null, [])).not.toContain("⭐");
  });

  it("never refills on a new day, and never shows less than 0 left", () => {
    expect(usageText({ day: "2026-10-01", videos: 5, questions: 10 }, limits, null, [])).toContain("Videos: 0 of 5 left\nQuestions: 0 of 10 left");
    expect(usageText({ day: "2026-11-02", videos: 9, questions: 4 }, limits, null, [])).toContain("Videos: 0 of 5 left\nQuestions: 6 of 10 left");
  });

  it("spots questions about what's left, but not real questions about videos", () => {
    for (const q of ["How many questions do I have left?", "how many videos left today", "how many more videos can I send", "How many questions can I ask?", "any questions left?", "what's my limit", "My usage", "Whats my daily limit?", "videos remaining?"]) expect(asksAboutUsage(q), q).toBe(true);
    for (const q of ["how many videos have I saved about pasta?", "do you still have my pasta video?", "the video where he turns left", "how do I push my limits in the gym?", "what was the speed limit in that video?", "how many questions are on the SAT?"]) expect(asksAboutUsage(q), q).toBe(false);
  });

  it("answers /usage and \"how many do I have left?\" without using a question, even at the limit", async () => {
    const { deps, sent, brain } = setup({ limits: { videos: 5, questions: 1 } });
    await handleUpdate(text("what was that drill?", FRIEND), deps);
    await handleUpdate(text("/usage", FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("Questions: 0 of 1 left");
    expect(datas(sent.at(-1)?.buttons)).toContain("buy:questions:20");
    await handleUpdate(text("how many questions do I have left?", FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("Questions: 0 of 1 left");
    expect(brain.answer).toHaveBeenCalledTimes(1);
  });

  it("shows bought extras, and tells the bot the numbers so any wording works", async () => {
    const { deps, sent, brain, store } = setup({ limits: { videos: 5, questions: 10 } });
    await store.saveWallet(FRIEND, { videos: 10, questions: 0, paid: [] });
    await handleUpdate(text("/usage", FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("Extras:</b> 10 videos and 0 questions");
    await handleUpdate(text("can I still send stuff today?", FRIEND), deps);
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
    expect(datas(edits[0]?.buttons)).toEqual([expect.stringMatching(/^show:/), expect.stringMatching(/^open:/), expect.stringMatching(/^mv:.+:r$/), expect.stringMatching(/^cl:.+:r$/), expect.stringMatching(/^fix:/)]);
    expect(edits[0]?.buttons?.flat().find((b) => b.callback_data.startsWith("mv:"))?.text).toBe("📂 Lacrosse");
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
    vi.mocked(brain.answer).mockImplementationOnce(async ({ saves }) => ({ text: "Your video shows the drill. Here's a warm-up:", sources: [], about: saves.map((s) => s.id), remember: [], moves: [], renames: [], rules: [], collects: [], uncollects: [] }));
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

  it("gives the video back when it can't be saved, and says so", async () => {
    const { deps, edits, store, brain, alerts } = setup({ limits: { videos: 3, questions: 3 } });
    vi.mocked(brain.watch).mockRejectedValueOnce(new Error("Supabase GET saves: couldn't connect after 3 tries (ECONNRESET)"));
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/", FRIEND), deps);
    expect(edits.at(-1)?.html).toBe("Something went wrong on my side, so I didn't save that one. Send it again in a minute. It didn't use up a video.");
    expect(alerts[0]).toContain("ECONNRESET");
    expect(store.saves).toHaveLength(0);
    expect((await store.getUser(FRIEND)).usage.videos).toBe(0);
    expect((await store.getUser(FRIEND)).turns).toEqual([]);
    // A bought one goes back in the wallet.
    await store.saveWallet(FRIEND, { videos: 2, questions: 0, paid: [] });
    const user = await store.getUser(FRIEND);
    await store.saveUser({ ...user, usage: { ...user.usage, videos: 3 } });
    vi.mocked(deps.media.fromLink).mockRejectedValueOnce(new Error("Downloading the video: couldn't connect after 3 tries"));
    await handleUpdate(text("https://vm.tiktok.com/ZMdef/", FRIEND), deps);
    expect(edits.at(-1)?.html).toContain("I couldn't open that video");
    expect(edits.at(-1)?.html).toContain("It didn't use up a video.");
    expect((await store.getWallet(FRIEND)).videos).toBe(2);
  });

  it("keeps a video that was saved even if the reply after it breaks", async () => {
    const { deps, edits, store } = setup({ limits: { videos: 3, questions: 3 } });
    vi.mocked(deps.tg.editMessage).mockRejectedValueOnce(new Error("Telegram editMessageText: couldn't connect after 3 tries"));
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/", FRIEND), deps);
    expect(store.saves).toHaveLength(1);
    expect(edits.at(-1)?.html).toContain("✓ <i>Saved: Split dodge drill</i>");
    expect((await store.getUser(FRIEND)).usage.videos).toBe(1);
  });

  it("gives a question back when the answer breaks", async () => {
    const { deps, sent, brain, store } = setup({ limits: { videos: 3, questions: 3 } });
    vi.mocked(brain.answer).mockRejectedValueOnce(new TypeError("fetch failed"));
    await handleUpdate(text("hi", FRIEND), deps);
    expect(sent.at(-1)?.html).toBe("Something went wrong on my side. Try again in a minute. It didn't use up a question.");
    expect((await store.getUser(FRIEND)).usage.questions).toBe(0);
  });

  it("says it's paused, not broken, when the API is out of credit", async () => {
    const { deps, edits, store, brain, alerts } = setup();
    vi.mocked(brain.watch).mockRejectedValueOnce(new Error("400 Your credit balance is too low to access the Anthropic API"));
    await handleUpdate(text("https://vm.tiktok.com/ZMabc/"), deps);
    expect(edits.at(-1)?.html).toContain("paused");
    expect(alerts[0]).toContain("Out of API credit");
    expect(store.saves).toHaveLength(0);
  });

  it("watches every kind of video sent to it: GIFs, round videos and files of any format", async () => {
    const { deps, media } = setup();
    const send = (message: Record<string, unknown>) => handleUpdate({ message: { message_id: 1, chat: { id: 7 }, from: { id: 7 }, ...message } } as Update, deps);
    await send({ animation: { file_id: "gif", duration: 3 } });
    await send({ video_note: { file_id: "round", duration: 9 } });
    await send({ document: { file_id: "mov", mime_type: "application/octet-stream", file_name: "IMG_0042.MOV" } });
    await send({ document: { file_id: "pdf", mime_type: "application/pdf", file_name: "notes.pdf" } });
    expect(vi.mocked(media.fromTelegramFile).mock.calls.map((c) => c[0])).toEqual(["gif", "round", "mov"]);
  });

  it("stops when the free ones are used up", async () => {
    const { deps, sent, brain, media } = setup({ limits: { videos: 1, questions: 1 } });
    await handleUpdate(text("https://vm.tiktok.com/one/", FRIEND), deps);
    await handleUpdate(text("https://vm.tiktok.com/two/", FRIEND), deps);
    expect(media.fromLink).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)?.html).toContain("You're out of videos");
    await handleUpdate(text("what was that drill?", FRIEND), deps);
    await handleUpdate(text("and the other one?", FRIEND), deps);
    expect(brain.answer).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)?.html).toContain("You're out of questions");
  });

  it("gives the owner no limits", async () => {
    const { deps, sent, brain, media } = setup({ limits: { videos: 1, questions: 1 } });
    for (const t of ["https://vm.tiktok.com/one/", "https://vm.tiktok.com/two/", "q1", "q2"]) await handleUpdate(text(t), deps);
    expect(media.fromLink).toHaveBeenCalledTimes(2);
    expect(brain.answer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(brain.answer).mock.calls[0][0].usage).toContain("no limits");
    await handleUpdate(text("/usage"), deps);
    expect(sent.at(-1)?.html).toContain("You're the owner, so you have no limits.");
  });

  it("counts Fix something and Add what it says as a question", async () => {
    const { deps, sent, brain, store } = setup({ limits: { videos: 5, questions: 1 } });
    await handleUpdate(text("https://vm.tiktok.com/one/", FRIEND), deps);
    const id = store.saves[0]!.id;
    await handleUpdate(tap(`fix:${id}`, 100, FRIEND), deps);
    await handleUpdate(text("it goes on the wall", FRIEND), deps);
    expect(brain.rewrite).toHaveBeenCalledTimes(1);
    await handleUpdate(tap(`fix:${id}`, 100, FRIEND), deps);
    await handleUpdate(text("and the floor", FRIEND), deps);
    expect(brain.rewrite).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)?.html).toContain("You're out of questions");
  });

  it("never refills the free ones, whatever the day", () => {
    const user = { id: FRIEND, facts: [], turns: [], awaitingWordsFor: null, usage: { day: "2000-01-01", videos: 1, questions: 0 }, sitting: null };
    expect(spend(user, "videos", 1)).toBe(false);
    expect(spend(user, "questions", 1)).toBe(true);
    expect(spend(user, "questions", 1)).toBe(false);
    expect(user.usage).toEqual({ day: "2000-01-01", videos: 1, questions: 1 });
    expect(limitText("videos", 5)).toBe("You're out of videos (your 5 free ones are used up), so I didn't save this one.");
    expect(limitText("questions", 10)).toBe("You're out of questions (your 10 free ones are used up).");
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

describe("the start message and guide", () => {
  it("keeps the start short, with the guide one tap away, and /help brings it back", async () => {
    const { deps, sent, edits } = setup();
    expect(WELCOME.length).toBeLessThan(250);
    await handleUpdate(text("/start"), deps);
    expect(sent[0]?.html).toBe(WELCOME);
    // Then every command, so nothing has to be guessed.
    expect(sent[1]?.html).toContain("/folders · ");
    expect(sent[1]?.html).toContain("/commands · ");
    // And the owner's link to share (the owner here is user 7).
    expect(sent[1]?.html).toContain("🎁 <b>Share Knowing:</b> https://t.me/KnowingTestBot?start=join-abc123");
    expect(datas(sent[0]?.buttons)).toEqual(["guide:save", "guide:ask", "guide:folders", "guide:flashback", "guide:limits", "guide:data", "guide:commands"]);
    await handleUpdate(tap("guide:ask", sent[0]!.id), deps);
    expect(edits.at(-1)?.html).toContain("hold the mic");
    expect(datas(edits.at(-1)?.buttons)).toEqual(["guide:"]);
    await handleUpdate(tap("guide:limits", sent[0]!.id), deps);
    expect(edits.at(-1)?.html).toContain("50 free videos and 50 free questions");
    await handleUpdate(tap("guide:", sent[0]!.id), deps);
    expect(edits.at(-1)?.html).toBe(WELCOME);
    await handleUpdate(text("/help"), deps);
    expect(sent.at(-2)?.html).toBe(WELCOME);
    expect(datas(sent.at(-2)?.buttons)).toContain("guide:save");
    expect(sent.at(-1)?.html).toContain("📋 <b>Every command</b>");
  });
});

describe("weekly flashback", () => {
  it("is off until they turn it on, and is offered once at the start", async () => {
    const { deps, sent, edits, store } = setup({ newcomers: true });
    await handleUpdate(text("/start join-abc123", 99), deps);
    const offer = sent.filter((m) => m.chatId === 99).at(-1);
    expect(offer?.html).toContain("weekly flashback");
    expect(datas(offer?.buttons)).toEqual(["digest:on", "digest:no"]);
    expect((await store.getDigest(99)).on).toBe(false);
    await handleUpdate(tap("digest:on", offer!.id, 99), deps);
    expect((await store.getDigest(99)).on).toBe(true);
    expect(edits.at(-1)?.html).toContain("Weekly flashback is on");
    const before = sent.length;
    await handleUpdate(text("/start", 99), deps);
    expect(sent.length).toBe(before + 2); // just the welcome and the commands
    // Everyone else gets their own invite link and what it earns them.
    expect(sent.at(-1)?.html).toContain(`🎁 <b>Invite friends:</b> https://t.me/KnowingTestBot?start=${referralCode("test-key", 99)}`);
    expect(sent.at(-1)?.html).toContain("you get 3 free videos (up to 5 friends)");
  });

  it("asks people who started before it existed once, after their next save", async () => {
    const { deps, sent, edits, store } = setup({ newcomers: true });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    expect(edits.at(-1)?.html).toContain("Saved: Split dodge drill");
    expect(sent.at(-1)?.html).toContain("weekly flashback");
    await handleUpdate(tap("digest:no", sent.at(-1)!.id), deps);
    expect(await store.getDigest(7)).toMatchObject({ on: false, offered: true });
    const before = sent.filter((m) => m.html.includes("weekly flashback")).length;
    await handleUpdate(text("https://vm.tiktok.com/two/"), deps);
    expect(sent.filter((m) => m.html.includes("weekly flashback")).length).toBe(before);
  });

  it("turns on and off with /digest, and shows what this week's would look like", async () => {
    const { deps, sent, store } = setup();
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    await handleUpdate(text("/digest"), deps);
    expect(sent.at(-2)?.html).toContain("is <b>off</b>");
    expect(datas(sent.at(-2)?.buttons)).toEqual(["digest:on"]);
    expect(sent.at(-1)?.html).toContain("Weekly flashback");
    expect(sent.at(-1)?.html).toContain("Split dodge drill");
    await handleUpdate(text("/digest on"), deps);
    expect((await store.getDigest(7)).on).toBe(true);
    await handleUpdate(text("/digest off"), deps);
    expect((await store.getDigest(7)).on).toBe(false);
    expect(sent.at(-1)?.html).toContain("off");
  });

  it("turns off from a flashback's own button without wiping the flashback", async () => {
    const { deps, sent, edits, store } = setup();
    await store.saveDigest(7, { on: true, offered: true, sent: "", quiet: 0 });
    await handleUpdate(tap("digest:stop"), deps);
    expect((await store.getDigest(7)).on).toBe(false);
    expect(edits).toHaveLength(0);
    expect(sent.at(-1)?.html).toContain("Weekly flashback is off");
  });
});

describe("voice questions", () => {
  it("hears a voice message and answers it like a typed one, showing what it heard", async () => {
    const { deps, sent, brain, media } = setup({ limits: { videos: 50, questions: 2 } });
    await handleUpdate(text("https://vm.tiktok.com/one/", FRIEND), deps);
    await handleUpdate(voice(FRIEND, 6), deps);
    expect(media.hearVoice).toHaveBeenCalledWith("V", 6);
    expect(vi.mocked(brain.answer).mock.calls[0]?.[0].question).toBe("what was that drill?");
    expect(sent.at(-1)?.html).toMatch(/^🎙 <i>“what was that drill\?”<\/i>\n\nDo the split dodge\./);
    await handleUpdate(voice(FRIEND), deps);
    vi.mocked(media.hearVoice).mockClear();
    await handleUpdate(voice(FRIEND), deps);
    expect(media.hearVoice).not.toHaveBeenCalled(); // out of questions, so it isn't even heard
    expect(sent.at(-1)?.html).toContain("You're out of questions");
  });

  it("says when it only heard the first minute", async () => {
    const { deps, sent } = setup({ heard: { text: "a long one", cut: true } });
    await handleUpdate(voice(7, 90), deps);
    expect(sent.at(-1)?.html).toContain("only listened to the first minute");
  });

  it("asks for text when it can't hear, and doesn't use a question on silence", async () => {
    const { deps, sent, media, brain, store } = setup({ heard: { text: "", cut: false } });
    await handleUpdate(voice(FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("couldn't make out any words");
    expect((await store.getUser(FRIEND)).usage.questions).toBe(0);
    vi.mocked(media.hearVoice).mockRejectedValueOnce(new NoTranscription());
    await handleUpdate(voice(FRIEND), deps);
    expect(sent.at(-1)?.html).toContain("can't hear voice messages yet");
    expect(brain.answer).not.toHaveBeenCalled();
  });

  it("takes a voice message as the correction after Fix something", async () => {
    const { deps, sent, brain, store } = setup({ heard: { text: "the barrier goes on the wall", cut: false } });
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    await handleUpdate(tap(`fix:${store.saves[0]!.id}`), deps);
    await handleUpdate(voice(), deps);
    expect(vi.mocked(brain.rewrite).mock.calls[0]?.[1]).toBe("the barrier goes on the wall");
    expect(sent.at(-1)?.html).toMatch(/^🎙 .*\n\nFixed\./);
  });
});

describe("folders", () => {
  it("files saves by topic, and opens a folder's videos with their notes a tap away", async () => {
    let n = 0;
    const topics = ["Cooking, Pasta", "Gym, Chest", "cooking, Steak"];
    const { deps, sent, edits, store } = setup({ watch: () => ({ draft: { title: `Video ${++n}`, topic: topics[n - 1]!, type: "tip", summary: "", steps: ["0:42 Add the sauce"], details: "", needsWords: false } }) });
    for (const t of topics) await handleUpdate(text(`https://vm.tiktok.com/${encodeURIComponent(t)}/`), deps);
    await handleUpdate(text("/folders"), deps);
    const list = sent.at(-1)!;
    expect(list.html).toContain("3 videos in 2 folders");
    expect(list.buttons?.flat().map((b) => b.text)).toEqual(["Cooking (2)", "Gym (1)", "📌 Your collections"]);
    await handleUpdate(tap(list.buttons![0]![0]!.callback_data, list.id), deps);
    expect(edits.at(-1)?.html).toContain("📂 <b>Cooking</b> · 2 videos");
    expect(edits.at(-1)?.html).toContain("Video 3");
    const cooking = store.saves.filter((s) => s.topic.toLowerCase().startsWith("cooking"));
    const key = list.buttons![0]![0]!.callback_data.slice(7);
    expect(datas(edits.at(-1)?.buttons)).toEqual([...cooking.map((s) => `show:${s.id}`), `frn:${key}`, `fmg:${key}`, `fdl:${key}`, "folders:"]);
    await handleUpdate(tap("folders:", list.id), deps);
    expect(edits.at(-1)?.html).toContain("Your folders");
    await handleUpdate(text("/tags"), deps);
    expect(sent.at(-1)?.html).toContain("Your folders");
  });

  it("opens the folders as a new message from a flashback", async () => {
    const { deps, sent, edits } = setup();
    await handleUpdate(text("https://vm.tiktok.com/one/"), deps);
    await handleUpdate(tap("folders:new"), deps);
    expect(sent.at(-1)?.html).toContain("Your folders");
    expect(edits.filter((e) => e.html.includes("Your folders"))).toHaveLength(0);
  });
});

describe("organizing folders", () => {
  /** Saves three videos: two Cooking, one Gym. */
  async function saved(opts: Parameters<typeof setup>[0] = {}, from = 7) {
    let n = 0;
    const topics = ["Cooking, Pasta", "Gym, Legs", "Cooking, Steak"];
    const env = setup({ watch: () => ({ draft: { title: `Video ${++n}`, topic: topics[n - 1]!, folder: (topics[n - 1] ?? "").split(",")[0], type: "tip", summary: "", steps: [], details: "", needsWords: false } }), ...opts });
    for (const t of topics) await handleUpdate(text(`https://vm.tiktok.com/${encodeURIComponent(t)}/`, from), env.deps);
    const [pasta, legs, steak] = [...env.store.saves].reverse();
    return { ...env, pasta: pasta!, legs: legs!, steak: steak! };
  }
  const keyOf = (name: string) => folderKey(name);

  it("files a new video in the folder Claude picked, with the spelling they already use, and tells Claude their rules", async () => {
    const { deps, store, brain } = await saved();
    await store.saveFiling(7, [{ folder: "Gym", about: "anything about lifting" }]);
    vi.mocked(brain.watch).mockImplementationOnce(async () => ({ draft: { title: "Deadlift", topic: "Fitness, Back", folder: "gym", type: "tip", summary: "", steps: [], details: "", needsWords: false }, reply: "", relation: "none", relatedId: "" }));
    await handleUpdate(text("https://vm.tiktok.com/dead/"), deps);
    expect(store.saves[0]?.folder).toBe("Gym");
    expect(vi.mocked(brain.watch).mock.calls.at(-1)?.[0].rules).toEqual([{ folder: "Gym", about: "anything about lifting" }]);
  });

  it("moves a video with its 📂 button, and puts the same buttons back with the new folder", async () => {
    const { deps, store, rebuttons, legs, pasta } = await saved();
    await handleUpdate(tap(`mv:${legs.id}:r`), deps);
    const picker = rebuttons.at(-1)!.buttons!.flat();
    expect(picker.map((b) => b.text)).toEqual(["Cooking", "➕ New folder", "« Back"]);
    await handleUpdate(tap(picker[0]!.callback_data), deps);
    expect((await store.getSave(7, legs.id))?.folder).toBe("Cooking");
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", "Moved to Cooking");
    const back = rebuttons.at(-1)!.buttons!.flat();
    expect(back.find((b) => b.callback_data === `mv:${legs.id}:r`)?.text).toBe("📂 Cooking");
    await handleUpdate(tap(`mvback:${pasta.id}:c`), deps);
    expect(datas(rebuttons.at(-1)?.buttons)).toContain(`del:${pasta.id}`);
  });

  it("makes a new folder from a typed name, without using a question", async () => {
    const { deps, store, sent, brain, legs } = await saved({ limits: { videos: 50, questions: 0 } });
    await handleUpdate(tap(`mvnew:${legs.id}`, 100, FRIEND), deps);
    await handleUpdate(tap(`mvnew:${legs.id}`), deps);
    expect(sent.at(-1)?.html).toContain("What should the new folder");
    await handleUpdate(text("Leg day"), deps);
    expect((await store.getSave(7, legs.id))?.folder).toBe("Leg day");
    expect(sent.at(-1)?.html).toBe(`📂 Moved <b>Video 2</b> to <b>Leg day</b>.`);
    expect(datas(sent.at(-1)?.buttons)).toEqual([`folder:${keyOf("Leg day")}:new`]);
    expect(brain.answer).not.toHaveBeenCalled();
    expect((await store.getUser(7)).awaitingWordsFor).toBeNull();
  });

  it("answers a question asked instead of a folder name, and forgets a name asked for too long ago", async () => {
    const { deps, store, brain, legs } = await saved();
    await handleUpdate(tap(`mvnew:${legs.id}`), deps);
    await handleUpdate(text("wait, what was in the pasta one?"), deps);
    expect(brain.answer).toHaveBeenCalledTimes(1);
    expect((await store.getSave(7, legs.id))?.folder).toBe("Gym");
    expect(readNaming(namingFor("move", "abc", 0), 16 * 60_000)).toBeNull();
    expect(readNaming(namingFor("rename", "k1", 0), 60_000)).toEqual({ kind: "rename", target: "k1" });
    expect(folderNameFrom("Japan trip")).toBe("Japan trip");
    expect(folderNameFrom("/folders")).toBe("");
    expect(folderNameFrom("x".repeat(80))).toBe("");
  });

  it("moves, renames and sets rules when asked in chat, which uses a question", async () => {
    const { deps, store, sent, pasta, steak } = await saved({}, FRIEND);
    vi.mocked(deps.brain.answer).mockImplementationOnce(async () => ({
      text: "Done, both are in Dinner ideas now.",
      sources: [],
      about: [],
      remember: [],
      moves: [{ folder: "Dinner ideas", ids: [pasta.id, steak.id] }],
      renames: [{ from: "gym", to: "Workouts" }, { from: "Nope", to: "X" }],
      rules: [{ folder: "dinner IDEAS", about: "anything I could cook tonight" }],
      collects: [],
      uncollects: [],
    }));
    await handleUpdate(text("put my food videos in Dinner ideas, rename gym to Workouts", FRIEND), deps);
    const reply = sent.at(-1)!;
    expect(reply.html).toContain("📂 Moved 2 videos to <b>Dinner ideas</b>.");
    expect(reply.html).toContain("✏️ Renamed <b>Gym</b> to <b>Workouts</b>.");
    expect(reply.html).toContain("I couldn't find a folder called <b>Nope</b>");
    expect(reply.html).toContain("📌 New videos about anything I could cook tonight will go in <b>Dinner ideas</b>.");
    expect(datas(reply.buttons)).toEqual([`folder:${keyOf("Workouts")}:new`]);
    expect((await store.getSave(FRIEND, pasta.id))?.folder).toBe("Dinner ideas");
    expect((await store.getUser(FRIEND)).usage.questions).toBe(1);
    expect(await store.getFiling(FRIEND)).toEqual([{ folder: "Dinner ideas", about: "anything I could cook tonight" }]);
  });

  it("applies chat moves to their own videos and keeps the rules with a renamed folder", async () => {
    const { deps, store, pasta, steak } = await saved();
    await store.saveFiling(7, [{ folder: "Gym", about: "lifting" }]);
    vi.mocked(deps.brain.answer).mockImplementationOnce(async () => ({ text: "Done.", sources: [], about: [], remember: [], moves: [{ folder: "dinner ideas", ids: [pasta.id, steak.id] }], renames: [{ from: "Gym", to: "Workouts" }], rules: [], collects: [], uncollects: [] }));
    await handleUpdate(text("tidy up"), deps);
    expect((await store.getSave(7, steak.id))?.folder).toBe("dinner ideas");
    expect(store.saves.find((s) => s.title === "Video 2")?.folder).toBe("Workouts");
    expect(await store.getFiling(7)).toEqual([{ folder: "Workouts", about: "lifting" }]);
  });

  it("renames, merges and deletes a folder from /folders, and never loses a video", async () => {
    const { deps, store, sent, edits, legs } = await saved();
    await handleUpdate(tap(`frn:${keyOf("Gym")}`), deps);
    expect(sent.at(-1)?.html).toContain("What should <b>Gym</b> be called?");
    await handleUpdate(text("Workouts"), deps);
    expect((await store.getSave(7, legs.id))?.folder).toBe("Workouts");
    expect(sent.at(-1)?.html).toContain("✏️ Renamed <b>Gym</b> to <b>Workouts</b>.");

    await handleUpdate(tap(`fmg:${keyOf("Workouts")}`), deps);
    expect(datas(edits.at(-1)?.buttons)).toEqual([`fmgto:${keyOf("Workouts")}:${keyOf("Cooking")}`, `folder:${keyOf("Workouts")}`]);
    await handleUpdate(tap(`fmgto:${keyOf("Workouts")}:${keyOf("Cooking")}`), deps);
    expect((await store.getSave(7, legs.id))?.folder).toBe("Cooking");
    expect(edits.at(-1)?.html).toContain("📂 <b>Cooking</b> · 3 videos");

    await handleUpdate(tap(`fdl:${keyOf("Cooking")}`), deps);
    expect(edits.at(-1)?.html).toContain("Its 3 videos move to <b>Unsorted</b>");
    await handleUpdate(tap(`fdlok:${keyOf("Cooking")}`), deps);
    expect(store.saves.map((s) => s.folder)).toEqual(["Unsorted", "Unsorted", "Unsorted"]);
    expect(edits.at(-1)?.html).toContain("Your folders");
    await handleUpdate(tap(`fdl:${keyOf("Unsorted")}`), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", expect.stringContaining("so it stays"));
    await handleUpdate(tap(`fmg:${keyOf("Unsorted")}`), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", expect.stringContaining("only folder"));
  });

  it("stops a folder's rule from its page", async () => {
    const { deps, store, edits } = await saved();
    await store.saveFiling(7, [{ folder: "Gym", about: "lifting" }, { folder: "Cooking", about: "food" }]);
    await handleUpdate(tap(`folder:${keyOf("Gym")}`), deps);
    expect(edits.at(-1)?.html).toContain("📌 New videos about lifting come here.");
    await handleUpdate(tap(`frl:${keyOf("Gym")}`), deps);
    expect(await store.getFiling(7)).toEqual([{ folder: "Cooking", about: "food" }]);
    expect(edits.at(-1)?.html).not.toContain("📌");
  });

  it("deletes one video from its card after asking", async () => {
    const { deps, store, edits, rebuttons, retriever, legs } = await saved();
    await handleUpdate(tap(`del:${legs.id}`), deps);
    expect(datas(rebuttons.at(-1)?.buttons)).toEqual([`delok:${legs.id}`, `delno:${legs.id}`]);
    await handleUpdate(tap(`delno:${legs.id}`), deps);
    expect(await store.getSave(7, legs.id)).not.toBeNull();
    const remove = vi.spyOn(retriever, "remove");
    await handleUpdate(tap(`delok:${legs.id}`), deps);
    expect(await store.getSave(7, legs.id)).toBeNull();
    expect(remove).toHaveBeenCalledWith(7, legs.id);
    expect(edits.at(-1)?.html).toBe("🗑 Deleted <b>Video 2</b>.");
  });

  it("moves it with Fix something when they say where it goes", async () => {
    const { deps, store, brain, legs } = await saved();
    vi.mocked(brain.rewrite).mockImplementationOnce(async (s) => ({ ...s, folder: "cooking" }));
    await handleUpdate(tap(`fix:${legs.id}`), deps);
    await handleUpdate(text("it goes in cooking"), deps);
    expect((await store.getSave(7, legs.id))?.folder).toBe("Cooking");
  });

  it("says so and tells the owner when the database isn't set up for moving yet", async () => {
    const { deps, store, alerts, legs } = await saved();
    vi.spyOn(store, "moveSaves").mockRejectedValue(new Error("Supabase PATCH saves: 400 Could not find the 'folder' column"));
    await handleUpdate(tap(`mvto:${legs.id}:${keyOf("Cooking")}:r`), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", "Organizing isn't set up yet. I've told the owner.");
    expect(alerts.at(-1)).toContain("run docs/supabase.sql again");
  });
});

describe("collections", () => {
  /** Saves two videos. */
  async function saved(opts: Parameters<typeof setup>[0] = {}) {
    let n = 0;
    const env = setup({ watch: () => ({ draft: { title: `Video ${++n}`, topic: n === 1 ? "Cooking, Pasta" : "Travel, Japan", type: "tip", summary: "", steps: [], details: "", needsWords: false } }), ...opts });
    await handleUpdate(text("https://vm.tiktok.com/pasta/"), env.deps);
    await handleUpdate(text("https://vm.tiktok.com/ramen/"), env.deps);
    const [pasta, ramen] = [...env.store.saves].reverse();
    return { ...env, pasta: pasta!, ramen: ramen! };
  }
  const key = (name: string) => folderKey(name);

  it("adds a video with 📌 Collect: a new collection from a typed name, then a tap ticks it in or out", async () => {
    const { deps, store, sent, rebuttons, brain, pasta } = await saved({ limits: { videos: 50, questions: 0 } });
    await handleUpdate(tap(`cl:${pasta.id}:r`), deps);
    expect(rebuttons.at(-1)!.buttons!.flat().map((b) => b.text)).toEqual(["➕ New collection", "« Back"]);
    await handleUpdate(tap(`clnew:${pasta.id}`), deps);
    expect(sent.at(-1)?.html).toContain("What should the new collection");
    await handleUpdate(text("Date night"), deps);
    expect(brain.answer).not.toHaveBeenCalled();
    expect(sent.at(-1)?.html).toBe("📌 Added <b>Video 1</b> to <b>Date night</b>.");
    expect(datas(sent.at(-1)?.buttons)).toEqual([`col:${key("Date night")}:new`]);
    expect(await store.getCollections(7)).toEqual([{ name: "Date night", ids: [pasta.id] }]);
    // It stays in its folder.
    expect((await store.getSave(7, pasta.id))?.folder).toBe("Cooking");

    await handleUpdate(tap(`cl:${pasta.id}:c`), deps);
    expect(rebuttons.at(-1)!.buttons![0]![0]).toEqual({ text: "✓ Date night", callback_data: `clt:${pasta.id}:${key("Date night")}:c` });
    await handleUpdate(tap(`clt:${pasta.id}:${key("Date night")}:c`), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", "Taken out of Date night");
    expect(rebuttons.at(-1)!.buttons![0]![0]!.text).toBe("Date night");
    await handleUpdate(tap(`clt:${pasta.id}:${key("Date night")}:c`), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", "Added to Date night");
    // « Back puts the video's own buttons back.
    await handleUpdate(tap(`mvback:${pasta.id}:c`), deps);
    expect(datas(rebuttons.at(-1)?.buttons)).toContain(`cl:${pasta.id}:c`);
  });

  it("lists collections in /collections, opens one, renames it and deletes it without losing videos", async () => {
    const { deps, store, sent, edits, pasta, ramen } = await saved();
    await handleUpdate(text("/collections"), deps);
    expect(sent.at(-1)?.html).toContain("None yet");
    expect(datas(sent.at(-1)?.buttons)).toEqual(["colnew:"]);
    await handleUpdate(tap("colnew:"), deps);
    await handleUpdate(text("Watch later"), deps);
    expect(sent.at(-1)?.html).toContain("Made <b>Watch later</b>");
    await store.saveCollections(7, [{ name: "Watch later", ids: [pasta.id, ramen.id] }]);

    await handleUpdate(text("/collections"), deps);
    expect(sent.at(-1)?.buttons?.[0]?.[0]).toEqual({ text: "Watch later (2)", callback_data: `col:${key("Watch later")}` });
    await handleUpdate(tap(`col:${key("Watch later")}`), deps);
    expect(edits.at(-1)?.html).toContain("📌 <b>Watch later</b> · 2 videos");
    expect(edits.at(-1)?.html).toContain("(📂 Travel,");
    expect(datas(edits.at(-1)?.buttons)).toEqual([`show:${ramen.id}`, `show:${pasta.id}`, `crn:${key("Watch later")}`, `cdl:${key("Watch later")}`, "cols:"]);

    await handleUpdate(tap(`crn:${key("Watch later")}`), deps);
    await handleUpdate(text("Weekend"), deps);
    expect(sent.at(-1)?.html).toContain("Renamed <b>Watch later</b> to <b>Weekend</b>");
    await handleUpdate(tap(`cdl:${key("Weekend")}`), deps);
    expect(edits.at(-1)?.html).toContain("Its videos stay saved");
    await handleUpdate(tap(`cdlok:${key("Weekend")}`), deps);
    expect(await store.getCollections(7)).toEqual([]);
    expect(store.saves).toHaveLength(2);
  });

  it("adds and takes out videos when asked in chat, and tells Claude what's in each", async () => {
    const { deps, store, sent, brain, pasta, ramen } = await saved();
    await store.saveCollections(7, [{ name: "Japan", ids: [pasta.id, ramen.id] }]);
    vi.mocked(brain.answer).mockImplementationOnce(async () => ({ text: "Done.", sources: [], about: [], remember: [], moves: [], renames: [], rules: [], collects: [{ collection: "date NIGHT", ids: [pasta.id] }], uncollects: [{ collection: "japan", ids: [pasta.id] }, { collection: "Nope", ids: [ramen.id] }] }));
    await handleUpdate(text("add the pasta to date night and take it out of japan"), deps);
    expect(vi.mocked(brain.answer).mock.calls.at(-1)?.[0].collections).toEqual([{ name: "Japan", ids: [pasta.id, ramen.id] }]);
    expect(sent.at(-1)?.html).toContain("📌 Added 1 video to <b>date NIGHT</b>.");
    expect(sent.at(-1)?.html).toContain("📌 Took 1 video out of <b>Japan</b>.");
    expect(sent.at(-1)?.html).toContain("I couldn't find a collection called <b>Nope</b>");
    expect(await store.getCollections(7)).toEqual([{ name: "Japan", ids: [ramen.id] }, { name: "date NIGHT", ids: [pasta.id] }]);
    expect(datas(sent.at(-1)?.buttons)).toContain(`col:${key("Japan")}:new`);
  });

  it("says it isn't set up yet, and tells the owner, before the SQL is run", async () => {
    const { deps, store, sent, alerts, pasta } = await saved();
    vi.spyOn(store, "getCollections").mockRejectedValue(new Error("Supabase GET bot_users: 400 column bot_users.collections does not exist"));
    await handleUpdate(text("/collections"), deps);
    expect(sent.at(-1)?.html).toBe("Organizing isn't set up yet. I've told the owner.");
    await handleUpdate(tap(`cl:${pasta.id}:r`), deps);
    expect(deps.tg.answerCallback).toHaveBeenLastCalledWith("cb", "Organizing isn't set up yet. I've told the owner.");
    expect(alerts.at(-1)).toContain("supabase.sql");
    // Answers still work.
    await handleUpdate(text("hi"), deps);
    expect(sent.at(-1)?.html).toContain("Do the split dodge.");
  });
});

describe("what Knowing knows about itself", () => {
  it("explains every command with /commands, and the owner's own only to the owner", async () => {
    const { deps, sent } = setup();
    await handleUpdate(text("/commands", FRIEND), deps);
    const list = sent.at(-1)!.html;
    for (const c of ALL_COMMANDS) expect(list).toContain(`/${c.command} · `);
    expect(list).not.toContain("/refund");
    await handleUpdate(text("/commands"), deps);
    expect(sent.at(-1)!.html).toContain("/refund");
    expect(sent.at(-1)!.html).toContain("Only for you, the owner");
  });

  it("lists every command the bot handles, and puts the main ones in Telegram's menu", () => {
    const handled = ["help", "commands", "folders", "collections", "saved", "digest", "memory", "usage", "buy", "invite", "support", "paysupport", "terms", "delete"];
    expect(ALL_COMMANDS.map((c) => c.command).sort()).toEqual([...handled].sort());
    expect(COMMANDS.map((c) => c.command)).toContain("commands");
  });

  it("tells Claude the real limits and prices, for the owner too", async () => {
    const { deps, brain } = setup();
    await handleUpdate(text("how much are the packs?"), deps);
    const input = vi.mocked(brain.answer).mock.calls[0]![0];
    expect(input.usage).toContain("no limits");
    expect(input.usage).toContain("50 free videos and 50 free questions");
    expect(input.usage).toContain("10 videos for 150 ⭐");
    expect(input.about).toContain("10 videos for 150 ⭐");
    expect(input.about).toContain("/refund");
    await handleUpdate(text("and what can you do?", FRIEND), deps);
    const friend = vi.mocked(brain.answer).mock.calls[1]![0];
    expect(friend.about).toContain("/folders");
    expect(friend.about).not.toContain("/refund");
  });
});
