/**
 * POST /api/chat
 *
 * Streams a coaching answer. The body carries the user's profile, what they
 * have taught, and the recent conversation; the server builds the system
 * prompt so the client can't change Knowing's instructions.
 *
 * Response: `application/x-ndjson`, see lib/chat-stream.ts.
 */
import { LIMITS, MODELS } from "@/lib/constants";
import { encodeEvent, type ChatStreamEvent } from "@/lib/chat-stream";
import { buildSystemPrompt, messageWithAttachments } from "@/lib/prompt";
import type Anthropic from "@anthropic-ai/sdk";
import { apiError, describeAnthropicError, getAnthropic, guardAiRoute } from "@/lib/server";
import { ChatRequestSchema, describeZodError } from "@/lib/validate";
import type { KnowledgeItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long answers can take a while; let hosts that honor this allow it. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const denied = guardAiRoute(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("bad_request", "The request body must be JSON.");
  }
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) return apiError("bad_request", describeZodError(parsed.error));

  const { profile, items, messages, attachments } = parsed.data;
  const system = buildSystemPrompt(profile, items as KnowledgeItem[]);

  // Send the most recent turns, starting on a user turn as the API requires.
  const history = messages.slice(-LIMITS.chatTurnsSent);
  while (history.length && history[0].role !== "user") history.shift();
  // Files from the + button ride along with the newest message only.
  const last = history.at(-1)!;
  const turns: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(0, -1),
    { role: "user", content: attachments.length ? messageWithAttachments(last.content, attachments) : last.content },
  ];

  // The SDK starts the request lazily; errors surface while iterating below.
  const stream = getAnthropic().beta.messages.stream(
    {
      model: MODELS.chat,
      max_tokens: 16_000,
      system,
      messages: turns,
      output_config: { effort: "medium" },
      // If the main model declines, let the API retry on its recommended fallback.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal: request.signal },
  );

  const encoder = new TextEncoder();
  const responseBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => controller.enqueue(encoder.encode(encodeEvent(event)));
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ type: "text", text: event.delta.text });
          }
        }
        const final = await stream.finalMessage();
        send({ type: "done", stopReason: final.stop_reason });
      } catch (error) {
        // An abort means the user pressed Stop; there is nothing left to report.
        if (!request.signal.aborted) {
          const { code, message } = describeAnthropicError(error);
          send({ type: "error", code, error: message });
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(responseBody, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
