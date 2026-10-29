/**
 * What the bot does with each Telegram update. Every outside service comes in
 * through `deps`, so tests can run whole conversations with fakes.
 *
 * - A link (shared from TikTok) or a video: watch it, save it, and react in
 *   a sentence or two (how it connects to their other saves). No coaching.
 * - Any other text: answer from their saves and what they've told us.
 * - Buttons: Show steps, Start now, Add what it says, Keep both / Replace.
 * - /start, /saved, /memory.
 */
import { answerText, escapeHtml as esc, reactionButtons, reactionText, saveButtons, saveCard, savedList, stepButtons, stepText } from "./format";
import { relevantSaves } from "./prompts";
import { groupHits, searchQuery, type Retriever } from "./rag";
import { FACTS_KEPT, newSaveId, TURNS_KEPT } from "./store";
import { findUrl } from "./tiktok";
import type { Brain, BotUser, InlineButton, Media, Save, Store, TelegramApi, WatchInput } from "./types";

export interface Deps {
  tg: TelegramApi;
  store: Store;
  brain: Brain;
  media: Media;
  /** Finds the saves and passages that answer a question (hybrid vector + word search). */
  retriever: Retriever;
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

const WELCOME = `Send me videos you want to keep. In TikTok, tap Share, then Telegram, then me.

I'll remember exactly what each one showed. Ask me about any of them later, in your own words.

/saved lists everything. /memory shows what I remember about you.`;

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
    if (text.startsWith("/memory")) {
      await deps.tg.sendMessage(chatId, memoryText(user), memoryButtons(user));
      return;
    }
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

function memoryText(user: BotUser): string {
  if (!user.facts.length) return "Nothing yet. When you mention something lasting, like your rank or your position, I'll remember it.";
  return ["What I remember about you:", ...user.facts.map((f, i) => `${i + 1}. ${esc(f)}`)].join("\n");
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
    console.error("Media failed", error);
    await deps.tg.editMessage(chatId, status, "I couldn't open that video. Try sending it again, or send the video file itself.");
    return;
  }
  if (!input.frames.length && !input.transcript && !input.caption) {
    await deps.tg.editMessage(chatId, status, ["I couldn't get anything out of that one.", ...input.notes].join("\n"));
    return;
  }
  const saves = await deps.store.listSaves(user.id);
  const watched = await deps.brain.watch({ ...input, note, facts: user.facts, saves });
  const save: Save = {
    ...watched.draft,
    needsWords: watched.draft.needsWords && !input.transcript,
    id: newSaveId(),
    userId: user.id,
    sourceUrl,
    words: "",
    source: [input.caption && `Caption: ${input.caption}`, input.transcript && `Transcript: ${input.transcript}`].filter(Boolean).join("\n").slice(0, 20_000),
    practiced: 0,
    createdAt: new Date().toISOString(),
  };
  await deps.store.saveUser(user); // saves belong to a user row, so make sure it exists
  await deps.store.addSave(save);
  await reindex(save, deps);
  const decide = watched.relation === "conflict" || watched.relation === "duplicate" ? saves.find((s) => s.id === watched.relatedId) : null;
  await deps.tg.editMessage(chatId, status, reactionText(watched.reply, save, input.notes), reactionButtons(save, decide));
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
  await reindex(updated, deps);
  await deps.tg.sendMessage(chatId, `Updated with what it says.\n\n${saveCard(updated)}`, saveButtons(updated));
}

async function answer(chatId: number, user: BotUser, question: string, deps: Deps) {
  await deps.tg.typing(chatId);
  const saves = await deps.store.listSaves(user.id);
  const retrieved = await retrieve(user, question, saves, deps);
  const reply = await deps.brain.answer({ user, question: question.slice(0, 4_000), saves, retrieved });
  const used = reply.sources.map((id) => saves.find((s) => s.id === id)).filter((s): s is Save => Boolean(s));

  const fresh = reply.remember.filter((f) => !user.facts.includes(f));
  user.facts = [...user.facts, ...fresh].slice(-FACTS_KEPT);
  user.turns = [...user.turns, { role: "user" as const, content: question }, { role: "assistant" as const, content: reply.text }].slice(-TURNS_KEPT);
  await deps.store.saveUser(user);

  const buttons: InlineButton[][] = [];
  const runnable = used.find((s) => (s.type === "drill" || s.type === "plan") && s.steps.length);
  if (runnable) buttons.push([{ text: `Start: ${runnable.title.slice(0, 40)}`, callback_data: `open:${runnable.id}` }]);
  await deps.tg.sendMessage(chatId, answerText(reply.text, used), buttons);
}

async function onButton(q: NonNullable<Update["callback_query"]>, deps: Deps) {
  const chatId = q.message?.chat.id;
  const messageId = q.message?.message_id;
  const data = q.data ?? "";
  if (!chatId || !messageId) return deps.tg.answerCallback(q.id);
  if (!deps.isAllowed(q.from.id)) return deps.tg.answerCallback(q.id, "This bot is private.");
  try {
    const [kind, id = "", n = "0"] = data.split(":");
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
    if (kind === "open" || kind === "run" || kind === "done" || kind === "words" || kind === "show") {
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
      user.awaitingWordsFor = save.id;
      await deps.store.saveUser(user);
      await deps.tg.answerCallback(q.id);
      await deps.tg.sendMessage(chatId, `Paste the caption or type what they say in <b>${esc(save.title)}</b>, and I'll make the save exact.`);
      return;
    }
    await deps.tg.answerCallback(q.id);
  } catch (error) {
    console.error("Button failed", error);
    await deps.tg.answerCallback(q.id, FAIL);
  }
}

/** Search failures never block saving: the save is still kept and found by words. */
async function reindex(save: Save, deps: Deps) {
  await deps.retriever.index(save).catch((error) => console.error("Indexing failed", error));
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
