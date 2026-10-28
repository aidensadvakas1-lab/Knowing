/**
 * Request validation for the API routes.
 *
 * Every body that reaches the server is parsed with these schemas first, so
 * route handlers only ever see well-formed, size-limited data.
 */
import { z } from "zod";
import { IMAGE_TYPES } from "./attachments";
import { ATTACHMENTS, ITEM_KINDS, LIMITS, VIDEO } from "./constants";

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
  assessment: z.string().max(1_000).optional(),
  createdAt: z.number().nonnegative(),
});

export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(LIMITS.messageChars * 4),
});

const base64 = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+=*$/, "Attachments must be base64 data.");

/** A file attached to the newest chat message with the + button. */
export const ChatAttachmentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    name: z.string().max(300),
    mediaType: z.enum(IMAGE_TYPES),
    data: base64(ATTACHMENTS.totalBinaryChars),
  }),
  z.object({ type: z.literal("pdf"), name: z.string().max(300), data: base64(ATTACHMENTS.totalBinaryChars) }),
  z.object({ type: z.literal("text"), name: z.string().max(300), text: z.string().max(ATTACHMENTS.textChars) }),
]);

/** Body of `POST /api/chat`. */
export const ChatRequestSchema = z
  .object({
    profile: ProfileSchema.partial().default({}),
    items: z.array(KnowledgeItemSchema).max(LIMITS.items).default([]),
    messages: z.array(ChatTurnSchema).min(1).max(LIMITS.chatTurnsKept * 2),
    /** Files attached to the last message. */
    attachments: z.array(ChatAttachmentSchema).max(ATTACHMENTS.max).default([]),
  })
  .refine((body) => body.messages.at(-1)?.role === "user", {
    message: "The last message must be from the user.",
    path: ["messages"],
  })
  .refine((body) => (body.messages.at(-1)?.content.length ?? 0) <= LIMITS.messageChars, {
    message: `Messages can be at most ${LIMITS.messageChars} characters.`,
    path: ["messages"],
  })
  .refine(
    (body) =>
      body.attachments.reduce((sum, a) => sum + (a.type === "text" ? 0 : a.data.length), 0) <= ATTACHMENTS.totalBinaryChars,
    { message: "Those files are too big to send together. Attach fewer or smaller files.", path: ["attachments"] },
  );

/** One frame of an uploaded video: seconds in, and base64 JPEG data. */
export const FrameSchema = z.object({
  at: z.number().nonnegative(),
  data: z
    .string()
    .min(1)
    .max(VIDEO.frameChars)
    .regex(/^[A-Za-z0-9+/]+=*$/, "Frames must be base64 JPEG data."),
});

/** Body of `POST /api/learn`. Needs a link, some content, video frames, or a mix. */
export const LearnRequestSchema = z
  .object({
    kind: z.enum(ITEM_KINDS as [string, ...string[]]).transform((k) => k as (typeof ITEM_KINDS)[number]),
    title: text(300),
    url: text(2_000),
    content: text(LIMITS.itemContentChars),
    goal: text(4_000),
    /** Frames from an uploaded video. When present, `content` is its transcript. */
    frames: z.array(FrameSchema).max(VIDEO.frames).default([]),
    /** Length of the uploaded video in seconds. */
    durationSec: z.number().nonnegative().max(VIDEO.maxDurationSec * 2).optional(),
  })
  .refine((b) => b.url.trim() || b.content.trim() || b.frames.length > 0, {
    message: "Add a link, a video, or paste what it says.",
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
export function cleanExtraction(raw: { title?: unknown; takeaways?: unknown; tags?: unknown; assessment?: unknown; visualNotes?: unknown }) {
  const strings = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  return {
    title: String(raw.title ?? "").trim().slice(0, 100),
    takeaways: strings(raw.takeaways).slice(0, 6).map((t) => t.slice(0, 300)),
    tags: strings(raw.tags)
      .map((t) => t.toLowerCase().replace(/^#/, "").slice(0, 30))
      .slice(0, 3),
    assessment: String(raw.assessment ?? "").trim().slice(0, 1_000),
    visualNotes: String(raw.visualNotes ?? "").trim().slice(0, 4_000),
  };
}
