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

/** Limits and settings for uploaded videos, processed in the browser. */
export const VIDEO = {
  /** Frames grabbed per video and shown to Claude. */
  frames: 8,
  /** Longest side of each frame, in pixels. */
  frameMaxSide: 768,
  /** JPEG quality for frames (0 to 1). */
  jpegQuality: 0.72,
  /** Max base64 characters per frame accepted by the server. */
  frameChars: 400_000,
  /** Audio is resampled to this rate (Hz) before transcription. */
  sampleRate: 16_000,
  /** Seconds of audio per transcription request. 60 s of 16 kHz WAV is about 1.9 MB, under Vercel's 4.5 MB body limit. */
  chunkSec: 60,
  /** Max bytes of one audio chunk accepted by the server. */
  chunkBytes: 4_000_000,
  /** Longest video accepted, in seconds. Longer videos use too much phone memory. */
  maxDurationSec: 20 * 60,
  /** Largest video file accepted, in bytes. */
  maxFileBytes: 500 * 1024 * 1024,
} as const;

/** Limits for files attached to a chat message with the + button. */
export const ATTACHMENTS = {
  /** Files per message. */
  max: 4,
  /** Largest picked file for images and PDFs, before any shrinking. */
  maxPickBytes: 25 * 1024 * 1024,
  /** Images are shrunk so their longest side is at most this many pixels. */
  imageMaxSide: 1_568,
  /** Max base64 characters of all images and PDFs in one message. Keeps requests under Vercel's 4.5 MB body limit. */
  totalBinaryChars: 3_200_000,
  /** Max characters read from one text file. */
  textChars: 40_000,
} as const;

/** Models used by the API routes. Override with env vars if needed. */
export const MODELS = {
  /** Main coaching model for chat answers. */
  chat: process.env.KNOWING_CHAT_MODEL || "claude-opus-5-5",
  /** Fast, cheap model for pulling takeaways out of taught items. */
  extract: process.env.KNOWING_EXTRACT_MODEL || "claude-haiku-5-5",
  /** Model that watches uploaded videos (reads frames and transcript). */
  video: process.env.KNOWING_VIDEO_MODEL || "claude-sonnet-5-5",
  /** Model behind the Telegram bot's answers. Cheap, since people ask many questions. */
  bot: process.env.KNOWING_BOT_MODEL || "claude-haiku-5-5",
  /** Model that watches each video sent to the bot. Runs once per video, so it can be the strongest. */
  watch: process.env.KNOWING_WATCH_MODEL || "claude-opus-5-5",
  /** Speech-to-text model at the transcription endpoint. */
  transcribe: process.env.KNOWING_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
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
