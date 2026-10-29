/**
 * Speech-to-text for uploaded videos. Claude reads text and images but not
 * audio, so speech goes through an OpenAI-compatible transcription endpoint
 * first (OpenAI by default; Groq and others work via KNOWING_TRANSCRIBE_URL).
 */
import "server-only";
import { MODELS } from "./constants";
import type { ApiErrorCode } from "./types";

const DEFAULT_URL = "https://api.openai.com/v1/audio/transcriptions";

/** True when a transcription API key is configured. */
export function isTranscriptionConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** A transcription failure with a stable code for the client. */
export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode,
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

/** Map an HTTP status from the transcription service to a user-facing error. */
export function transcribeErrorFor(status: number): TranscribeError {
  if (status === 401 || status === 403) {
    return new TranscribeError("The server's OPENAI_API_KEY was rejected. Check it in your hosting settings.", "not_configured");
  }
  if (status === 429) return new TranscribeError("Hit the transcription usage limit. Wait a minute, then try again.", "rate_limited");
  if (status === 413) return new TranscribeError("That piece of audio was too large to transcribe.", "too_large");
  return new TranscribeError("The transcription service had a problem. Try again in a moment.", "upstream_error");
}

/** Transcribe one audio file and return its text. */
export async function transcribeAudio(audio: Blob, signal?: AbortSignal, filename = "audio.wav"): Promise<string> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", MODELS.transcribe);
  form.append("response_format", "json");
  let res: Response;
  try {
    res = await fetch(process.env.KNOWING_TRANSCRIBE_URL || DEFAULT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal,
    });
  } catch {
    throw new TranscribeError("Couldn't reach the transcription service. Try again.", "upstream_error");
  }
  if (!res.ok) {
    console.error("Transcription failed", res.status, await res.text().catch(() => ""));
    throw transcribeErrorFor(res.status);
  }
  const body = (await res.json().catch(() => ({}))) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}
