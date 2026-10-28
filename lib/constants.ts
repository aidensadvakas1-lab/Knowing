import type { ItemKind, Profile } from "./types";

/** The goal used until the user writes their own in the Me tab. */
export const DEFAULT_GOAL =
  "Learn enough about AI to be part of a successful startup. Figure out the right major and minor, the business knowledge I need, and everything else it takes to succeed.";

/** Human labels for each item kind. */
export const KIND_LABEL: Record<ItemKind, string> = {
  tiktok: "TikTok",
  video: "Video",
  article: "Article",
  note: "Note",
};

export const ITEM_KINDS = Object.keys(KIND_LABEL) as ItemKind[];

/** An empty profile, used on first load. */
export const EMPTY_PROFILE: Profile = { now: "", goal: "", skills: "", time: "", more: "" };

/** Starter prompts shown on an empty chat. */
export const STARTER_PROMPTS = [
  "Build my roadmap to joining an AI startup",
  "Which major and minor fit my goal?",
  "What should I focus on this week?",
  "What business skills do I need most?",
] as const;

/**
 * Size limits. They keep requests well inside the model's context window and
 * stop one huge paste from crowding out everything else.
 */
export const LIMITS = {
  /** Max characters stored per item's content. */
  itemContentChars: 20_000,
  /** Characters of each item's content sent with every chat request. */
  itemContentInPrompt: 1_500,
  /** Total characters of taught knowledge sent with a chat request. */
  knowledgeBudgetChars: 60_000,
  /** Chat turns kept in history and sent to the model. */
  chatTurnsKept: 30,
  chatTurnsSent: 20,
  /** Max characters in a single chat message from the user. */
  messageChars: 8_000,
  /** Max items accepted by the chat route. */
  items: 500,
  /** Max bytes of a fetched web page before we stop reading. */
  fetchBytes: 2_000_000,
  /** Timeout for fetching a source link, in milliseconds. */
  fetchTimeoutMs: 10_000,
} as const;

/** Models used by the API routes. Override with env vars if needed. */
export const MODELS = {
  /** Main coaching model for chat answers. */
  chat: process.env.KNOWING_CHAT_MODEL || "claude-opus-5-5",
  /** Fast, cheap model for pulling takeaways out of taught items. */
  extract: process.env.KNOWING_EXTRACT_MODEL || "claude-haiku-5-5",
} as const;

/** localStorage keys. Versioned so a future schema change can migrate. */
export const STORAGE_KEYS = {
  profile: "knowing.v1.profile",
  items: "knowing.v1.items",
  chat: "knowing.v1.chat",
  password: "knowing.v1.password",
} as const;

/** Header the client uses to send the optional app password. */
export const PASSWORD_HEADER = "x-knowing-password";
