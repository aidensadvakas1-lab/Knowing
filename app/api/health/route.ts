/**
 * GET /api/health
 *
 * Tells the client whether the server is ready (API key set) and whether it
 * needs to ask for a password. Never reveals the key or password themselves.
 */
import { isAiConfigured, isPasswordRequired } from "@/lib/server";
import { isTranscriptionConfigured } from "@/lib/transcribe";
import type { HealthResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const body: HealthResponse = {
    ok: true,
    aiConfigured: isAiConfigured(),
    passwordRequired: isPasswordRequired(),
    transcriptionConfigured: isTranscriptionConfigured(),
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
