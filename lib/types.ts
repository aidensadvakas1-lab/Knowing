/**
 * Shared domain types for Knowing.
 *
 * Everything the browser stores and everything the API routes accept is
 * described here, so the client and server agree on one shape.
 */

/** The kinds of things a user can teach Knowing. */
export type ItemKind = "tiktok" | "video" | "article" | "note";

/** Who wrote a chat turn. Mirrors the Messages API roles. */
export type ChatRole = "user" | "assistant";

/**
 * The user's profile: the starting point for every answer.
 * All fields are free text so the user can say as much or as little as they want.
 */
export interface Profile {
  /** Where they are now: school, grade, job, age. */
  now: string;
  /** Their main goal. Falls back to {@link DEFAULT_GOAL} when empty. */
  goal: string;
  /** Skills and experience they already have. */
  skills: string;
  /** Time they can put in each week. */
  time: string;
  /** Anything else: interests, money limits, deadlines, people they know. */
  more: string;
  /** Epoch milliseconds of the last save. */
  updatedAt?: number;
}

/** Processing state of a taught item. */
export type ItemStatus = "reading" | "done" | "saved";

/** One thing the user taught Knowing: a video, TikTok, article or note. */
export interface KnowledgeItem {
  id: string;
  kind: ItemKind;
  title: string;
  /** Source link, if any. */
  url: string;
  /** Transcript, caption or the user's own notes. */
  content: string;
  /** 3 to 5 concrete takeaways pulled out by the model. */
  takeaways: string[];
  /** 1 to 3 short lowercase topic tags. */
  tags: string[];
  status: ItemStatus;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** One message in the chat history. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** Everything Knowing keeps in the browser. Used for backup and restore. */
export interface KnowingBackup {
  version: 1;
  exportedAt: number;
  profile: Profile;
  items: KnowledgeItem[];
  chat: ChatTurn[];
}

/** Where the text for a taught item came from. */
export type SourceOrigin = "pasted" | "youtube-transcript" | "tiktok-caption" | "web-page";

/** Response body of `POST /api/learn`. */
export interface LearnResponse {
  title: string;
  takeaways: string[];
  tags: string[];
  /** The text that was analyzed, so the client can store it. */
  content: string;
  origin: SourceOrigin;
  /** Non-fatal note to show the user, e.g. "transcript unavailable". */
  warning?: string;
}

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  ok: boolean;
  /** True when the server has an Anthropic API key configured. */
  aiConfigured: boolean;
  /** True when the server requires the app password on API calls. */
  passwordRequired: boolean;
}

/** Error body every API route returns on failure. */
export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_configured"
  | "rate_limited"
  | "upstream_error"
  | "refused"
  | "too_large"
  | "internal";
