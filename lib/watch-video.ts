/**
 * Watch an uploaded video end to end, in the browser: grab frames, transcribe
 * the speech chunk by chunk, then have the server assess it. Shared by the
 * Teach tab and the chat's + button.
 */
import { ApiError, learn, transcribe } from "./api-client";
import { LIMITS } from "./constants";
import type { ItemKind, KnowledgeItem } from "./types";
import { checkVideo, extractAudio, extractFrames, VideoError } from "./video";
import { formatTimestamp } from "./video-math";

export interface WatchVideoInput {
  file: File;
  kind: ItemKind;
  title: string;
  url: string;
  /** The user's own notes, kept alongside the transcript. */
  notes: string;
  goal: string;
  password: string;
  /** Whether the server can transcribe speech (from /api/health). */
  canTranscribe: boolean;
  /** Progress text for the UI. */
  onStatus: (status: string) => void;
}

export interface WatchVideoResult {
  /** Fields to store on the knowledge item. */
  patch: Pick<KnowledgeItem, "title" | "content" | "takeaways" | "tags" | "assessment" | "status">;
  /** Notes worth showing the user (frames only, partial audio, server warnings). */
  notes: string[];
}

export { checkVideo, VideoError };

/** Run the whole pipeline. Throws VideoError or ApiError with a user-facing message. */
export async function watchVideo(input: WatchVideoInput, durationSec: number): Promise<WatchVideoResult> {
  const { file, onStatus } = input;
  const notes: string[] = [];

  onStatus("Looking at the video…");
  const frames = await extractFrames(file);

  let transcript = "";
  if (input.canTranscribe) {
    onStatus("Pulling out the audio…");
    const chunks = await extractAudio(file);
    if (chunks.length === 0) notes.push("No speech found, so it watched the frames only.");
    const lines: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      onStatus(chunks.length > 1 ? `Listening… part ${i + 1} of ${chunks.length}` : "Listening…");
      try {
        const text = await transcribe(chunk.wav, input.password);
        if (text) lines.push(`[${formatTimestamp(chunk.start)}] ${text}`);
      } catch (error) {
        notes.push(`Couldn't hear all of it: ${error instanceof ApiError ? error.message : "the server didn't answer."}`);
        if (error instanceof ApiError && (error.code === "not_configured" || error.code === "unauthorized")) break;
      }
    }
    transcript = lines.join("\n");
  } else {
    notes.push("The server can't hear audio yet (no OPENAI_API_KEY), so it watched the frames only.");
  }
  if (!frames.length && !transcript) throw new VideoError("Couldn't get any frames or speech out of that video.");

  const combined = [transcript, input.notes && `Their own notes: ${input.notes}`].filter(Boolean).join("\n\n");
  onStatus("Watching it…");
  const result = await learn(
    {
      kind: input.kind,
      title: input.title,
      url: input.url,
      content: combined.slice(0, LIMITS.itemContentChars),
      goal: input.goal,
      frames,
      durationSec,
    },
    input.password,
  );
  if (result.warning) notes.unshift(result.warning);
  return {
    patch: {
      title: result.title,
      content: result.content.slice(0, LIMITS.itemContentChars),
      takeaways: result.takeaways,
      tags: result.tags,
      assessment: result.assessment,
      status: result.takeaways.length ? "done" : "saved",
    },
    notes,
  };
}
