/**
 * What the bot does with each Telegram update. Every outside service comes in
 * through `deps`, so tests can run whole conversations with fakes.
 *
 * - A link (shared from TikTok) or a video: watch it, save a card.
 * - Any other text: answer from their saves and goal.
 * - Buttons: Start now steps, Done, Add what it says, Keep / Switch / Both.
 * - /start, /goal, /saved.
 */
import { answerText, goalButtons, saveButtons, saveCard, savedList, stepButtons, stepText } from "./format";
import { newSaveId, TURNS_KEPT } from "./store";
import { findUrl } from "./tiktok";
import type { Brain, BotUser, InlineButton, Media, Save, Store, TelegramApi, WatchInput } from "./types";

export interface Deps {
  tg: TelegramApi;
  store: Store;
  brain: Brain;
  media: Media;
  /** Who may use the bot. Each message costs API money, so it's private by default. */
  isAllowed(userId: number): boolean;
}

/** The parts of a Telegram update we read. */
export interface Update {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
    caption?: string;
    video?: { file_id: string; duration?: number; file_size?: number };
    document?: { file_id: string; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
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

const WELCOME = `👋 <b>I'm Knowing.</b> Don't just favorite a video. Send it here and I'll remember exactly what it showed.

<b>How:</b> in TikTok tap <b>Share</b> → <b>Telegram</b> → me. Or send me any video.
<b>Later:</b> just ask. "What was my Bank setup?" "Give me that dodging drill." You get <i>that</i> one, not a generic answer.

Tell me your main goal with /goal so I can point everything at it. Example: <code>/goal Become a successful entrepreneur</code>
/saved shows everything you've sent.`;

const FAIL = "Something went wrong on my side. Try again in a minute.";

export async function handleUpdate(update: Update, deps: Deps): Promise<void> {
  if (update.callback_query) return onButton(update.callback_query, deps);
  const msg = update.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text ?? msg.caption ?? "").trim();

  if (!deps.isAllowed(userId)) {
    await deps.tg.sendMessage(chatId, `This bot is private for now. Your Telegram id is <code>${userId}</code>. Send it to the owner to get access.`);
    return;
  }
  try {
    if (text === "/start" || text.startsWith("/start ")) {
      await deps.tg.sendMessage(chatId, WELCOME);
      return;
    }
    const user = await deps.store.getUser(userId);
    if (text.startsWith("/goal")) return await setGoalCommand(chatId, user, text.replace(/^\/goal(@\w+)?/, "").trim(), deps);
    if (text.startsWith("/saved")) {
      await deps.tg.sendMessage(chatId, savedList(await deps.store.listSaves(userId)));
      return;
    }

    const video = msg.video ?? (msg.document?.mime_type?.startsWith("video/") ? msg.document : undefined);
    if (video) {
      if ((video.file_size ?? 0) > 20 * 1024 * 1024) {
        await deps.tg.sendMessage(chatId, "That video is over 20 MB, which is Telegram's limit for bots. Share the TikTok link instead.");
        return;
      }
      const duration = "duration" in video && typeof video.duration === "number" ? video.duration : 0;
      return await watchAndSave(chatId, user, () => deps.media.fromTelegramFile(video.file_id, duration), "", text, deps);
    }

    const url = findUrl(text);
    if (url) return await watchAndSave(chatId, user, () => deps.media.fromLink(url), url, text.replace(url, "").trim(), deps);

    if (!text) return;
    if (user.awaitingWordsFor) return await addWords(chatId, user, text, deps);
    await answer(chatId, user, text, deps);
  } catch (error) {
    console.error("Bot update failed", error);
    await deps.tg.sendMessage(chatId, FAIL).catch(() => {});
  }
}

async function setGoalCommand(chatId: number, user: BotUser, goal: string, deps: Deps) {
  if (!goal) {
    await deps.tg.sendMessage(chatId, user.goal ? `🎯 Your goal: <b>${esc(user.goal)}</b>\nChange it with <code>/goal your new goal</code>.` : "No goal yet. Set one like this: <code>/goal Become a successful entrepreneur</code>");
    return;
  }
  user.goal = goal.slice(0, 200);
  user.offer = null;
  await deps.store.saveUser(user);
  await deps.tg.sendMessage(chatId, `🎯 Goal set: <b>${esc(user.goal)}</b>\nI'll point answers at it, and tell you when a question pulls against it.`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function watchAndSave(chatId: number, user: BotUser, get: () => Promise<WatchInput>, sourceUrl: string, note: string, deps: Deps) {
  const status = await deps.tg.sendMessage(chatId, "👀 Watching it…");
  let input: WatchInput;
  try {
    input = await get();
  } catch (error) {
    console.error("Media failed", error);
    await deps.tg.editMessage(chatId, status, "I couldn't open that video. Try sending it again, or send the video file itself.");
    return;
  }
  if (!input.frames.length && !input.transcript && !input.caption) {
    await deps.tg.editMessage(chatId, status, ["I couldn't get anything out of that one.", ...input.notes].join("\n"));
    return;
  }
  const draft = await deps.brain.watch({ ...input, note });
  const save: Save = {
    ...draft,
    needsWords: draft.needsWords && !input.transcript,
    id: newSaveId(),
    userId: user.id,
    sourceUrl,
    words: "",
    practiced: 0,
    createdAt: new Date().toISOString(),
  };
  await deps.store.saveUser(user); // saves belong to a user row, so make sure it exists
  await deps.store.addSave(save);
  await deps.tg.editMessage(chatId, status, saveCard(save, input.notes), saveButtons(save));
}

async function addWords(chatId: number, user: BotUser, words: string, deps: Deps) {
  const id = user.awaitingWordsFor ?? "";
  user.awaitingWordsFor = null;
  await deps.store.saveUser(user);
  const save = await deps.store.getSave(user.id, id);
  if (!save) return answer(chatId, user, words, deps);
  await deps.tg.typing(chatId);
  const draft = await deps.brain.rewrite(save, words);
  const updated: Save = { ...save, ...draft, words: words.slice(0, 8_000), needsWords: false };
  await deps.store.updateSave(updated);
  await deps.tg.sendMessage(chatId, saveCard(updated).replace("✅ <b>Saved:</b>", "✏️ <b>Updated:</b>"), saveButtons(updated));
}

async function answer(chatId: number, user: BotUser, question: string, deps: Deps) {
  await deps.tg.typing(chatId);
  const saves = await deps.store.listSaves(user.id);
  const reply = await deps.brain.answer({ user, question: question.slice(0, 4_000), saves });
  const used = reply.sources.map((id) => saves.find((s) => s.id === id)).filter((s): s is Save => Boolean(s));

  let extra = "";
  if (!user.goal && reply.goal) {
    user.goal = reply.goal;
    extra = `\n\n🎯 <i>Saved your goal: ${esc(user.goal)}. Change it anytime with /goal.</i>`;
  }
  const offer = user.goal && (reply.switchTo || reply.both) ? { switchTo: reply.switchTo, both: reply.both } : null;
  user.offer = offer;
  user.turns = [...user.turns, { role: "user" as const, content: question }, { role: "assistant" as const, content: reply.text }].slice(-TURNS_KEPT);
  await deps.store.saveUser(user);

  const buttons: InlineButton[][] = offer ? goalButtons(user.goal, offer) : [];
  const runnable = used.find((s) => (s.type === "drill" || s.type === "plan") && s.steps.length);
  if (runnable) buttons.push([{ text: `▶️ Start: ${runnable.title.slice(0, 40)}`, callback_data: `open:${runnable.id}` }]);
  await deps.tg.sendMessage(chatId, answerText(reply.text, used) + extra + (offer ? "\n\n<b>Want to change your goal?</b>" : ""), buttons);
}

async function onButton(q: NonNullable<Update["callback_query"]>, deps: Deps) {
  const chatId = q.message?.chat.id;
  const messageId = q.message?.message_id;
  const data = q.data ?? "";
  if (!chatId || !messageId) return deps.tg.answerCallback(q.id);
  if (!deps.isAllowed(q.from.id)) return deps.tg.answerCallback(q.id, "This bot is private.");
  try {
    const [kind, id = "", n = "0"] = data.split(":");
    if (kind === "open" || kind === "run" || kind === "done" || kind === "words") {
      const save = await deps.store.getSave(q.from.id, id);
      if (!save) return deps.tg.answerCallback(q.id, "That save is gone.");
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
        await deps.tg.editMessage(chatId, messageId, `✅ <b>${esc(save.title)}</b>: done. That's ${save.practiced} time${save.practiced === 1 ? "" : "s"}.`, [[{ text: "🔁 Run it again", callback_data: `run:${save.id}:0` }]]);
        return;
      }
      const user = await deps.store.getUser(q.from.id);
      user.awaitingWordsFor = save.id;
      await deps.store.saveUser(user);
      await deps.tg.answerCallback(q.id);
      await deps.tg.sendMessage(chatId, `Paste the caption or type what they say in <b>${esc(save.title)}</b>, and I'll make the save exact.`);
      return;
    }
    if (kind === "goal") {
      const user = await deps.store.getUser(q.from.id);
      if (!user.offer) return deps.tg.answerCallback(q.id, "That choice already expired.");
      const next = id === "switch" ? user.offer.switchTo : id === "both" ? user.offer.both : "";
      if (next) user.goal = next;
      user.offer = null;
      await deps.store.saveUser(user);
      await deps.tg.answerCallback(q.id, next ? "Goal changed" : "Kept your goal");
      await deps.tg.sendMessage(chatId, next ? `🎯 Goal changed to: <b>${esc(user.goal)}</b>` : `🎯 Kept your goal: <b>${esc(user.goal)}</b>`);
      return;
    }
    await deps.tg.answerCallback(q.id);
  } catch (error) {
    console.error("Button failed", error);
    await deps.tg.answerCallback(q.id, FAIL);
  }
}

