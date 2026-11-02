/**
 * What the bot does with each Telegram update. Every outside service comes in
 * through `deps`, so tests can run whole conversations with fakes.
 *
 * - A link (shared from TikTok) or a video: watch it, save it, and react in
 *   a sentence or two (how it connects to their other saves). No coaching.
 * - Any other text: answer from their saves and what they've told us.
 * - Buttons: Show steps, Start now, Add what it says, Fix something, Keep both / Replace.
 * - /start, /help, /saved, /memory, /usage, /delete, and /invite for the owner.
 * - Asking "how many questions do I have left?" gets the same answer as /usage, for free.
 * - An invite link lets people in without editing settings, up to a set number of spots.
 * - When the free daily amount runs out, extras can be bought with Telegram Stars (shop.ts).
 *   /terms, /support and /paysupport, plus /refund and /reply for the owner.
 * - Daily limits per user, and an alert to the owner when something breaks.
 * - Shares close together make a sitting, wrapped up later in wrapup.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { answerText, escapeHtml as esc, reactionButtons, reactionText, saveButtons, saveCard, savedList, stepButtons, stepText } from "./format";
import { WELCOME } from "./profile";
import { buyButton, invoiceFor, PACKS, packName, PAYSUPPORT_HELP, readPack, SUPPORT_HELP, TERMS } from "./shop";
import { relevantSaves, sharedVideoTurns } from "./prompts";
import { groupHits, searchQuery, type Retriever } from "./rag";
import { FACTS_KEPT, newSaveId, newUser, TURNS_KEPT } from "./store";
import { findUrl } from "./tiktok";
import type { Brain, BotUser, ChatMemory, InlineButton, Media, PackKind, Save, Store, TelegramApi, Usage, Wallet, WatchInput } from "./types";

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
  /** The invite link: whoever opens it can join, until `spots` people have joined that way. */
  invite: { code: string; spots: number; link(): Promise<string> };
  /** Most videos and questions per user per day, so one person can't run up the API bill. */
  limits: { videos: number; questions: number };
  /** Price in Telegram Stars of one pack of extras (shop.ts). 0 turns buying off. */
  packStars: number;
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
    document?: { file_id: string; mime_type?: string; file_size?: number };
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

/** Count one use, or return false when today's limit is reached. */
export function spend(user: BotUser, kind: "videos" | "questions", limit: number): boolean {
  if (user.usage.day !== today()) user.usage = { day: today(), videos: 0, questions: 0 };
  if (user.usage[kind] >= limit) return false;
  user.usage[kind] += 1;
  return true;
}

/** When the limits reset (midnight UTC), in words: "in about 6 hours". */
export function resetsIn(now = Date.now()): string {
  const minutes = Math.ceil((86_400_000 - (now % 86_400_000)) / 60_000);
  if (minutes < 60) return "in under an hour";
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

export const limitText = (kind: "videos" | "questions", n: number, now = Date.now()) =>
  kind === "videos"
    ? `That's ${n} videos today, the daily limit, so I didn't save this one. Send it again ${resetsIn(now)}.`
    : `That's ${n} questions today, the daily limit. You can ask more ${resetsIn(now)}.`;

/**
 * What /usage says: free videos and questions left today, when they reset,
 * and what they bought. Also given to the model, so a question about it in
 * other words gets the same numbers.
 */
export function usageText(usage: Usage, limits: Deps["limits"], wallet: Wallet | null, packStars: number, now = Date.now()): string {
  const fresh = usage.day !== new Date(now).toISOString().slice(0, 10);
  const left = (kind: PackKind) => Math.max(0, limits[kind] - (fresh ? 0 : usage[kind]));
  const lines = [
    `<b>Free today</b>, back to full ${resetsIn(now)}:`,
    `Videos: ${left("videos")} of ${limits.videos} left`,
    `Questions: ${left("questions")} of ${limits.questions} left`,
  ];
  if (wallet && (wallet.videos || wallet.questions)) {
    lines.push("", `<b>Extras you bought:</b> ${wallet.videos} video${wallet.videos === 1 ? "" : "s"} and ${wallet.questions} question${wallet.questions === 1 ? "" : "s"}. They never expire and kick in when your free ones run out.`);
  } else if (packStars) {
    lines.push("", `When your free ones run out, you can get ${packName("videos")} or ${packName("questions")} for ${packStars} ⭐ each.`);
  }
  return lines.join("\n");
}

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
      if (!invited) return void (await deps.tg.sendMessage(chatId, privateText(userId)));
      if (!(await join(chatId, userId, msg.from.first_name, deps))) return;
    }
    if (text.startsWith("/invite") && userId === deps.ownerId) {
      const used = await spotsUsed(deps);
      await deps.tg.sendMessage(chatId, `Your invite link:\n${await deps.invite.link()}\n\n${used} of ${deps.invite.spots} spots used. Anyone who opens the link can join until the spots run out. I'll message you each time someone joins.`);
      return;
    }
    if (userId === deps.ownerId && /^\/(refund|reply)\b/.test(text)) return await ownerCommand(chatId, text, deps);
    if (text.startsWith("/terms")) return void (await deps.tg.sendMessage(chatId, TERMS));
    const support = /^\/(pay)?support\b/.exec(text);
    if (support) return await askOwner(chatId, userId, msg.from.first_name, text.slice(support[0].length).trim(), Boolean(support[1]), deps);
    if (text === "/start" || text.startsWith("/start ") || text.startsWith("/help")) {
      await deps.tg.sendMessage(chatId, WELCOME);
      return;
    }
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
    if (text.startsWith("/delete")) {
      const count = (await deps.store.listSaves(userId)).length;
      await deps.tg.sendMessage(chatId, `This deletes your ${count} save${count === 1 ? "" : "s"}, our chats and everything I remember about you. It can't be undone.`, [
        [{ text: "Delete everything", callback_data: "wipe:yes" }],
        [{ text: "Cancel", callback_data: "wipe:no" }],
      ]);
      return;
    }

    const video = msg.video ?? (msg.document?.mime_type?.startsWith("video/") ? msg.document : undefined);
    if (video) {
      if ((video.file_size ?? 0) > 20 * 1024 * 1024) {
        await deps.tg.sendMessage(chatId, "That video is over 20 MB, which is Telegram's limit for bots. Share the TikTok link instead.");
        return;
      }
      if (!(await allow(user, "videos", deps))) return await limitReached(chatId, "videos", deps);
      const duration = "duration" in video && typeof video.duration === "number" ? video.duration : 0;
      return await watchAndSave(chatId, user, () => deps.media.fromTelegramFile(video.file_id, duration), "", text, deps);
    }

    const url = findUrl(text);
    if (url && !(await allow(user, "videos", deps))) return await limitReached(chatId, "videos", deps);
    if (url) return await watchAndSave(chatId, user, () => deps.media.fromLink(url), url, text.replace(url, "").trim(), deps);

    if (!text) return;
    if (user.awaitingWordsFor) return await addWords(chatId, user, text, deps);
    // Before the limit check: checking what's left shouldn't use a question, and works when none are left.
    if (asksAboutUsage(text)) return await showUsage(chatId, user, deps);
    if (!(await allow(user, "questions", deps))) return await limitReached(chatId, "questions", deps);
    await answer(chatId, user, text, deps, msg.from.first_name);
  } catch (error) {
    await deps.tg.sendMessage(chatId, await failed(error, "handling a message", deps)).catch(() => {});
  }
}

/** Count one use: today's free amount first, then what they bought. False when both are used up. */
async function allow(user: BotUser, kind: PackKind, deps: Deps): Promise<boolean> {
  if (spend(user, kind, deps.limits[kind])) return true;
  const wallet = await deps.store.getWallet(user.id).catch((error) => void console.error("Reading the wallet failed", error));
  if (!wallet || wallet[kind] < 1) return false;
  await deps.store.saveWallet(user.id, { ...wallet, [kind]: wallet[kind] - 1 });
  return true;
}

/** Their wallet, or null if it can't be read (then /usage just leaves extras out). */
const walletOf = (userId: number, deps: Deps) => deps.store.getWallet(userId).catch((error) => (console.error("Reading the wallet failed", error), null));

async function showUsage(chatId: number, user: BotUser, deps: Deps): Promise<void> {
  await deps.tg.sendMessage(chatId, usageText(user.usage, deps.limits, await walletOf(user.id, deps), deps.packStars));
}

/** Out of free and bought ones: say when it resets, and offer a pack. */
async function limitReached(chatId: number, kind: PackKind, deps: Deps): Promise<void> {
  const text = limitText(kind, deps.limits[kind]);
  if (!deps.packStars) return void (await deps.tg.sendMessage(chatId, text));
  await deps.tg.sendMessage(chatId, `${text}\n\nOr get ${packName(kind)} now. They never expire.`, buyButton(kind, deps.packStars));
}

/** Telegram asks right before charging. Say no (and they aren't charged) unless we can record what they bought. */
async function onPreCheckout(p: NonNullable<Update["pre_checkout_query"]>, deps: Deps): Promise<void> {
  let error = "";
  try {
    const pack = readPack(p.invoice_payload);
    if (!pack || p.currency !== "XTR" || !deps.packStars || p.total_amount !== deps.packStars || pack.stars !== deps.packStars) {
      error = "That price has changed. Tap the button again for the current one. You weren't charged.";
    } else if (!(await hasAccess(p.from.id, deps))) {
      error = "Knowing is invite-only for now. You weren't charged.";
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
    wallet[pack.kind] += PACKS[pack.kind];
    wallet.paid = [...wallet.paid, { charge: pay.telegram_payment_charge_id, kind: pack.kind, stars: pay.total_amount, at: new Date().toISOString() }];
    await deps.store.saveWallet(userId, wallet);
    await deps.tg.sendMessage(chatId, `Thanks! ${packName(pack.kind)} added, so you have ${wallet[pack.kind]} extra ${pack.kind}. They never expire and kick in when your free ones run out. Any problem with a payment, send /paysupport.`);
    await tellOwner(deps, `${who} paid ${pay.total_amount} ⭐ for ${packName(pack.kind)}. To refund it: ${refund}`);
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
    wallet[payment.kind] = Math.max(0, wallet[payment.kind] - PACKS[payment.kind]);
    wallet.paid = wallet.paid.filter((p) => p !== payment);
    await deps.store.saveWallet(userId, wallet);
  }
  await deps.tg.sendMessage(userId, `Your payment${payment ? ` of ${payment.stars} ⭐` : ""} was refunded.`).catch(() => {});
  await deps.tg.sendMessage(chatId, payment ? `Refunded, and I took the ${packName(payment.kind)} back off their account (never below 0).` : "Refunded.");
}

/** /support and /paysupport: pass the message to the owner, with refund commands for payment problems. */
async function askOwner(chatId: number, userId: number, name: string | undefined, body: string, payments: boolean, deps: Deps): Promise<void> {
  if (!body) return void (await deps.tg.sendMessage(chatId, payments ? PAYSUPPORT_HELP : SUPPORT_HELP));
  let recent = "";
  if (payments) {
    const paid = (await deps.store.getWallet(userId).catch(() => null))?.paid.slice(-3) ?? [];
    recent = paid.length
      ? `\n\nTheir latest payments:\n${paid.map((p) => `${p.stars} ⭐ for ${packName(p.kind)}: <code>/refund ${userId} ${esc(p.charge)}</code>`).join("\n")}`
      : "\n\nNo payments on record.";
  }
  await tellOwner(deps, `<b>${payments ? "Payment problem" : "Support"}</b> from ${name ? esc(name) : "someone"}:\n${esc(body)}${recent}\n\nReply with <code>/reply ${userId} your message</code>`);
  await deps.tg.sendMessage(chatId, "Sent to the owner. You'll get an answer here.");
}

/** For strangers. The id is how the owner lets themselves in on a fresh setup (docs/TELEGRAM.md, step 6). */
const privateText = (id: number) => `Knowing is invite-only for now. Ask the person who told you about it for an invite link.\n\nYour Telegram id: <code>${id}</code>`;
const FULL = "Knowing is full right now, so I can't let you in yet. I've let the owner know.";

/** Let in through settings, or already joined with the invite link. */
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

/** Someone opened the invite link: let them in if a spot is free. Tells the owner either way. */
async function join(chatId: number, userId: number, name: string | undefined, deps: Deps): Promise<boolean> {
  const used = await spotsUsed(deps);
  const who = name ? esc(name) : "Someone";
  if (used >= deps.invite.spots) {
    await deps.tg.sendMessage(chatId, FULL);
    await tellOwner(deps, `${who} tried to join with your invite link, but all ${deps.invite.spots} spots are taken. To make room, raise KNOWING_INVITE_SPOTS in Vercel.`);
    return false;
  }
  await deps.store.saveUser(newUser(userId));
  await tellOwner(deps, `${who} joined Knowing with your invite link. ${used + 1} of ${deps.invite.spots} spots used.`);
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
  const watched = await deps.brain.watch({ ...input, note, facts: user.facts, saves });
  const save: Save = {
    ...watched.draft,
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
}

/** The message after Add what it says or Fix something: remake that save with it. */
async function addWords(chatId: number, user: BotUser, text: string, deps: Deps) {
  const pending = user.awaitingWordsFor ?? "";
  const fixing = pending.startsWith("fix:");
  user.awaitingWordsFor = null;
  await deps.store.saveUser(user);
  const save = await deps.store.getSave(user.id, fixing ? pending.slice(4) : pending);
  if (!save) return answer(chatId, user, text, deps);
  await deps.tg.typing(chatId);
  const draft = await deps.brain.rewrite(save, text, fixing ? "fix" : "words");
  const updated: Save = fixing
    ? { ...save, ...draft, needsWords: save.needsWords && !save.words }
    : { ...save, ...draft, words: text.slice(0, 8_000), needsWords: false };
  await deps.store.updateSave(updated);
  await reindex(updated, deps);
  await deps.tg.sendMessage(chatId, `${fixing ? "Fixed." : "Updated with what it says."}\n\n${saveCard(updated)}`, saveButtons(updated));
}

async function answer(chatId: number, user: BotUser, question: string, deps: Deps, name = "") {
  await deps.tg.typing(chatId);
  const saves = await deps.store.listSaves(user.id);
  const [retrieved, memories, wallet] = await Promise.all([retrieve(user, question, saves, deps), recall(user, question, deps), walletOf(user.id, deps)]);
  const usage = usageText(user.usage, deps.limits, wallet, deps.packStars).replace(/<\/?b>/g, "");
  const reply = await deps.brain.answer({ user, question: question.slice(0, 4_000), saves, retrieved, name, memories, usage });
  const find = (ids: string[]) => ids.map((id) => saves.find((s) => s.id === id)).filter((s): s is Save => Boolean(s));
  const used = find(reply.sources);

  const fresh = reply.remember.filter((f) => !user.facts.includes(f));
  user.facts = [...user.facts, ...fresh].slice(-FACTS_KEPT);
  user.turns = [...user.turns, { role: "user" as const, content: question }, { role: "assistant" as const, content: reply.text }].slice(-TURNS_KEPT);
  await deps.store.saveUser(user);

  const buttons: InlineButton[][] = [];
  const runnable = used.find((s) => (s.type === "drill" || s.type === "plan") && s.steps.length);
  if (runnable) buttons.push([{ text: `Start: ${runnable.title.slice(0, 40)}`, callback_data: `open:${runnable.id}` }]);
  await deps.tg.sendMessage(chatId, answerText(reply.text, used, find(reply.about)), buttons);
  // Every chat is kept and searchable, so something said weeks ago can still come back.
  const memory: ChatMemory = { said: question.slice(0, 4_000), answered: reply.text.slice(0, 4_000), at: new Date().toISOString() };
  await deps.retriever.remember(user.id, memory).catch((error) => console.error("Remembering the chat failed", error));
}

async function onButton(q: NonNullable<Update["callback_query"]>, deps: Deps) {
  const chatId = q.message?.chat.id;
  const messageId = q.message?.message_id;
  const data = q.data ?? "";
  if (!chatId || !messageId) return deps.tg.answerCallback(q.id);
  try {
    if (!(await hasAccess(q.from.id, deps))) return await deps.tg.answerCallback(q.id, "Knowing is invite-only for now.");
    const [kind, id = "", n = "0"] = data.split(":");
    if (kind === "wipe") {
      if (id === "yes") {
        const { usage } = await deps.store.getUser(q.from.id);
        const wallet = await deps.store.getWallet(q.from.id).catch(() => null);
        await deps.store.deleteUser(q.from.id);
        // An empty row keeps their spot, today's limits and what they bought, so deleting doesn't lock them out or reset the limits.
        await deps.store.saveUser({ ...newUser(q.from.id), usage });
        if (wallet && (wallet.videos || wallet.questions || wallet.paid.length)) await deps.store.saveWallet(q.from.id, wallet);
      }
      await deps.tg.answerCallback(q.id, id === "yes" ? "Deleted" : undefined);
      await deps.tg.editMessage(chatId, messageId, id === "yes" ? "Deleted. Everything you saved, our chats and everything I remembered about you are gone." : "Cancelled. Nothing was deleted.");
      return;
    }
    if (kind === "buy") {
      await deps.tg.answerCallback(q.id);
      if ((id === "videos" || id === "questions") && deps.packStars) await deps.tg.sendInvoice(chatId, invoiceFor(id, deps.packStars));
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
