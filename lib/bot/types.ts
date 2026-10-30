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
  /** The video's own words as captured (transcript + caption), kept for retrieval. */
  source: string;
  /** How many times they've run it with Start now. */
  practiced: number;
  createdAt: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** What a user has used today, for the daily limits. Resets each UTC day. */
export interface Usage {
  /** YYYY-MM-DD (UTC) the counts are for. */
  day: string;
  videos: number;
  questions: number;
}

/** Everything kept per Telegram user besides their saves. */
export interface BotUser {
  id: number;
  /** Lasting things they've mentioned (rank, platform, school year...), so they never repeat themselves. */
  facts: string[];
  turns: Turn[];
  /**
   * Set when the next text message is about a save, not a question: a save id
   * for its spoken words, or "fix:<id>" for a correction.
   */
  awaitingWordsFor: string | null;
  usage: Usage;
}

export interface Store {
  getUser(id: number): Promise<BotUser>;
  saveUser(user: BotUser): Promise<void>;
  addSave(save: Save): Promise<void>;
  updateSave(save: Save): Promise<void>;
  getSave(userId: number, id: string): Promise<Save | null>;
  deleteSave(userId: number, id: string): Promise<void>;
  /** Everything about a user: their row, saves and search index. */
  deleteUser(userId: number): Promise<void>;
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
  /** New lasting facts the user mentioned. */
  remember: string[];
}

/** How a new save relates to what's already saved. */
export type Relation = "none" | "related" | "duplicate" | "conflict";

/** What watching a video produces: the save, plus a short reaction to send back. */
export interface WatchResult {
  draft: SaveDraft;
  /** 1 to 3 sentences: what it is, and how it connects to their saves. Not coaching. */
  reply: string;
  relation: Relation;
  /** The existing save it duplicates or conflicts with, if any. */
  relatedId: string;
}

export interface AskInput {
  user: BotUser;
  question: string;
  saves: Save[];
  /** The saves retrieval picked for this question, best first, with passages from the video. */
  retrieved: Array<{ save: Save; passages: string[] }>;
}

export interface Brain {
  watch(input: WatchInput & { note: string; facts: string[]; saves: Save[] }): Promise<WatchResult>;
  /** Rewrite a save once we have what the video actually says. */
  /** Remake a save from its spoken words, or from the user's correction. */
  rewrite(save: Save, text: string, kind?: "words" | "fix"): Promise<SaveDraft>;
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
