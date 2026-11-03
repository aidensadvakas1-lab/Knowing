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
  /** Subject, then the specific part, e.g. "Cooking, Pasta". */
  topic: string;
  /**
   * The folder it's filed in (folders.ts). Claude picks it when it watches the
   * video, and they can move it. Empty on saves from before folders could be
   * moved: those are filed by the first part of the topic.
   */
  folder?: string;
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

/** Free videos and questions used. They're given once, so the counts never reset. */
export interface Usage {
  /** YYYY-MM-DD (UTC) of their first use. */
  day: string;
  videos: number;
  questions: number;
}

/** The two things that are limited: videos watched and questions asked. */
export type PackKind = "videos" | "questions";

/** A pack on sale: videos and questions together in one purchase, for how many Stars. */
export interface Pack {
  videos: number;
  questions: number;
  stars: number;
}

/** One Star payment, kept for refunds and so a payment is never counted twice. */
export interface Payment {
  /** Telegram's id for the payment, needed to refund it. */
  charge: string;
  /** How many of each it added. */
  videos: number;
  questions: number;
  stars: number;
  at: string;
}

/** Extras bought with Stars. Used after the free ones, and they never expire. */
export interface Wallet {
  videos: number;
  questions: number;
  /** Most recent payments, newest last. */
  paid: Payment[];
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
  /** Set while a scroll session is waiting for its wrap-up. Only touchSitting and closeSitting write it. */
  sitting: Sitting | null;
}

/** Their weekly flashback setting. Off until they turn it on. */
export interface DigestState {
  on: boolean;
  /** True once they've been asked whether they want it, so it's asked once. */
  offered: boolean;
  /** When the last one went out (ISO), or "". */
  sent: string;
  /** Flashbacks sent in a row with no message from them since. At 3 they pause until they're back. */
  quiet: number;
}

/** Who invited them, and how many friends they've earned free videos for (referral.ts). */
export interface Referral {
  /** Who invited them, or 0. */
  by: number;
  /** Their first name when they joined, for the message to whoever invited them. */
  name: string;
  /** True once whoever invited them got their reward, so it's given once. */
  credited: boolean;
  /** Friends they invited who earned them free videos. */
  rewarded: number;
}

/** "Anything about cars goes in Car mods": followed whenever a new video is filed. */
export interface FilingRule {
  folder: string;
  /** What goes there, in their words. */
  about: string;
}

/** A list they made themselves, like Date night. A video can be in many, and stays in its folder too. */
export interface Collection {
  name: string;
  /** The saves in it, oldest added first. */
  ids: string[];
}

/** One scroll session: videos shared close together. Which videos is worked out from the saves' times. */
export interface Sitting {
  /** When the latest video in it was saved (ISO). */
  last: string;
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
  /** True if they have a row: they've used the bot, or joined with the invite link. */
  hasUser(id: number): Promise<boolean>;
  /** Everyone with a row, for counting invite spots. */
  listUserIds(): Promise<number[]>;
  /**
   * What they've bought with Stars. Kept apart from the user row, so a slow
   * save of the row (a video still being watched) can't undo a payment.
   */
  getWallet(userId: number): Promise<Wallet>;
  saveWallet(userId: number, wallet: Wallet): Promise<void>;
  /** Newest first. */
  listSaves(userId: number, limit?: number): Promise<Save[]>;
  /** Users with a scroll session that hasn't had its wrap-up yet. */
  listOpenSittings(): Promise<BotUser[]>;
  /**
   * Note that they just saved a video. Writes only this, so a slower update
   * of the user row (another video still being watched) can't undo it.
   */
  touchSitting(userId: number, at: string): Promise<void>;
  /** End their sitting, unless they've shared again since `last`. True if this call ended it. */
  closeSitting(userId: number, last: string): Promise<boolean>;
  /** Their flashback setting. Throws if the digest column is missing (docs/supabase.sql not run again). */
  getDigest(userId: number): Promise<DigestState>;
  /** Writes only the flashback setting, creating the row if needed. */
  saveDigest(userId: number, digest: DigestState): Promise<void>;
  /** Everyone with the flashback on, and when they last messaged the bot (ISO). */
  listDigestUsers(): Promise<Array<{ id: number; digest: DigestState; active: string }>>;
  /** Put these saves in a folder. Throws if the folder column is missing (docs/supabase.sql not run again). */
  moveSaves(userId: number, ids: string[], folder: string): Promise<void>;
  /** Their filing rules. Throws if the filing column is missing (docs/supabase.sql not run again). */
  getFiling(userId: number): Promise<FilingRule[]>;
  /** Writes only the filing rules, creating the row if needed. Throws if the column is missing. */
  saveFiling(userId: number, rules: FilingRule[]): Promise<void>;
  /** Their collections. Throws if the collections column is missing (docs/supabase.sql not run again). */
  getCollections(userId: number): Promise<Collection[]>;
  /** Writes only the collections, creating the row if needed. Throws if the column is missing. */
  saveCollections(userId: number, collections: Collection[]): Promise<void>;
  /** Their invite record. Throws if the referral column is missing (docs/supabase.sql not run again). */
  getReferral(userId: number): Promise<Referral>;
  /** Writes only the invite record, creating the row if needed. */
  saveReferral(userId: number, referral: Referral): Promise<void>;
}

/** What we could get out of a video: frames to look at, speech, and the caption. */
export interface WatchInput {
  frames: string[];
  /** When each frame was taken (seconds), if known. */
  frameTimes?: number[];
  transcript: string;
  /** Text read off the screen from frames about every second, so a command or link that flashes by isn't lost. */
  screenText?: string;
  caption: string;
  /** Problems worth telling the user about (no audio, couldn't download...). */
  notes: string[];
}

export interface Media {
  /** A TikTok link: download, then frames + speech. Falls back to the caption. */
  fromLink(url: string): Promise<WatchInput>;
  /** A video sent straight to the bot. */
  fromTelegramFile(fileId: string, durationSec: number): Promise<WatchInput>;
  /**
   * A voice message's words. Only the first VOICE_MAX_SECONDS are heard (`cut`
   * says so). Throws NoTranscription when speech-to-text isn't set up.
   */
  hearVoice(fileId: string, durationSec: number): Promise<{ text: string; cut: boolean }>;
}

/** Speech-to-text isn't set up (no OPENAI_API_KEY). */
export class NoTranscription extends Error {
  constructor() {
    super("No speech-to-text key");
    this.name = "NoTranscription";
  }
}

/** The parsed reply to a question. */
export interface Answer {
  text: string;
  /** Ids of the saves the answer came from. */
  sources: string[];
  /** Ids of saves on the same topic that the answer didn't come from (including one the chat is about when the useful part came from Claude, like install steps a video skips). Shown as "Videos related to this topic". */
  about: string[];
  /** New lasting facts the user mentioned. */
  remember: string[];
  /** Videos they asked to put in a folder (a new one or one they have). */
  moves: Array<{ folder: string; ids: string[] }>;
  /** Folders they asked to rename. */
  renames: Array<{ from: string; to: string }>;
  /** Filing rules they asked for. */
  rules: FilingRule[];
  /** Videos they asked to add to a collection (a new one or one they have). */
  collects: Array<{ collection: string; ids: string[] }>;
  /** Videos they asked to take out of a collection. */
  uncollects: Array<{ collection: string; ids: string[] }>;
}

/** How a new save relates to what's already saved. */
export type Relation = "none" | "related" | "duplicate" | "alternative";

/** What watching a video produces: the save, plus a short reaction to send back. */
export interface WatchResult {
  draft: SaveDraft;
  /** 1 to 3 sentences: what it is, and how it connects to their saves. Not coaching. */
  reply: string;
  relation: Relation;
  /** The existing save it duplicates or is another way to do, if any. */
  relatedId: string;
}

export interface AskInput {
  user: BotUser;
  question: string;
  saves: Save[];
  /** The saves retrieval picked for this question, best first, with passages from the video. */
  retrieved: Array<{ save: Save; passages: string[] }>;
  /** Their first name on Telegram, if it shares one. */
  name?: string;
  /** Older chats that match this message, best first. */
  memories?: ChatMemory[];
  /** What they have left today and bought (the /usage text, plain), so "how many do I have left?" in any words gets real numbers. */
  usage?: string;
  /** Their filing rules, so the answer knows them and can change them. */
  rules?: FilingRule[];
  /** Their collections, so the answer knows what's in them and can add to them. */
  collections?: Collection[];
  /** Everything Knowing is and does (profile.ts aboutKnowing), so questions about the bot get real answers. */
  about?: string;
}

/** One exchange from the chat, kept so it can be found again weeks later. */
export interface ChatMemory {
  said: string;
  answered: string;
  /** When it was said (ISO). */
  at: string;
}

export interface Brain {
  watch(input: WatchInput & { note: string; facts: string[]; saves: Save[]; rules?: FilingRule[] }): Promise<WatchResult>;
  /** Remake a save from its spoken words, or from the user's correction. */
  rewrite(save: Save, text: string, kind?: "words" | "fix"): Promise<SaveDraft>;
  answer(input: AskInput): Promise<Answer>;
  /** A few friendly lines on what they kept in one scroll session and how it connects. */
  wrapUp(input: { kept: Save[]; others: Save[]; facts: string[] }): Promise<string>;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** A bill for something paid in Telegram Stars. */
export interface Invoice {
  /** 1 to 32 characters. */
  title: string;
  /** 1 to 255 characters. */
  description: string;
  /** Comes back with the payment, so we know what was bought. Up to 128 bytes. */
  payload: string;
  stars: number;
}

export interface TelegramApi {
  sendMessage(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number>;
  editMessage(chatId: number, messageId: number, html: string, buttons?: InlineButton[][]): Promise<void>;
  /** Change only a message's buttons, leaving its text as it is. */
  editButtons(chatId: number, messageId: number, buttons: InlineButton[][]): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  sendInvoice(chatId: number, invoice: Invoice): Promise<void>;
  /** Telegram asks right before charging; it has to be answered within 10 seconds. */
  answerPreCheckout(queryId: string, ok: boolean, error?: string): Promise<void>;
  refundStars(userId: number, charge: string): Promise<void>;
}
