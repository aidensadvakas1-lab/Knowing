/**
 * Request validation for the API routes.
 *
 * Every body that reaches the server is parsed with these schemas first, so
 * route handlers only ever see well-formed, size-limited data.
 */
import { z } from "zod";
import { ITEM_KINDS, LIMITS } from "./constants";

const text = (max: number) => z.string().max(max).default("");

export const ProfileSchema = z.object({
  now: text(4_000),
  goal: text(4_000),
  skills: text(4_000),
  time: text(1_000),
  more: text(4_000),
  updatedAt: z.number().optional(),
});

export const KnowledgeItemSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(ITEM_KINDS as [string, ...string[]]).transform((k) => k as (typeof ITEM_KINDS)[number]),
  title: text(300),
  url: text(2_000),
  content: text(LIMITS.itemContentChars),
  takeaways: z.array(z.string().max(500)).max(10).default([]),
  tags: z.array(z.string().max(40)).max(5).default([]),
  status: z.enum(["reading", "done", "saved"]).default("saved"),
  createdAt: z.number().nonnegative(),
});

export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(LIMITS.messageChars * 4),
});

/** Body of `POST /api/chat`. */
export const ChatRequestSchema = z
  .object({
    profile: ProfileSchema.partial().default({}),
    items: z.array(KnowledgeItemSchema).max(LIMITS.items).default([]),
    messages: z.array(ChatTurnSchema).min(1).max(LIMITS.chatTurnsKept * 2),
  })
  .refine((body) => body.messages.at(-1)?.role === "user", {
    message: "The last message must be from the user.",
    path: ["messages"],
  })
  .refine((body) => (body.messages.at(-1)?.content.length ?? 0) <= LIMITS.messageChars, {
    message: `Messages can be at most ${LIMITS.messageChars} characters.`,
    path: ["messages"],
  });

/** Body of `POST /api/learn`. Needs a link, some content, or both. */
export const LearnRequestSchema = z
  .object({
    kind: z.enum(ITEM_KINDS as [string, ...string[]]).transform((k) => k as (typeof ITEM_KINDS)[number]),
    title: text(300),
    url: text(2_000),
    content: text(LIMITS.itemContentChars),
    goal: text(4_000),
  })
  .refine((b) => b.url.trim() || b.content.trim(), {
    message: "Add a link or paste what it says.",
    path: ["content"],
  });

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type LearnRequest = z.infer<typeof LearnRequestSchema>;

/** Turn a zod error into one short sentence for the user. */
export function describeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  return first?.message ?? "The request was not valid.";
}

/**
 * Normalize a model's extraction output: trim, drop empties, cap counts and
 * lengths, lowercase tags. Guards against a model that ignores the limits.
 */
export function cleanExtraction(raw: { title?: unknown; takeaways?: unknown; tags?: unknown }) {
  const strings = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  return {
    title: String(raw.title ?? "").trim().slice(0, 100),
    takeaways: strings(raw.takeaways).slice(0, 6).map((t) => t.slice(0, 300)),
    tags: strings(raw.tags)
      .map((t) => t.toLowerCase().replace(/^#/, "").slice(0, 30))
      .slice(0, 3),
  };
}
