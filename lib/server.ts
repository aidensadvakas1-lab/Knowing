/**
 * Server-only helpers shared by the API routes: the Anthropic client,
 * the optional password check, and consistent JSON errors.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { timingSafeEqual } from "node:crypto";
import { PASSWORD_HEADER } from "./constants";
import type { ApiErrorBody, ApiErrorCode } from "./types";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  too_large: 413,
  refused: 422,
  rate_limited: 429,
  internal: 500,
  upstream_error: 502,
  not_configured: 503,
};

/** A JSON error response with a stable `code` the client can switch on. */
export function apiError(code: ApiErrorCode, message: string): Response {
  const body: ApiErrorBody = { error: message, code };
  return Response.json(body, { status: STATUS[code] });
}

/** True when an Anthropic API key is configured. */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** True when the deployment asks for a password (APP_PASSWORD is set). */
export function isPasswordRequired(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

let client: Anthropic | null = null;

/** Lazily create one Anthropic client per server instance. */
export function getAnthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/**
 * Check the optional app password. Returns an error response to send back,
 * or null when the request may continue. Uses a constant-time comparison.
 */
export function checkPassword(request: Request): Response | null {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return null;
  const given = request.headers.get(PASSWORD_HEADER) ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? null : apiError("unauthorized", "Wrong or missing password.");
}

/** Common guard for AI routes: password first, then API key. */
export function guardAiRoute(request: Request): Response | null {
  const denied = checkPassword(request);
  if (denied) return denied;
  if (!isAiConfigured()) {
    return apiError("not_configured", "The server has no ANTHROPIC_API_KEY. Add it in your hosting settings.");
  }
  return null;
}

/** A user-facing description of a failed AI call. */
export interface AiFailure {
  code: ApiErrorCode;
  message: string;
}

/** Map an Anthropic SDK error to a stable code and a short user-facing message. */
export function describeAnthropicError(error: unknown): AiFailure {
  if (error instanceof Anthropic.RateLimitError) {
    return { code: "rate_limited", message: "Hit the AI usage limit. Wait a minute, then try again." };
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { code: "not_configured", message: "The server's Anthropic API key was rejected. Check it in your hosting settings." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return /too long|too large|context/i.test(error.message)
      ? { code: "too_large", message: "There's too much saved to send at once. Delete a few long items in Teach." }
      : { code: "upstream_error", message: "The AI rejected the request. Try rephrasing." };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { code: "upstream_error", message: "Couldn't reach the AI. Check your connection and try again." };
  }
  if (error instanceof Anthropic.APIError) {
    return { code: "upstream_error", message: "The AI service had a problem. Try again in a moment." };
  }
  console.error("Unexpected error", error);
  return { code: "internal", message: "Something went wrong. Try again." };
}

/** Same as {@link describeAnthropicError}, as a ready-to-send JSON response. */
export function fromAnthropicError(error: unknown): Response {
  const { code, message } = describeAnthropicError(error);
  return apiError(code, message);
}
