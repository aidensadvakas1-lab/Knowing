/**
 * Browser-side client for Knowing's API routes.
 * Adds the optional password header and turns error bodies into ApiError.
 */
import { ChatStreamParser, type ChatStreamEvent } from "./chat-stream";
import { PASSWORD_HEADER } from "./constants";
import type {
  ApiErrorBody,
  ApiErrorCode,
  ChatTurn,
  HealthResponse,
  ItemKind,
  KnowledgeItem,
  LearnResponse,
  Profile,
  TranscribeResponse,
} from "./types";
import type { ChatAttachment } from "./attachments";
import type { VideoFrame } from "./video";

/** An API failure with a stable code the UI can react to. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function headers(password: string): HeadersInit {
  return password ? { "content-type": "application/json", [PASSWORD_HEADER]: password } : { "content-type": "application/json" };
}

/** Throw an ApiError built from a failed response's JSON body. */
async function raise(res: Response): Promise<never> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = await res.json();
  } catch {
    // Not JSON: fall through to a generic message.
  }
  throw new ApiError(body.error ?? `Request failed (${res.status}).`, body.code ?? "internal");
}

/** GET /api/health */
export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) await raise(res);
  return res.json();
}

/** POST /api/learn */
export async function learn(
  input: {
    kind: ItemKind;
    title: string;
    url: string;
    content: string;
    goal: string;
    frames?: VideoFrame[];
    durationSec?: number;
  },
  password: string,
): Promise<LearnResponse> {
  const res = await fetch("/api/learn", { method: "POST", headers: headers(password), body: JSON.stringify(input) });
  if (!res.ok) await raise(res);
  return res.json();
}

/** POST /api/transcribe with one WAV chunk. Returns its transcript. */
export async function transcribe(wav: Blob, password: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("audio", wav, "audio.wav");
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: password ? { [PASSWORD_HEADER]: password } : undefined,
    body: form,
    signal,
  });
  if (!res.ok) await raise(res);
  const body: TranscribeResponse = await res.json();
  return body.text;
}

/** Callbacks for {@link streamChat}. */
export interface ChatHandlers {
  /** Called with the full answer so far each time new text arrives. */
  onText: (fullText: string) => void;
}

/** Result of a finished chat stream. */
export interface ChatResult {
  text: string;
  stopReason: string | null;
}

/**
 * POST /api/chat and stream the answer. Resolves when the answer ends.
 * Rejects with ApiError on failure; a partial answer is attached as `partial`.
 */
export async function streamChat(
  payload: { profile: Profile; items: KnowledgeItem[]; messages: ChatTurn[]; attachments?: ChatAttachment[] },
  password: string,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const res = await fetch("/api/chat", { method: "POST", headers: headers(password), body: JSON.stringify(payload), signal });
  if (!res.ok || !res.body) await raise(res);

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new ChatStreamParser();
  let text = "";
  let stopReason: string | null = null;

  const handle = (event: ChatStreamEvent) => {
    if (event.type === "text") {
      text += event.text;
      handlers.onText(text);
    } else if (event.type === "done") {
      stopReason = event.stopReason;
    } else if (event.type === "error") {
      throw Object.assign(new ApiError(event.error, event.code), { partial: text });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value).forEach(handle);
  }
  parser.flush().forEach(handle);
  return { text, stopReason };
}
