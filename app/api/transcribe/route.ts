/**
 * POST /api/transcribe
 *
 * Takes one short WAV chunk (multipart field `audio`) cut from an uploaded
 * video in the browser and returns its transcript. The browser sends a long
 * video as several chunks, one request each, to stay under hosting body limits.
 */
import { VIDEO } from "@/lib/constants";
import { apiError, checkPassword } from "@/lib/server";
import { isTranscriptionConfigured, TranscribeError, transcribeAudio } from "@/lib/transcribe";
import type { TranscribeResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const denied = checkPassword(request);
  if (denied) return denied;
  if (!isTranscriptionConfigured()) {
    return apiError("not_configured", "The server has no OPENAI_API_KEY, so it can't hear videos yet. Add it in your hosting settings.");
  }

  let audio: FormDataEntryValue | null;
  try {
    audio = (await request.formData()).get("audio");
  } catch {
    return apiError("bad_request", "Send the audio as multipart form data.");
  }
  if (!(audio instanceof Blob) || audio.size === 0) return apiError("bad_request", "No audio was sent.");
  if (audio.size > VIDEO.chunkBytes) return apiError("too_large", "That piece of audio is too large.");

  try {
    const body: TranscribeResponse = { text: await transcribeAudio(audio, request.signal) };
    return Response.json(body);
  } catch (error) {
    if (error instanceof TranscribeError) return apiError(error.code, error.message);
    console.error("Unexpected transcription error", error);
    return apiError("internal", "Something went wrong. Try again.");
  }
}
