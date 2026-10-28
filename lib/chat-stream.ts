/**
 * The wire format of `POST /api/chat`: newline-delimited JSON events.
 *
 * NDJSON lets the server stream text as it is written, then still report how
 * the answer ended (or failed) after the HTTP status has been sent.
 */
import type { ApiErrorCode } from "./types";

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; stopReason: "end_turn" | "max_tokens" | "refusal" | string | null }
  | { type: "error"; code: ApiErrorCode; error: string };

/** Serialize one event as an NDJSON line. */
export function encodeEvent(event: ChatStreamEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Incremental NDJSON parser. Feed it decoded chunks as they arrive; it returns
 * every complete event and keeps any partial line for the next call.
 */
export class ChatStreamParser {
  private buffer = "";

  push(chunk: string): ChatStreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  /** Parse whatever is left once the stream has closed. */
  flush(): ChatStreamEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    return this.parseLine(rest);
  }

  private parseLine(line: string): ChatStreamEvent[] {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as ChatStreamEvent];
    } catch {
      return [];
    }
  }
}
