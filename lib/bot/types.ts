/**
 * Shapes shared by the Telegram bot: what a save is, what we keep per user,
 * and the small interfaces the update handler depends on (so tests can swap
 * in fakes for Telegram, the database, Claude and video processing).
 */

/** What kind of thing a video teaches. Drills and plans can be run step by step. */
export type SaveType = "drill" | "setup" | "plan" | "tip" | "mindset" | "info";

export const SAVE_TYPES: readonly SaveType[] = ["drill", "setup", "plan", "tip", "mindset", "info"];

export const SAVE_TYPE_LABEL: Record<SaveType, string> = {
  drill: "Drill",
  setup: "Setup",
  plan: "Plan",
  tip: "Tip",
  mindset: "Mindset",
  info: "Info",
};

/** The part of a save that Claude writes after watching a video. */
export interface SaveDraft {
  title: string;
  /** Subject, then the specific part, e.g. "Siege, Bank". */
  topic: string;
  type: SaveType;
  summary: string;
  /** The exact steps, in order. */
  steps: string[];
  /** Everything else worth remembering, with exact specifics. */
  details: string;
  /** True when important details are spoken and we couldn't hear them. */
  needsWords: boolean;
}

/** One remembered video. */
export interface Save extends SaveDraft {
  id: string;
  userId: number;
  sourceUrl: string;
  /** What the video says, when the user typed or pasted it in. */
  words: string;
  /** How many times they've run it with Start now. */
  practiced: number;
  createdAt: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** A pending "change your goal?" offer from the last answer. */
export interface GoalOffer {
  switchTo: string;
  both: string;
}

/** Everything kept per Telegram user besides their saves. */
export interface BotUser {
  id: number;
  goal: string;
  turns: Turn[];
  offer: GoalOffer | null;
  /** Set when the next text message is the words for a save, not a question. */
  awaitingWordsFor: string | null;
}

export interface Store {
  getUser(id: number): Promise<BotUser>;
  saveUser(user: BotUser): Promise<void>;
  addSave(save: Save): Promise<void>;
  updateSave(save: Save): Promise<void>;
  getSave(userId: number, id: string): Promise<Save | null>;
  /** Newest first. */
  listSaves(userId: number, limit?: number): Promise<Save[]>;
}

/** What we could get out of a video: frames to look at, speech, and the caption. */
export interface WatchInput {
  frames: string[];
  transcript: string;
  caption: string;
  /** Problems worth telling the user about (no audio, couldn't download...). */
  notes: string[];
}

export interface Media {
  /** A TikTok link: download, then frames + speech. Falls back to the caption. */
  fromLink(url: string): Promise<WatchInput>;
  /** A video sent straight to the bot. */
  fromTelegramFile(fileId: string, durationSec: number): Promise<WatchInput>;
}

/** The parsed reply to a question. */
export interface Answer {
  text: string;
  /** Ids of the saves it used. */
  sources: string[];
  /** A goal the user stated, when they had none set. */
  goal: string;
  switchTo: string;
  both: string;
}

export interface AskInput {
  user: BotUser;
  question: string;
  saves: Save[];
}

export interface Brain {
  watch(input: WatchInput & { note: string }): Promise<SaveDraft>;
  /** Rewrite a save once we have what the video actually says. */
  rewrite(save: Save, words: string): Promise<SaveDraft>;
  answer(input: AskInput): Promise<Answer>;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramApi {
  sendMessage(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number>;
  editMessage(chatId: number, messageId: number, html: string, buttons?: InlineButton[][]): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  typing(chatId: number): Promise<void>;
}
