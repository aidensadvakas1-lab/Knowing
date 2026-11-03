/**
 * What the bot does with each Telegram update. Every outside service comes in
 * through `deps`, so tests can run whole conversations with fakes.
 *
 * - A link (shared from TikTok) or a video: watch it, save it, and react in
 *   a sentence or two (how it connects to their other saves). No coaching.
 * - Any other text, or a voice message: answer from their saves and what they've told us.
 * - Buttons: Show steps, Start now, Add what it says, Fix something, Keep both / Replace,
 *   📂 (move a video to another folder) and Delete.
 * - Folders (folders.ts): every video is in one, picked by Claude the way they'd file it.
 *   /folders opens them, to rename, merge or delete one. Asking in chat moves videos,
 *   renames folders and sets filing rules (it uses a question, like any message to Claude).
 * - /start and /help: a short welcome with a tap-through guide. /commands lists every
 *   command. /folders, /saved, /digest, /memory, /usage, /buy, /delete, and /invite.
 * - Claude is told everything about Knowing (profile.ts aboutKnowing), so questions about
 *   the bot, its commands and its prices get real answers.
 * - The weekly flashback (digest.ts) is off until they turn it on. It's offered once,
 *   at /start or after their next save.
 * - Asking "how many questions do I have left?" gets the same answer as /usage, for free.
 * - An invite link lets people in without editing settings, up to a set number of spots.
 *   Everyone also has their own link (/invite), and earns free videos once a friend who
 *   joined with it saves a video and asks something (referral.ts).
 * - Free videos and questions are given once. Packs of extras can be bought with
 *   Telegram Stars any time (/buy), priced so even their worst case leaves a profit (costs.ts).
 *   /terms, /support and /paysupport, plus /refund and /reply for the owner.
 * - The owner has no limits. An alert goes to the owner when something breaks.
 * - Shares close together make a sitting, wrapped up later in wrapup.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { flashback, OFF_TEXT, OFFER_BUTTONS, OFFER_TEXT, ON_TEXT } from "./digest";
import { addRules, cleanFolderName, dropRules, findFolder, folderKey, folders, matchFolder, renameRules, topicFolder, UNSORTED, type Folder } from "./folders";
import { answerText, buttonsFor, deleteButtons, escapeHtml as esc, folderList, folderView, mergeButtons, moveButtons, reactionButtons, reactionText, saveButtons, saveCard, savedList, stepButtons, stepText, type ButtonsAt } from "./format";
import { isVideoFile, LOGIN_WALLED, platformName } from "./platforms";
import { aboutKnowing, commandsText, GUIDE, guideButtons, WELCOME, type Setup } from "./profile";
import { buyButtons, invoiceFor, packName, PAYSUPPORT_HELP, priceList, readPack, SUPPORT_HELP, TERMS } from "./shop";
import { relevantSaves, sharedVideoTurns } from "./prompts";
import { hasStarted, readReferral, REFERRAL_MAX, REFERRAL_QUESTIONS, REFERRAL_REWARD, REFERRAL_VIDEOS, referralCode } from "./referral";
import { groupHits, searchQuery, type Retriever } from "./rag";
import { FACTS_KEPT, newSaveId, newUser, TURNS_KEPT } from "./store";
import { findUrl } from "./tiktok";
import { NoTranscription, type Answer, type Brain, type BotUser, type ChatMemory, type FilingRule, type InlineButton, type Media, type Pack, type PackKind, type Save, type Store, type TelegramApi, type Usage, type Wallet, type WatchInput } from "./types";

export interface Deps {
  tg: TelegramApi;
  store: Store;
  brain: Brain;
  media: Media;
  /** Finds the saves and passages that answer a question (hybrid vector + word search). */
  retriever: Retriever;
  /** People let in through settings (TELEGRAM_ALLOWED_USERS). They don't use invite spots. */
  isAllowed(userId: number): boolean;
  /** Who gets join notices and may use /invite. 0 if nobody. */
  ownerId: number;
  /**
   * The invite link: whoever opens it can join, until `spots` people have joined
   * that way (with it or with someone's own link). `key` signs everyone's own
   * links; `link(start)` makes a link with that code, the owner's by default.
   */
  invite: { code: string; spots: number; key: string; link(start?: string): Promise<string> };
  /**
   * Public mode: anyone who messages the bot (t.me/<bot>) is let in, no invite
   * needed. `cap` is the most people who can join that way (0 = no limit).
   * Missing means invite-only.
   */
  open?: { cap: number };
  /** Free videos and questions per person, given once (they don't refill), so nobody can run up the API bill. */
  limits: { videos: number; questions: number };
  /** The packs of extras on sale and their prices in Stars (costs.ts pricedPacks). Empty turns buying off. */
  packs: Pack[];
  /** Tells the owner something broke. */
  alert(text: string): Promise<void>;
}

/** The parts of a Telegram update we read. */
export interface Update {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; first_name?: string };
    text?: string;
    caption?: string;
    video?: { file_id: string; duration?: number; file_size?: number };
    /** GIFs and silent clips. Telegram also sends these as a document. */
    animation?: { file_id: string; duration?: number; file_size?: number };
    /** Round video messages. */
    video_note?: { file_id: string; duration?: number; file_size?: number };
    document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
    /** A voice message: a question asked out loud. */
    voice?: { file_id: string; duration?: number; file_size?: number };
    successful_payment?: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string };
  };
  /** Telegram checks with us right before charging Stars. */
  pre_checkout_query?: { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

/**
 * The invite code in the link (t.me/<bot>?start=<code>). Made from the webhook
 * secret, so it needs no setting of its own and can't be guessed. Telegram
 * allows letters, digits, _ and - in it.
 */
export function inviteCode(secret: string, override?: string): string {
  const own = override?.trim() ?? "";
  if (/^[A-Za-z0-9_-]{6,64}$/.test(own)) return own;
  return createHash("sha256").update(`knowing-invite:${secret}`).digest("base64url").slice(0, 12);
}

/** Constant-time compare, for the webhook secret. */
export function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Telegram user ids allowed to use the bot, from a comma-separated env var. */
export function parseAllowed(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

const FAIL = "Something went wrong on my side. Try again in a minute.";
const PAUSED = "I'm paused for a bit while my owner tops up my credit. Try again later.";

/** The API account ran out of credit or quota: nothing the user can fix. */
export function isOutOfCredit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credit balance|insufficient_quota|exceeded your current quota|billing/i.test(message);
}

/** Log it, tell the owner, and return what to tell the user. */
async function failed(error: unknown, where: string, deps: Deps): Promise<string> {
  console.error(`Bot failed while ${where}`, error);
  const broke = isOutOfCredit(error);
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  await deps.alert(`${broke ? "Out of API credit" : "Error"} while ${where}: ${detail}`).catch(() => {});
  return broke ? PAUSED : FAIL;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Count one free use, or return false when their free ones (given once, never refilled) are used up. */
export function spend(user: BotUser, kind: "videos" | "questions", limit: number): boolean {
  if (user.usage[kind] >= limit) return false;
  if (!user.usage.day) user.usage.day = today();
  user.usage[kind] += 1;
  return true;
}

export function limitText(kind: "videos" | "questions", n: number): string {
  const free = n === 1 ? "your free one is" : `your ${n} free ones are`;
  return kind === "videos" ? `You're out of videos (${free} used up), so I didn't save this one.` : `You're out of questions (${free} used up).`;
}

/**
 * What /usage says: free videos and questions left, what they bought, and the
 * packs on sale. Also given to the model, so a question about it in other
 * words gets the same numbers.
 */
export function usageText(usage: Usage, limits: Deps["limits"], wallet: Wallet | null, packs: Pack[]): string {
  const left = (kind: PackKind) => Math.max(0, limits[kind] - usage[kind]);
  const lines = [
    `<b>Free to start</b> (given once, they don't refill):`,
    `Videos: ${left("videos")} of ${limits.videos} left`,
    `Questions: ${left("questions")} of ${limits.questions} left`,
  ];
  if (wallet && (wallet.videos || wallet.questions)) {
    lines.push("", `<b>Extras:</b> ${wallet.videos} video${wallet.videos === 1 ? "" : "s"} and ${wallet.questions} question${wallet.questions === 1 ? "" : "s"}, bought or earned with /invite. They never expire and are used after your free ones.`);
  }
  if (packs.length) {
    lines.push("", `<b>Get more any time</b> with /buy, videos and questions in one pack: ${priceList(packs)}. They never expire.`);
  }
  return lines.join("\n");
}

/** What the model is told about limits when the owner asks: they have none, and what everyone else gets, so the owner can ask about prices too. */
function ownerUsage(deps: Deps): string {
  const packs = deps.packs.length ? `, then can buy packs of videos and questions together with /buy: ${priceList(deps.packs)}` : "; buying more is turned off";
  return `They're the owner of this bot, so they have no limits and never need to buy anything. Everyone else starts with ${deps.limits.videos} free videos and ${deps.limits.questions} free questions, given once${packs}.`;
}

/** What the guide and Claude are told about the bot's settings. */
const setupOf = (deps: Deps): Setup => ({ limits: deps.limits, packs: deps.packs, open: Boolean(deps.open) });

/**
 * "How many questions do I have left?", "what's my limit": answered with
 * /usage straight away, so checking doesn't use up a question. Kept narrow, so
 * a real question ("how many videos have I saved about pasta?") still gets a
 * real answer.
 */
export function asksAboutUsage(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  if (t.length > 100) return false;
  const kind = String.raw`(videos?|questions?|messages?|tiktoks?)`;
  return (
    new RegExp(String.raw`\bhow many (more )?${kind}\b.*\b(left|remaining)\b`).test(t) ||
    new RegExp(String.raw`\bhow many (more )?${kind} (can|do) i (still )?(ask|send|share|save|get|have)\b`).test(t) ||
    new RegExp(String.raw`\bhow many more ${kind}\b`).test(t) ||
    new RegExp(String.raw`\b(any )?${kind} (do i have )?(left|remaining)\b`).test(t) ||
    /^(what'?s|what is|what are|check|show( me)?|see)?\s*(my|the)?\s*(daily )?(limits?|usage|quota)( today)?\s*\??$/.test(t.trim())
  );
}

export async function handleUpdate(update: Update, deps: Deps): Promise<void> {
  if (update.pre_checkout_query) return onPreCheckout(update.pre_checkout_query, deps);
  if (update.callback_query) return onButton(update.callback_query, deps);
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text ?? msg.caption ?? "").trim();

  try {
    if (msg.successful_payment) return await onPaid(chatId, userId, msg.from.first_name, msg.successful_payment, deps);
    if (!(await hasAccess(userId, deps))) {
      const code = text.startsWith("/start ") ? text.slice(7).trim() : "";
      const invited = code !== "" && deps.invite.code !== "" && secretMatches(code, deps.invite.code);
      const inviter = invited || !code ? 0 : await inviterFrom(code, userId, deps);
      if (!deps.open && !invited && !inviter) return void (await deps.tg.sendMessage(chatId, privateText(userId)));
      if (!(await join(chatId, userId, msg.from.first_name, deps, inviter))) return;
    }
    if (text.startsWith("/invite") && userId === deps.ownerId) {
      const used = await spotsUsed(deps);
      if (deps.open) {
        const cap = deps.open.cap ? ` of ${deps.open.cap} spots` : "";
        const joined = cap ? `${used}${cap} used` : `${people(used)} joined`;
        await deps.tg.sendMessage(chatId, `Knowing is <b>public</b>. Anyone can start it with this link:\n${await deps.invite.link("")}\n\n${joined} so far. I'll message you each time someone new starts.`);
        return;
      }
      await deps.tg.sendMessage(chatId, `Your invite link:\n${await deps.invite.link()}\n\n${used} of ${deps.invite.spots} spots used. Anyone who opens the link can join until the spots run out. I'll message you each time someone joins.`);
      return;
    }
    if (text.startsWith("/invite")) return await showReferral(chatId, userId, deps);
    if (userId === deps.ownerId && /^\/(refund|reply)\b/.test(text)) return await ownerCommand(chatId, text, deps);
    if (text.startsWith("/terms")) return void (await deps.tg.sendMessage(chatId, TERMS));
    const support = /^\/(pay)?support\b/.exec(text);
    if (support) return await askOwner(chatId, userId, msg.from.first_name, text.slice(support[0].length).trim(), Boolean(support[1]), deps);
    if (text.startsWith("/commands")) return void (await deps.tg.sendMessage(chatId, commandsText(userId === deps.ownerId)));
    if (text === "/start" || text.startsWith("/start ") || text.startsWith("/help")) {
      await deps.tg.sendMessage(chatId, WELCOME, guideButtons());
      if (text.startsWith("/start")) await offerFlashback(chatId, userId, deps);
      return;
    }
    if (text.startsWith("/folders") || text.startsWith("/tags")) {
      const list = folderList(await deps.store.listSaves(userId, ALL_SAVES));
      return void (await deps.tg.sendMessage(chatId, list.html, list.buttons));
    }
    if (text.startsWith("/digest")) return await digestCommand(chatId, userId, text.slice(7).trim().toLowerCase(), deps);
    const user = await deps.store.getUser(userId);
    if (text.startsWith("/memory")) {
      await deps.tg.sendMessage(chatId, memoryText(user), memoryButtons(user));
      return;
    }
    if (text.startsWith("/saved")) {
      await deps.tg.sendMessage(chatId, savedList(await deps.store.listSaves(userId)));
      return;
    }
    if (text.startsWith("/usage") || text.startsWith("/limits")) return await showUsage(chatId, user, deps);
    if (text.startsWith("/buy")) return await showShop(chatId, deps);
    if (text.startsWith("/delete")) {
      const count = (await deps.store.listSaves(userId)).length;
      await deps.tg.sendMessage(chatId, `This deletes your ${count} save${count === 1 ? "" : "s"}, our chats and everything I remember about you. It can't be undone.`, [
        [{ text: "Delete everything", callback_data: "wipe:yes" }],
        [{ text: "Cancel", callback_data: "wipe:no" }],
      ]);
      return;
    }

    // Any kind of video: a normal one, a GIF, a round video message, or a file of any video format.
    const video = msg.video ?? msg.animation ?? msg.video_note ?? (isVideoFile(msg.document) ? msg.document : undefined);
    if (video) {
      if ((video.file_size ?? 0) > 20 * 1024 * 1024) {
        await deps.tg.sendMessage(chatId, "That video is over 20 MB, which is Telegram's limit for bots. Share the TikTok link instead.");
        return;
      }
      if (!(await allow(user, "videos", deps))) return await limitReached(chatId, "videos", deps);
      const duration = "duration" in video && typeof video.duration === "number" ? video.duration : 0;
      return await watchAndSave(chatId, user, () => deps.media.fromTelegramFile(video.file_id, duration), "", text, deps);
    }

    if (msg.voice) return await voiceMessage(chatId, user, msg.voice, deps, msg.from.first_name);

    const url = findUrl(text);
    // Links from apps that won't let the bot in only get told how to send the video, so they don't use one up.
    const walled = Boolean(url && LOGIN_WALLED.has(platformName(url)));
    if (url && !walled && !(await allow(user, "videos", deps))) return await limitReached(chatId, "videos", deps);
    if (url) return await watchAndSave(chatId, user, () => deps.media.fromLink(url), url, text.replace(url, "").trim(), deps);

    if (!text) return;
    await onText(chatId, user, text, deps, msg.from.first_name);
  } catch (error) {
    await deps.tg.sendMessage(chatId, await failed(error, "handling a message", deps)).catch(() => {});
  }
}

/** Enough to list every save in /folders and the flashback. */
const ALL_SAVES = 1_000;

/** A typed message, or a voice message's words: a question, or the words Fix / Add what it says asked for. `heard` shows what a voice message said. */
async function onText(chatId: number, user: BotUser, text: string, deps: Deps, name?: string, heard = "") {
  // A name for a new folder, or a folder's new name: no Claude call, so no question used.
  const naming = readNaming(user.awaitingWordsFor);
  if (naming || user.awaitingWordsFor?.startsWith("name:")) {
    user.awaitingWordsFor = null;
    await deps.store.saveUser(user);
    const folder = folderNameFrom(text);
    if (naming && folder) return await nameFolder(chatId, user.id, naming, folder, deps, heard);
    // Too late, or not a name (a question, a long message): answered like any other message below.
  }
  // Remaking a save is a Claude call like an answer, so it uses a question.
  if (user.awaitingWordsFor) {
    if (!(await allow(user, "questions", deps))) return await limitReached(chatId, "questions", deps);
    return await addWords(chatId, user, text, deps, heard);
  }
  // Before the limit check: checking what's left shouldn't use a question, and works when none are left.
  if (asksAboutUsage(text)) return await showUsage(chatId, user, deps);
  if (!(await allow(user, "questions", deps))) return await limitReached(chatId, "questions", deps);
  await answer(chatId, user, text, deps, name, heard);
}

/**
 * A voice message: hear it (the first minute only, costs.ts VOICE_MAX_SECONDS),
 * then treat the words like a typed message. It uses a question like one. The
 * reply starts with what was heard, so a mishearing is easy to spot.
 */
async function voiceMessage(chatId: number, user: BotUser, voice: NonNullable<NonNullable<Update["message"]>["voice"]>, deps: Deps, name?: string) {
  // Checked first, so nobody out of questions costs a transcription.
  if (!(await hasLeft(user, "questions", deps))) return await limitReached(chatId, "questions", deps);
  await deps.tg.typing(chatId);
  let heard: { text: string; cut: boolean };
  try {
    heard = await deps.media.hearVoice(voice.file_id, voice.duration ?? 0);
  } catch (error) {
    if (error instanceof NoTranscription) return void (await deps.tg.sendMessage(chatId, "I can't hear voice messages yet, so type it for now."));
    throw error;
  }
  if (!heard.text) return void (await deps.tg.sendMessage(chatId, "I couldn't make out any words in that one. Try again, or type it."));
  const quote = heard.text.length > 300 ? `${heard.text.slice(0, 300)}…` : heard.text;
  const echo = `🎙 <i>“${esc(quote)}”</i>${heard.cut ? "\n<i>(I only listened to the first minute.)</i>" : ""}`;
  await onText(chatId, user, heard.text, deps, name, echo);
}

/** Whether they have one of these left, without using it. */
async function hasLeft(user: BotUser, kind: PackKind, deps: Deps): Promise<boolean> {
  if (user.id === deps.ownerId || user.usage[kind] < deps.limits[kind]) return true;
  const wallet = await walletOf(user.id, deps);
  return Boolean(wallet && wallet[kind] > 0);
}

/** Ask once, at /start or after their next save, whether they want the weekly flashback. Never gets in the way. */
async function offerFlashback(chatId: number, userId: number, deps: Deps): Promise<void> {
  try {
    const digest = await deps.store.getDigest(userId);
    if (digest.offered || digest.on) return;
    // Marked first, so if this can't be saved they aren't asked again and again.
    await deps.store.saveDigest(userId, { ...digest, offered: true });
    await deps.tg.sendMessage(chatId, OFFER_TEXT, OFFER_BUTTONS);
  } catch (error) {
    console.error("Offering the weekly flashback failed", error);
  }
}

/** /digest shows the setting and a preview; /digest on and /digest off change it. */
async function digestCommand(chatId: number, userId: number, arg: string, deps: Deps): Promise<void> {
  let digest;
  try {
    digest = await deps.store.getDigest(userId);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    await deps.alert(`Weekly flashback settings couldn't be read. If you haven't, run docs/supabase.sql again in Supabase. ${detail}`).catch(() => {});
    return void (await deps.tg.sendMessage(chatId, "Weekly flashbacks aren't set up yet. I've told the owner."));
  }
  if (arg === "on" || arg === "off") {
    await deps.store.saveDigest(userId, { ...digest, on: arg === "on", offered: true, quiet: 0 });
    return void (await deps.tg.sendMessage(chatId, arg === "on" ? ON_TEXT : OFF_TEXT));
  }
  const status = digest.on
    ? "Your weekly flashback is <b>on</b>. It comes Sunday evenings (around 17:00 UTC)."
    : "Your weekly flashback is <b>off</b>. Turn it on and every Sunday I'll send what you saved that week, or a few older videos worth another look.";
  await deps.tg.sendMessage(chatId, status, [[digest.on ? { text: "Turn it off", callback_data: "digest:off" } : { text: "Turn it on", callback_data: "digest:on" }]]);
  const preview = flashback(await deps.store.listSaves(userId, ALL_SAVES));
  if (preview) await deps.tg.sendMessage(chatId, `<i>Here's what it would look like this week:</i>\n\n${preview.html}`, preview.buttons);
}

/** Count one use: their free ones first, then what they bought. False when both are used up. The owner has no limit. */
async function allow(user: BotUser, kind: PackKind, deps: Deps): Promise<boolean> {
  if (user.id === deps.ownerId) return true;
  if (spend(user, kind, deps.limits[kind])) return true;
  const wallet = await deps.store.getWallet(user.id).catch((error) => void console.error("Reading the wallet failed", error));
  if (!wallet || wallet[kind] < 1) return false;
  await deps.store.saveWallet(user.id, { ...wallet, [kind]: wallet[kind] - 1 });
  return true;
}

/** Their wallet, or null if it can't be read (then /usage just leaves extras out). */
const walletOf = (userId: number, deps: Deps) => deps.store.getWallet(userId).catch((error) => (console.error("Reading the wallet failed", error), null));

async function showUsage(chatId: number, user: BotUser, deps: Deps): Promise<void> {
  if (user.id === deps.ownerId) {
    return void (await deps.tg.sendMessage(chatId, `You're the owner, so you have no limits. Everyone else starts with ${deps.limits.videos} free videos and ${deps.limits.questions} free questions, given once.`));
  }
  const buttons = deps.packs.length ? buyButtons(deps.packs) : undefined;
  await deps.tg.sendMessage(chatId, usageText(user.usage, deps.limits, await walletOf(user.id, deps), deps.packs), buttons);
}

/** /buy: every pack, any time, even before the free ones run out. */
async function showShop(chatId: number, deps: Deps): Promise<void> {
  if (!deps.packs.length) return void (await deps.tg.sendMessage(chatId, "Buying extras is turned off right now."));
  await deps.tg.sendMessage(chatId, "Pick a pack. Each one has videos and questions together. Extras never expire and are used after your free ones run out.", buyButtons(deps.packs));
}

/** Out of free and bought ones: offer the packs. */
async function limitReached(chatId: number, kind: PackKind, deps: Deps): Promise<void> {
  const text = limitText(kind, deps.limits[kind]);
  if (!deps.packs.length) return void (await deps.tg.sendMessage(chatId, text));
  await deps.tg.sendMessage(chatId, `${text}\n\nGet more to keep going. Each pack has videos and questions, and they never expire.`, buyButtons(deps.packs));
}

/** Telegram asks right before charging. Say no (and they aren't charged) unless we can record what they bought. */
async function onPreCheckout(p: NonNullable<Update["pre_checkout_query"]>, deps: Deps): Promise<void> {
  let error = "";
  try {
    const pack = readPack(p.invoice_payload);
    const onSale = pack && deps.packs.some((x) => x.videos === pack.videos && x.questions === pack.questions && x.stars === pack.stars);
    if (!pack || !onSale || p.currency !== "XTR" || p.total_amount !== pack.stars) {
      error = "That price has changed. Tap the button again for the current one. You weren't charged.";
    } else if (!(await hasAccess(p.from.id, deps))) {
      error = deps.open ? "Send /start first, then try again. You weren't charged." : "Knowing is invite-only for now. You weren't charged.";
    } else {
      await deps.store.getWallet(p.from.id); // fails if the wallet column is missing
    }
  } catch (e) {
    error = "Payments aren't working right now, so you weren't charged. Try again later.";
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await deps.alert(`A payment was stopped because I couldn't read the wallet. If you haven't, run docs/supabase.sql again in Supabase. ${detail}`).catch(() => {});
  }
  await deps.tg.answerPreCheckout(p.id, !error, error || undefined);
}

/** Stars received: add the pack. Telegram can send the same payment twice, so each one counts once. */
async function onPaid(chatId: number, userId: number, name: string | undefined, pay: NonNullable<NonNullable<Update["message"]>["successful_payment"]>, deps: Deps): Promise<void> {
  const who = name ? esc(name) : "Someone";
  const refund = `<code>/refund ${userId} ${esc(pay.telegram_payment_charge_id)}</code>`;
  try {
    const pack = readPack(pay.invoice_payload);
    if (!pack) throw new Error(`unknown payload "${pay.invoice_payload}"`);
    const wallet = await deps.store.getWallet(userId);
    if (wallet.paid.some((p) => p.charge === pay.telegram_payment_charge_id)) return;
    wallet.videos += pack.videos;
    wallet.questions += pack.questions;
    wallet.paid = [...wallet.paid, { charge: pay.telegram_payment_charge_id, videos: pack.videos, questions: pack.questions, stars: pay.total_amount, at: new Date().toISOString() }];
    await deps.store.saveWallet(userId, wallet);
    await deps.tg.sendMessage(chatId, `Thanks! ${packName(pack)} added, so you have ${packName(wallet) || "nothing"} extra. They never expire and are used after your free ones. Any problem with a payment, send /paysupport.`);
    await tellOwner(deps, `${who} paid ${pay.total_amount} ⭐ for ${packName(pack)}. To refund it: ${refund}`);
  } catch (error) {
    console.error("Recording a payment failed", error);
    await deps.tg.sendMessage(chatId, "Your payment went through, but I couldn't add it to your account. I've told the owner, who will fix it or refund you.");
    await tellOwner(deps, `${who} paid ${pay.total_amount} ⭐, but I couldn't add it to their account (${esc(String(error).slice(0, 200))}). Refund it with ${refund}`);
  }
}

/** The owner's /refund <user id> <payment id> and /reply <user id> <message>. */
async function ownerCommand(chatId: number, text: string, deps: Deps): Promise<void> {
  const refund = /^\/refund\s+(\d+)\s+(\S+)/.exec(text);
  if (refund) return refundPayment(chatId, Number(refund[1]), refund[2], deps);
  const reply = /^\/reply\s+(\d+)\s+([\s\S]+)/.exec(text);
  if (reply) {
    await deps.tg.sendMessage(Number(reply[1]), `<b>From the owner:</b> ${esc(reply[2].trim())}`);
    return void (await deps.tg.sendMessage(chatId, "Sent."));
  }
  await deps.tg.sendMessage(chatId, "Use <code>/refund user_id payment_id</code> (it's in each payment message) or <code>/reply user_id your message</code>.");
}

async function refundPayment(chatId: number, userId: number, charge: string, deps: Deps): Promise<void> {
  try {
    await deps.tg.refundStars(userId, charge);
  } catch (error) {
    return void (await deps.tg.sendMessage(chatId, `Telegram didn't refund it: ${esc(error instanceof Error ? error.message : String(error))}`));
  }
  const wallet = await deps.store.getWallet(userId);
  const payment = wallet.paid.find((p) => p.charge === charge);
  if (payment) {
    wallet.videos = Math.max(0, wallet.videos - payment.videos);
    wallet.questions = Math.max(0, wallet.questions - payment.questions);
    wallet.paid = wallet.paid.filter((p) => p !== payment);
    await deps.store.saveWallet(userId, wallet);
  }
  await deps.tg.sendMessage(userId, `Your payment${payment ? ` of ${payment.stars} ⭐` : ""} was refunded.`).catch(() => {});
  await deps.tg.sendMessage(chatId, payment ? `Refunded, and I took the ${packName(payment)} back off their account (never below 0).` : "Refunded.");
}

/** /support and /paysupport: pass the message to the owner, with refund commands for payment problems. */
async function askOwner(chatId: number, userId: number, name: string | undefined, body: string, payments: boolean, deps: Deps): Promise<void> {
  if (!body) return void (await deps.tg.sendMessage(chatId, payments ? PAYSUPPORT_HELP : SUPPORT_HELP));
  let recent = "";
  if (payments) {
    const paid = (await deps.store.getWallet(userId).catch(() => null))?.paid.slice(-3) ?? [];
    recent = paid.length
      ? `\n\nTheir latest payments:\n${paid.map((p) => `${p.stars} ⭐ for ${packName(p)}: <code>/refund ${userId} ${esc(p.charge)}</code>`).join("\n")}`
      : "\n\nNo payments on record.";
  }
  await tellOwner(deps, `<b>${payments ? "Payment problem" : "Support"}</b> from ${name ? esc(name) : "someone"}:\n${esc(body)}${recent}\n\nReply with <code>/reply ${userId} your message</code>`);
  await deps.tg.sendMessage(chatId, "Sent to the owner. You'll get an answer here.");
}

/** For strangers. The id is how the owner lets themselves in on a fresh setup (docs/TELEGRAM.md, step 6). */
const privateText = (id: number) => `Knowing is invite-only for now. Ask the person who told you about it for an invite link.\n\nYour Telegram id: <code>${id}</code>`;
const FULL = "Knowing is full right now, so I can't let you in yet. I've let the owner know.";

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** Let in through settings, or already joined (with an invite link, or in public mode). */
async function hasAccess(userId: number, deps: Deps): Promise<boolean> {
  return deps.isAllowed(userId) || (await deps.store.hasUser(userId));
}

/** People who joined with the invite link (everyone with a row who isn't let in through settings). */
async function spotsUsed(deps: Deps): Promise<number> {
  return (await deps.store.listUserIds()).filter((id) => !deps.isAllowed(id)).length;
}

/** Tells the owner something that needs no reply. Never stops the user's own message. */
async function tellOwner(deps: Deps, html: string): Promise<void> {
  if (deps.ownerId) await deps.tg.sendMessage(deps.ownerId, html).catch((error) => console.error("Owner notice failed", error));
}

/**
 * Someone opened the invite link, or a friend's own link (`inviter`): let them
 * in if a spot is free. Tells the owner either way, and the friend who invited them.
 */
async function join(chatId: number, userId: number, name: string | undefined, deps: Deps, inviter = 0): Promise<boolean> {
  const used = await spotsUsed(deps);
  const who = name ? esc(name) : "Someone";
  const whose = inviter ? "a friend's invite link" : deps.open ? "the public link" : "your invite link";
  // Public mode only stops at its own cap, if there is one; invite-only stops at the invite spots.
  const spots = deps.open ? deps.open.cap : deps.invite.spots;
  if (spots && used >= spots) {
    await deps.tg.sendMessage(chatId, FULL);
    await tellOwner(deps, `${who} tried to join with ${whose}, but all ${spots} spots are taken. To make room, raise ${deps.open ? "KNOWING_PUBLIC_SPOTS" : "KNOWING_INVITE_SPOTS"} in Vercel.`);
    return false;
  }
  await deps.store.saveUser(newUser(userId));
  if (inviter) {
    try {
      await deps.store.saveReferral(userId, { by: inviter, name: (name ?? "").slice(0, 64), credited: false, rewarded: 0 });
      await deps.tg.sendMessage(inviter, `${who} joined Knowing with your link. Once they save a video and ask me something, you get ${REFERRAL_REWARD} free videos.`).catch(() => {});
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      await deps.alert(`Couldn't record who invited a new user. If you haven't, run docs/supabase.sql again in Supabase. ${detail}`).catch(() => {});
    }
  }
  const count = spots ? `${used + 1} of ${spots} spots used.` : `${people(used + 1)} so far.`;
  await tellOwner(deps, `${who} joined Knowing with ${whose}${inviter ? ` (<code>${inviter}</code>)` : ""}. ${count}`);
  return true;
}

function memoryText(user: BotUser): string {
  const chats = "I also keep our chats, so I can look back at them later. /delete wipes everything.";
  if (!user.facts.length) return `Nothing yet. When you mention something lasting, like your rank or your position, I'll remember it.\n\n${chats}`;
  return ["What I remember about you:", ...user.facts.map((f, i) => `${i + 1}. ${esc(f)}`), "", chats].join("\n");
}

function memoryButtons(user: BotUser) {
  return user.facts.slice(0, 20).map((f, i) => [{ text: `Forget ${i + 1}: ${f.slice(0, 30)}`, callback_data: `forget:${i}` }]);
}

async function watchAndSave(chatId: number, user: BotUser, get: () => Promise<WatchInput>, sourceUrl: string, note: string, deps: Deps) {
  const status = await deps.tg.sendMessage(chatId, "Watching…");
  let input: WatchInput;
  try {
    input = await get();
  } catch (error) {
    await failed(error, `opening ${sourceUrl || "a sent video"}`, deps);
    await deps.tg.editMessage(chatId, status, "I couldn't open that video. Try sending it again, or send the video file itself.");
    return;
  }
  if (!input.frames.length && !input.transcript && !input.caption) {
    await deps.tg.editMessage(chatId, status, ["I couldn't get anything out of that one.", ...input.notes].join("\n"));
    return;
  }
  try {
    await saveWatched(chatId, status, user, input, sourceUrl, note, deps);
  } catch (error) {
    await deps.tg.editMessage(chatId, status, await failed(error, "watching a video", deps)).catch(() => {});
  }
}

async function saveWatched(chatId: number, status: number, user: BotUser, input: WatchInput, sourceUrl: string, note: string, deps: Deps) {
  const saves = await deps.store.listSaves(user.id);
  const rules = await rulesOf(user.id, deps);
  const watched = await deps.brain.watch({ ...input, note, facts: user.facts, saves, rules });
  const save: Save = {
    ...watched.draft,
    // "gym" goes in the Gym folder they already have.
    folder: matchFolder(watched.draft.folder || topicFolder(watched.draft.topic), saves),
    needsWords: watched.draft.needsWords && !input.transcript,
    id: newSaveId(),
    userId: user.id,
    sourceUrl,
    words: "",
    source: [input.caption && `Caption: ${input.caption}`, input.screenText && `On screen: ${input.screenText}`, input.transcript && `Transcript: ${input.transcript}`].filter(Boolean).join("\n").slice(0, 20_000),
    practiced: 0,
    createdAt: new Date().toISOString(),
  };
  // In the chat history too, so a follow-up like "how fast is it?" knows which video "it" is.
  user.turns = [...user.turns, ...sharedVideoTurns(save, watched.reply, note)].slice(-TURNS_KEPT);
  await deps.store.saveUser(user); // saves belong to a user row, so make sure it exists
  await deps.store.addSave(save);
  // For the wrap-up. If this fails, only the wrap-up is lost, so the save still goes through.
  await deps.store.touchSitting(user.id, save.createdAt).catch((error) => console.error("Sitting update failed", error));
  await reindex(save, deps);
  const decide = watched.relation === "alternative" || watched.relation === "duplicate" ? saves.find((s) => s.id === watched.relatedId) : null;
  await deps.tg.editMessage(chatId, status, reactionText(watched.reply, save, input.notes), reactionButtons(save, decide, watched.relation === "alternative" ? "alternative" : "duplicate"));
  // People who started before the flashback existed are asked once, here.
  await offerFlashback(chatId, user.id, deps);
  await rewardInviter(user, "videos", deps);
}

/** The message after Add what it says or Fix something: remake that save with it. */
async function addWords(chatId: number, user: BotUser, text: string, deps: Deps, heard = "") {
  const pending = user.awaitingWordsFor ?? "";
  const fixing = pending.startsWith("fix:");
  user.awaitingWordsFor = null;
  await deps.store.saveUser(user);
  const save = await deps.store.getSave(user.id, fixing ? pending.slice(4) : pending);
  if (!save) return answer(chatId, user, text, deps, "", heard);
  await deps.tg.typing(chatId);
  const draft = await deps.brain.rewrite(save, text, fixing ? "fix" : "words");
  // A fix can move it ("it goes in Car mods"); the video's own words never do.
  const saves = fixing ? await deps.store.listSaves(user.id) : [];
  const folder = fixing && draft.folder ? matchFolder(draft.folder, saves) : (save.folder ?? "");
  const updated: Save = fixing
    ? { ...save, ...draft, folder, needsWords: save.needsWords && !save.words }
    : { ...save, ...draft, folder, words: text.slice(0, 8_000), needsWords: false };
  await deps.store.updateSave(updated);
  await reindex(updated, deps);
  await deps.tg.sendMessage(chatId, `${heard ? `${heard}\n\n` : ""}${fixing ? "Fixed." : "Updated with what it says."}\n\n${saveCard(updated)}`, saveButtons(updated));
}

async function answer(chatId: number, user: BotUser, question: string, deps: Deps, name = "", heard = "") {
  await deps.tg.typing(chatId);
  const saves = await deps.store.listSaves(user.id);
  const [retrieved, memories, wallet, rules] = await Promise.all([retrieve(user, question, saves, deps), recall(user, question, deps), walletOf(user.id, deps), rulesOf(user.id, deps)]);
  const owner = user.id === deps.ownerId;
  const usage = owner ? ownerUsage(deps) : usageText(user.usage, deps.limits, wallet, deps.packs).replace(/<\/?b>/g, "");
  const about = aboutKnowing(setupOf(deps), owner);
  const reply = await deps.brain.answer({ user, question: question.slice(0, 4_000), saves, retrieved, name, memories, usage, rules, about });
  const find = (ids: string[]) => ids.map((id) => saves.find((s) => s.id === id)).filter((s): s is Save => Boolean(s));
  const used = find(reply.sources);

  const fresh = reply.remember.filter((f) => !user.facts.includes(f));
  user.facts = [...user.facts, ...fresh].slice(-FACTS_KEPT);
  user.turns = [...user.turns, { role: "user" as const, content: question }, { role: "assistant" as const, content: reply.text }].slice(-TURNS_KEPT);
  await deps.store.saveUser(user);

  const buttons: InlineButton[][] = [];
  const runnable = used.find((s) => (s.type === "drill" || s.type === "plan") && s.steps.length);
  if (runnable) buttons.push([{ text: `Start: ${runnable.title.slice(0, 40)}`, callback_data: `open:${runnable.id}` }]);
  const organized = await organize(user.id, reply, saves, rules, deps);
  if (organized.open) buttons.push([{ text: `📂 Open ${organized.open.slice(0, 30)}`, callback_data: `folder:${folderKey(organized.open)}:new` }]);
  const receipt = organized.lines.length ? `\n\n${organized.lines.join("\n")}` : "";
  await deps.tg.sendMessage(chatId, `${heard ? `${heard}\n\n` : ""}${answerText(reply.text, used, find(reply.about))}${receipt}`, buttons);
  // Every chat is kept and searchable, so something said weeks ago can still come back.
  const memory: ChatMemory = { said: question.slice(0, 4_000), answered: reply.text.slice(0, 4_000), at: new Date().toISOString() };
  await deps.retriever.remember(user.id, memory).catch((error) => console.error("Remembering the chat failed", error));
  await rewardInviter(user, "questions", deps);
}

/** Whose own invite link this code is, if it's real and they're still in. 0 otherwise. */
async function inviterFrom(code: string, userId: number, deps: Deps): Promise<number> {
  const id = readReferral(deps.invite.key, code);
  return id && id !== userId && (await hasAccess(id, deps)) ? id : 0;
}

/** /invite for everyone but the owner: their own link, and what it earns them. */
async function showReferral(chatId: number, userId: number, deps: Deps): Promise<void> {
  const link = await deps.invite.link(referralCode(deps.invite.key, userId));
  const earned = (await deps.store.getReferral(userId).catch(() => null))?.rewarded ?? 0;
  const how = `When a friend joins with it, saves a video and asks me something, you get ${REFERRAL_REWARD} free videos`;
  const text =
    earned >= REFERRAL_MAX
      ? `Your invite link:\n${link}\n\nYou've earned free videos for ${REFERRAL_MAX} friends, the most there is. Friends can still join with it.`
      : `Your invite link:\n${link}\n\n${how}. That works for up to ${REFERRAL_MAX} friends${earned ? ` (${earned} so far)` : ""}.${deps.open ? "" : " Spots are limited while Knowing is invite-only."}`;
  await deps.tg.sendMessage(chatId, text);
}

/**
 * Once someone who joined with a friend's link has saved a video and asked
 * something, give that friend their free videos (once, for up to REFERRAL_MAX
 * friends). Checked only on their first few saves and first few questions, so
 * it costs a database read for a handful of messages, not every one, and still
 * works for someone who saves ten videos before asking anything.
 */
async function rewardInviter(user: BotUser, kind: PackKind, deps: Deps): Promise<void> {
  const needed = kind === "videos" ? REFERRAL_VIDEOS : REFERRAL_QUESTIONS;
  if (!hasStarted(user.usage) || user.usage[kind] > needed + 2) return;
  try {
    const mine = await deps.store.getReferral(user.id);
    if (!mine.by || mine.credited) return;
    // Marked first, so a friend is counted once even if two messages land at the same time.
    await deps.store.saveReferral(user.id, { ...mine, credited: true });
    const theirs = await deps.store.getReferral(mine.by);
    if (theirs.rewarded >= REFERRAL_MAX) return;
    await deps.store.saveReferral(mine.by, { ...theirs, rewarded: theirs.rewarded + 1 });
    const wallet = await deps.store.getWallet(mine.by);
    await deps.store.saveWallet(mine.by, { ...wallet, videos: wallet.videos + REFERRAL_REWARD });
    const who = mine.name ? esc(mine.name) : "A friend you invited";
    const left = REFERRAL_MAX - theirs.rewarded - 1;
    await deps.tg
      .sendMessage(mine.by, `🎉 ${who} is using Knowing now, thanks to you, so you got <b>${REFERRAL_REWARD} free videos</b>. They never expire.${left ? ` You can earn this for ${left} more friend${left === 1 ? "" : "s"}.` : ""}`)
      .catch(() => {});
  } catch (error) {
    console.error("Rewarding an invite failed", error);
  }
}

async function onButton(q: NonNullable<Update["callback_query"]>, deps: Deps) {
  const chatId = q.message?.chat.id;
  const messageId = q.message?.message_id;
  const data = q.data ?? "";
  if (!chatId || !messageId) return deps.tg.answerCallback(q.id);
  try {
    if (!(await hasAccess(q.from.id, deps))) return await deps.tg.answerCallback(q.id, deps.open ? "Send /start first." : "Knowing is invite-only for now.");
    const [kind, id = "", n = "0"] = data.split(":");
    if (kind === "guide") {
      await deps.tg.answerCallback(q.id);
      const page = GUIDE.find((g) => g.id === id);
      await deps.tg.editMessage(chatId, messageId, page ? page.text(setupOf(deps)) : WELCOME, page ? [[{ text: "« Back", callback_data: "guide:" }]] : guideButtons());
      return;
    }
    if (kind === "folders" || kind === "folder") {
      await deps.tg.answerCallback(q.id);
      const saves = await deps.store.listSaves(q.from.id, ALL_SAVES);
      const view = kind === "folder" ? folderView(saves, id, await rulesOf(q.from.id, deps)) : null;
      // A folder that's gone (its videos were moved or deleted) shows the list instead.
      const page = view ?? folderList(saves);
      // From a flashback or an answer, open it as a new message so that one stays.
      if ((kind === "folders" && id === "new") || n === "new") await deps.tg.sendMessage(chatId, page.html, page.buttons);
      else await deps.tg.editMessage(chatId, messageId, page.html, page.buttons);
      return;
    }
    if (FOLDER_BUTTONS.has(kind)) return await onFolderButton(q.id, chatId, messageId, q.from.id, kind, id, n, deps);
    if (MOVE_BUTTONS.has(kind)) return await onMoveButton(q.id, chatId, messageId, q.from.id, data, deps);
    if (kind === "digest") {
      const digest = await deps.store.getDigest(q.from.id);
      const on = id === "on";
      await deps.store.saveDigest(q.from.id, { ...digest, on, offered: true, quiet: on ? 0 : digest.quiet });
      await deps.tg.answerCallback(q.id, on ? "Turned on" : id === "no" ? undefined : "Turned off");
      // From a flashback: keep it, and confirm in a new message.
      if (id === "stop") return void (await deps.tg.sendMessage(chatId, OFF_TEXT));
      await deps.tg.editMessage(chatId, messageId, on ? ON_TEXT : id === "no" ? "No problem. /digest turns it on any time." : OFF_TEXT);
      return;
    }
    if (kind === "wipe") {
      if (id === "yes") {
        const { usage } = await deps.store.getUser(q.from.id);
        const wallet = await deps.store.getWallet(q.from.id).catch(() => null);
        const referral = await deps.store.getReferral(q.from.id).catch(() => null);
        await deps.store.deleteUser(q.from.id);
        // An empty row keeps their spot, what they've used, what they bought and their invite rewards,
        // so deleting doesn't lock them out or hand out new free ones.
        await deps.store.saveUser({ ...newUser(q.from.id), usage });
        if (wallet && (wallet.videos || wallet.questions || wallet.paid.length)) await deps.store.saveWallet(q.from.id, wallet);
        if (referral && (referral.by || referral.rewarded)) await deps.store.saveReferral(q.from.id, referral);
      }
      await deps.tg.answerCallback(q.id, id === "yes" ? "Deleted" : undefined);
      await deps.tg.editMessage(chatId, messageId, id === "yes" ? "Deleted. Everything you saved, our chats and everything I remembered about you are gone." : "Cancelled. Nothing was deleted.");
      return;
    }
    if (kind === "buy") {
      await deps.tg.answerCallback(q.id);
      if (!deps.packs.length) return void (await deps.tg.sendMessage(chatId, "Buying extras is turned off right now."));
      const pack = deps.packs.find((p) => String(p.videos) === id && String(p.questions) === n);
      // A button from before bundles (or before prices changed): show what's on sale now.
      if (!pack) return void (await deps.tg.sendMessage(chatId, "Here's what's on sale now:", buyButtons(deps.packs)));
      try {
        await deps.tg.sendInvoice(chatId, invoiceFor(pack));
      } catch (error) {
        // Without this, a refused invoice looks like a dead button.
        const reason = esc((error instanceof Error ? error.message : String(error)).slice(0, 300));
        console.error("Sending an invoice failed", error);
        await deps.tg.sendMessage(chatId, "I couldn't open the payment screen, so nothing was charged. I've told the owner. Try again later.");
        await tellOwner(deps, `Someone tapped ${esc(packName(pack))}, but Telegram wouldn't make the payment screen: ${reason}`);
      }
      return;
    }
    if (kind === "forget") {
      const user = await deps.store.getUser(q.from.id);
      const i = Number(id);
      if (Number.isInteger(i) && user.facts[i] !== undefined) user.facts.splice(i, 1);
      await deps.store.saveUser(user);
      await deps.tg.answerCallback(q.id, "Forgotten");
      await deps.tg.editMessage(chatId, messageId, memoryText(user), memoryButtons(user));
      return;
    }
    if (kind === "keep" || kind === "repl") {
      if (kind === "repl" && n) {
        await deps.store.deleteSave(q.from.id, n);
        await deps.retriever.remove(q.from.id, n).catch((error) => console.error("Unindex failed", error));
      }
      await deps.tg.answerCallback(q.id, kind === "repl" ? "Replaced" : "Kept both");
      const save = await deps.store.getSave(q.from.id, id);
      if (save) await deps.tg.editMessage(chatId, messageId, `${kind === "repl" ? "Replaced the old one." : "Kept both."}\n\n✓ <i>Saved: ${esc(save.title)}</i>`, reactionButtons(save));
      return;
    }
    if (kind === "open" || kind === "run" || kind === "done" || kind === "words" || kind === "fix" || kind === "show") {
      const save = await deps.store.getSave(q.from.id, id);
      if (!save) return deps.tg.answerCallback(q.id, "That save is gone.");
      if (kind === "show") {
        await deps.tg.answerCallback(q.id);
        await deps.tg.sendMessage(chatId, saveCard(save), saveButtons(save));
        return;
      }
      if (kind === "open" || kind === "run") {
        const i = Math.max(0, Math.min(save.steps.length - 1, Number(n) || 0));
        await deps.tg.answerCallback(q.id);
        // From a card or an answer, open the steps as a new message; inside the steps, page in place.
        if (kind === "open") await deps.tg.sendMessage(chatId, stepText(save, 0), stepButtons(save, 0));
        else await deps.tg.editMessage(chatId, messageId, stepText(save, i), stepButtons(save, i));
        return;
      }
      if (kind === "done") {
        save.practiced += 1;
        await deps.store.updateSave(save);
        await deps.tg.answerCallback(q.id, "Nice.");
        await deps.tg.editMessage(chatId, messageId, `<b>${esc(save.title)}</b>: done (${save.practiced} time${save.practiced === 1 ? "" : "s"}).`, [[{ text: "Run it again", callback_data: `run:${save.id}:0` }]]);
        return;
      }
      const user = await deps.store.getUser(q.from.id);
      user.awaitingWordsFor = kind === "fix" ? `fix:${save.id}` : save.id;
      await deps.store.saveUser(user);
      await deps.tg.answerCallback(q.id);
      await deps.tg.sendMessage(
        chatId,
        kind === "fix"
          ? `What did I get wrong in <b>${esc(save.title)}</b>? Tell me in your own words, like "the barrier goes on the wall, not the ceiling".`
          : `Paste the caption or type what they say in <b>${esc(save.title)}</b>, and I'll make the save exact.`,
      );
      return;
    }
    await deps.tg.answerCallback(q.id);
  } catch (error) {
    await deps.tg.answerCallback(q.id, await failed(error, `handling the ${data.split(":")[0]} button`, deps));
  }
}

// Folders: moving videos, naming, renaming, merging and deleting folders, and filing rules.

/** Said when the folder or filing column is missing (docs/supabase.sql not run again). */
const NOT_SET_UP = "Organizing isn't set up yet. I've told the owner.";
/** How long a "type the folder's name" question waits for its answer. */
const NAMING_MS = 15 * 60_000;

const videos = (n: number) => `${n} video${n === 1 ? "" : "s"}`;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What a typed folder name is for: a new folder for a video, or a folder's new name. */
interface Naming {
  kind: "move" | "rename";
  /** The save's id, or the folder's key. */
  target: string;
}

/** Kept in awaitingWordsFor while a folder name is asked for, with when it was asked. */
export const namingFor = (kind: Naming["kind"], target: string, now = Date.now()) => `name:${kind}:${target}:${now.toString(36)}`;

/** The folder name the next message is for, if one was asked for in the last NAMING_MS. */
export function readNaming(pending: string | null, now = Date.now()): Naming | null {
  const m = /^name:(move|rename):([^:]+):([0-9a-z]+)$/.exec(pending ?? "");
  if (!m) return null;
  return now - parseInt(m[3] ?? "", 36) <= NAMING_MS ? { kind: m[1] as Naming["kind"], target: m[2] ?? "" } : null;
}

/** A message that reads as a folder name: short, one line, not a question or a command. "" otherwise. */
export function folderNameFrom(text: string): string {
  const t = text.trim();
  if (!t || t.length > 60 || t.includes("\n") || t.startsWith("/") || /\?\s*$/.test(t)) return "";
  return cleanFolderName(t);
}

/** Their filing rules, or none if they can't be read. Never stops a save or an answer. */
async function rulesOf(userId: number, deps: Deps): Promise<FilingRule[]> {
  return deps.store.getFiling(userId).catch((error) => (console.error("Reading filing rules failed", error), []));
}

/** Change their filing rules. False (and the owner is told) if they can't be saved. */
async function updateRules(userId: number, change: (rules: FilingRule[]) => FilingRule[], deps: Deps): Promise<boolean> {
  try {
    const rules = await deps.store.getFiling(userId);
    const next = change(rules);
    if (JSON.stringify(next) !== JSON.stringify(rules)) await deps.store.saveFiling(userId, next);
    return true;
  } catch (error) {
    await notSetUp(error, deps);
    return false;
  }
}

async function notSetUp(error: unknown, deps: Deps): Promise<void> {
  console.error("Organizing failed", error);
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  await deps.alert(`Moving videos or saving a filing rule failed. If you haven't, run docs/supabase.sql again in Supabase. ${detail}`).catch(() => {});
}

/** Put saves in a folder. False (and the owner is told) when that can't be saved. */
async function moveInto(userId: number, ids: string[], folder: string, deps: Deps): Promise<boolean> {
  try {
    await deps.store.moveSaves(userId, ids, folder);
    return true;
  } catch (error) {
    await notSetUp(error, deps);
    return false;
  }
}

/**
 * Rename a folder, or merge it into another one (renaming it to a folder they
 * already have). Its rules follow it. `saves` is updated to match. The name it
 * ended up with, or null if it couldn't be saved.
 */
async function renameFolder(userId: number, from: Folder, to: string, saves: Save[], deps: Deps): Promise<string | null> {
  const name = matchFolder(to, saves.filter((s) => !from.saves.includes(s)));
  if (!(await moveInto(userId, from.saves.map((s) => s.id), name, deps))) return null;
  for (const s of from.saves) s.folder = name;
  await updateRules(userId, (rules) => renameRules(rules, from.name, name), deps);
  return name;
}

/** Opens a folder as a new message. */
const openButton = (folder: string): InlineButton[] => [{ text: `📂 Open ${folder.slice(0, 30)}`, callback_data: `folder:${folderKey(folder)}:new` }];

/** The message after "New folder" or "Rename": its name. */
async function nameFolder(chatId: number, userId: number, naming: Naming, name: string, deps: Deps, heard = ""): Promise<void> {
  const saves = await deps.store.listSaves(userId, ALL_SAVES);
  const pre = heard ? `${heard}\n\n` : "";
  if (naming.kind === "move") {
    const save = saves.find((s) => s.id === naming.target);
    if (!save) return void (await deps.tg.sendMessage(chatId, "That video is gone, so there's nothing to move."));
    const folder = matchFolder(name, saves);
    if (!(await moveInto(userId, [save.id], folder, deps))) return void (await deps.tg.sendMessage(chatId, NOT_SET_UP));
    return void (await deps.tg.sendMessage(chatId, `${pre}📂 Moved <b>${esc(save.title)}</b> to <b>${esc(folder)}</b>.`, [openButton(folder)]));
  }
  const from = findFolder(saves, naming.target);
  if (!from) return void (await deps.tg.sendMessage(chatId, "That folder is gone (its videos were moved or deleted), so there's nothing to rename."));
  const to = await renameFolder(userId, from, name, saves, deps);
  if (!to) return void (await deps.tg.sendMessage(chatId, NOT_SET_UP));
  await deps.tg.sendMessage(chatId, `${pre}✏️ Renamed <b>${esc(from.name)}</b> to <b>${esc(to)}</b>.`, [openButton(to)]);
}

/**
 * What they asked for in chat: moves, renames and filing rules (from the
 * answer's MOVE, RENAME and RULE lines). A line for each one done, to show
 * under the answer, and the folder to offer to open.
 */
async function organize(userId: number, reply: Answer, saves: Save[], rules: FilingRule[], deps: Deps): Promise<{ lines: string[]; open: string }> {
  const lines: string[] = [];
  let open = "";
  let broke = false;
  for (const move of reply.moves) {
    const folder = matchFolder(move.folder, saves);
    if (!(await moveInto(userId, move.ids, folder, deps))) {
      broke = true;
      break;
    }
    for (const s of saves) if (move.ids.includes(s.id)) s.folder = folder;
    lines.push(`📂 Moved ${videos(move.ids.length)} to <b>${esc(folder)}</b>.`);
    open = folder;
  }
  for (const rename of broke ? [] : reply.renames) {
    const from = folders(saves).find((f) => sameName(f.name, rename.from));
    if (!from) {
      lines.push(`I couldn't find a folder called <b>${esc(rename.from)}</b>, so nothing was renamed.`);
      continue;
    }
    const to = await renameFolder(userId, from, rename.to, saves, deps);
    if (!to) {
      broke = true;
      break;
    }
    lines.push(`✏️ Renamed <b>${esc(from.name)}</b> to <b>${esc(to)}</b>.`);
    open = to;
  }
  if (!broke && reply.rules.length) {
    const fresh = reply.rules.map((r) => ({ ...r, folder: matchFolder(r.folder, saves) }));
    const base = reply.renames.length ? await rulesOf(userId, deps) : rules;
    try {
      await deps.store.saveFiling(userId, addRules(base, fresh));
      lines.push(...fresh.map((r) => `📌 New videos about ${esc(r.about)} will go in <b>${esc(r.folder)}</b>.`));
    } catch (error) {
      await notSetUp(error, deps);
      broke = true;
    }
  }
  if (broke) lines.push(`⚠️ <i>I couldn't finish organizing that: ${NOT_SET_UP}</i>`);
  return { lines, open };
}

const MOVE_BUTTONS = new Set(["mv", "mvto", "mvback", "mvnew", "del", "delok", "delno"]);
const buttonsAt = (v: string): ButtonsAt => (v === "c" ? "c" : "r");

/** 📂 under a video (pick a folder, or make one), and Delete on its card. */
async function onMoveButton(queryId: string, chatId: number, messageId: number, userId: number, data: string, deps: Deps): Promise<void> {
  const [kind, id = "", a = "", b = ""] = data.split(":");
  const save = await deps.store.getSave(userId, id);
  if (!save) return deps.tg.answerCallback(queryId, "That video is gone.");
  if (kind === "mv") {
    await deps.tg.editButtons(chatId, messageId, moveButtons(save, await deps.store.listSaves(userId, ALL_SAVES), buttonsAt(a)));
    return deps.tg.answerCallback(queryId, "Pick a folder");
  }
  if (kind === "mvback") {
    await deps.tg.editButtons(chatId, messageId, buttonsFor(save, buttonsAt(a)));
    return deps.tg.answerCallback(queryId);
  }
  if (kind === "mvnew") {
    const user = await deps.store.getUser(userId);
    user.awaitingWordsFor = namingFor("move", save.id);
    await deps.store.saveUser(user);
    await deps.tg.answerCallback(queryId);
    return void (await deps.tg.sendMessage(chatId, `What should the new folder for <b>${esc(save.title)}</b> be called? Type its name, like <i>Japan trip</i>.`));
  }
  if (kind === "mvto") {
    const saves = await deps.store.listSaves(userId, ALL_SAVES);
    const folder = findFolder(saves, a);
    if (!folder) {
      await deps.tg.editButtons(chatId, messageId, moveButtons(save, saves, buttonsAt(b)));
      return deps.tg.answerCallback(queryId, "That folder is gone. Pick another.");
    }
    if (!(await moveInto(userId, [save.id], folder.name, deps))) return deps.tg.answerCallback(queryId, NOT_SET_UP);
    await deps.tg.editButtons(chatId, messageId, buttonsFor({ ...save, folder: folder.name }, buttonsAt(b)));
    return deps.tg.answerCallback(queryId, `Moved to ${folder.name}`);
  }
  if (kind === "del") {
    await deps.tg.editButtons(chatId, messageId, deleteButtons(save));
    return deps.tg.answerCallback(queryId, "Delete this video? It can't be undone.");
  }
  if (kind === "delno") {
    await deps.tg.editButtons(chatId, messageId, saveButtons(save));
    return deps.tg.answerCallback(queryId);
  }
  await deps.store.deleteSave(userId, save.id);
  await deps.retriever.remove(userId, save.id).catch((error) => console.error("Unindex failed", error));
  await deps.tg.editMessage(chatId, messageId, `🗑 Deleted <b>${esc(save.title)}</b>.`);
  await deps.tg.answerCallback(queryId, "Deleted");
}

const FOLDER_BUTTONS = new Set(["frn", "fmg", "fmgto", "fdl", "fdlok", "frl"]);

/** Rename, Merge, Delete and Stop the rule, in a folder opened from /folders. */
async function onFolderButton(queryId: string, chatId: number, messageId: number, userId: number, kind: string, key: string, other: string, deps: Deps): Promise<void> {
  const saves = await deps.store.listSaves(userId, ALL_SAVES);
  const folder = findFolder(saves, key);
  const show = async (page: { html: string; buttons: InlineButton[][] } | null) => {
    const shown = page ?? folderList(saves);
    await deps.tg.editMessage(chatId, messageId, shown.html, shown.buttons);
  };
  if (!folder) {
    await deps.tg.answerCallback(queryId, "That folder is gone.");
    return show(null);
  }
  if (kind === "frn") {
    const user = await deps.store.getUser(userId);
    user.awaitingWordsFor = namingFor("rename", key);
    await deps.store.saveUser(user);
    await deps.tg.answerCallback(queryId);
    return void (await deps.tg.sendMessage(chatId, `What should <b>${esc(folder.name)}</b> be called? Type the new name.`));
  }
  if (kind === "fmg") {
    if (folders(saves).length < 2) return deps.tg.answerCallback(queryId, "This is your only folder, so there's nothing to merge it into.");
    await deps.tg.answerCallback(queryId);
    return deps.tg.editMessage(chatId, messageId, `Merge <b>${esc(folder.name)}</b> into which folder? Its ${videos(folder.saves.length)} move there.`, mergeButtons(saves, key));
  }
  if (kind === "fmgto") {
    const into = findFolder(saves, other);
    if (!into) return deps.tg.answerCallback(queryId, "That folder is gone.");
    const to = await renameFolder(userId, folder, into.name, saves, deps);
    if (!to) return deps.tg.answerCallback(queryId, NOT_SET_UP);
    await deps.tg.answerCallback(queryId, `Merged into ${to}`);
    return show(folderView(saves, folderKey(to), await rulesOf(userId, deps)));
  }
  if (kind === "fdl") {
    if (sameName(folder.name, UNSORTED)) return deps.tg.answerCallback(queryId, `${UNSORTED} is where videos from deleted folders go, so it stays. Move its videos with 📂.`);
    await deps.tg.answerCallback(queryId);
    const n = folder.saves.length;
    return deps.tg.editMessage(chatId, messageId, `Delete the <b>${esc(folder.name)}</b> folder? ${n === 1 ? "Its video moves" : `Its ${n} videos move`} to <b>${UNSORTED}</b>, so nothing is lost.`, [
      [{ text: "Delete the folder", callback_data: `fdlok:${key}` }, { text: "Cancel", callback_data: `folder:${key}` }],
    ]);
  }
  if (kind === "fdlok") {
    const unsorted = matchFolder(UNSORTED, saves.filter((s) => !folder.saves.includes(s)));
    if (!(await moveInto(userId, folder.saves.map((s) => s.id), unsorted, deps))) return deps.tg.answerCallback(queryId, NOT_SET_UP);
    for (const s of folder.saves) s.folder = unsorted;
    await updateRules(userId, (rules) => dropRules(rules, folder.name), deps);
    await deps.tg.answerCallback(queryId, "Folder deleted");
    return show(null);
  }
  // Stop the rule
  await updateRules(userId, (rules) => dropRules(rules, folder.name), deps);
  await deps.tg.answerCallback(queryId, "Rule stopped");
  return show(folderView(saves, key, await rulesOf(userId, deps)));
}

/** Search failures never block saving: the save is still kept and found by words. */
async function reindex(save: Save, deps: Deps) {
  await deps.retriever.index(save).catch((error) => console.error("Indexing failed", error));
}

/** Older chats that match, minus the ones still in the recent history. Never blocks an answer. */
async function recall(user: BotUser, question: string, deps: Deps): Promise<ChatMemory[]> {
  const previous = [...user.turns].reverse().find((t) => t.role === "user")?.content ?? "";
  const recent = new Set(user.turns.filter((t) => t.role === "user").map((t) => t.content));
  try {
    return (await deps.retriever.recall(user.id, searchQuery(question, previous), 8)).filter((m) => !recent.has(m.said)).slice(0, 4);
  } catch (error) {
    console.error("Recall failed", error);
    return [];
  }
}

/** Retrieval for a question, falling back to simple word matching if search is down. */
async function retrieve(user: BotUser, question: string, saves: Save[], deps: Deps) {
  const previous = [...user.turns].reverse().find((t) => t.role === "user")?.content ?? "";
  const query = searchQuery(question, previous);
  try {
    const groups = groupHits(await deps.retriever.search(user.id, query, 16));
    return groups.flatMap(({ saveId, passages }) => {
      const save = saves.find((s) => s.id === saveId);
      return save ? [{ save, passages }] : [];
    });
  } catch (error) {
    console.error("Search failed, using word match", error);
    return relevantSaves(saves, query).map((save) => ({ save, passages: [] }));
  }
}
