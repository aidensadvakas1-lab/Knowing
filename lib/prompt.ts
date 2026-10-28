/**
 * Prompt builders. Pure functions so they can be unit tested and so the
 * client never decides what the model is told.
 */
import { DEFAULT_GOAL, KIND_LABEL, LIMITS } from "./constants";
import type { ItemKind, KnowledgeItem, Profile } from "./types";

const NOT_FILLED = "(not filled in yet)";

/** Format an epoch-ms timestamp as YYYY-MM-DD, or "" when missing. */
export function isoDate(epochMs: number | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "";
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** The user's goal, or the default goal when they have not written one. */
export function effectiveGoal(profile: Partial<Profile> | undefined): string {
  return profile?.goal?.trim() || DEFAULT_GOAL;
}

/** Render the profile as labeled lines for the system prompt. */
export function profileToText(profile: Partial<Profile> | undefined): string {
  const p = profile ?? {};
  return [
    `Where they are now: ${p.now?.trim() || NOT_FILLED}`,
    `Main goal: ${effectiveGoal(p)}`,
    `Skills and experience: ${p.skills?.trim() || NOT_FILLED}`,
    `Time each week: ${p.time?.trim() || NOT_FILLED}`,
    `Other context: ${p.more?.trim() || "(none)"}`,
  ].join("\n");
}

/** Render one taught item as a Markdown block for the system prompt. */
export function itemToText(item: KnowledgeItem): string {
  const source = [KIND_LABEL[item.kind] ?? "Note", item.url, item.createdAt && `added ${isoDate(item.createdAt)}`]
    .filter(Boolean)
    .join(", ");
  let block = `### ${item.title || "Untitled"} (${source})\n`;
  if (item.takeaways.length) {
    block += "Key points:\n" + item.takeaways.map((t) => `- ${t}`).join("\n") + "\n";
  }
  if (item.content) {
    block += `Their notes or transcript: ${item.content.slice(0, LIMITS.itemContentInPrompt)}\n`;
  }
  return block;
}

/**
 * Render everything the user has taught, newest first, until the character
 * budget runs out. Older items are dropped first when the budget is tight.
 */
export function knowledgeToText(items: KnowledgeItem[], budget: number = LIMITS.knowledgeBudgetChars): string {
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  let out = "";
  let remaining = budget;
  for (const item of sorted) {
    const block = itemToText(item);
    if (block.length > remaining) break;
    out += block + "\n";
    remaining -= block.length;
  }
  return out.trim() || "(Nothing yet. They have not taught you anything.)";
}

/** Build the chat system prompt from the profile and taught knowledge. */
export function buildSystemPrompt(profile: Partial<Profile> | undefined, items: KnowledgeItem[], today = new Date()): string {
  return `You are Knowing, a personal goal coach that this person built and teaches by sending you videos, TikToks and notes. Your job is to give advice and roadmaps made for THIS person, not generic tips.

How to answer:
- Start from their profile below. Refer to their real situation, time and skills.
- Use what they taught you. When an answer draws on one of their saved items, name it by its title. If a saved item gives weak or risky advice, say so plainly.
- Be concrete: specific courses, projects, numbers, time frames and next actions. A roadmap has phases with time frames and a clear first step for this week.
- Skip generic filler like "stay consistent" or "network more" unless you say exactly how.
- If missing information would change your answer a lot, give your best answer first, then ask one short question.
- Keep it scannable: short paragraphs, bullet lists, and short headings for longer answers.
- Today's date is ${isoDate(today.getTime())}.

PROFILE
${profileToText(profile)}

WHAT THEY HAVE TAUGHT YOU (newest first)
${knowledgeToText(items)}`;
}

/** Input for {@link buildExtractionPrompt}. */
export interface ExtractionInput {
  kind: ItemKind;
  title: string;
  url: string;
  content: string;
  goal: string;
}

/** Build the prompt that pulls a title, takeaways and tags out of a taught item. */
export function buildExtractionPrompt(input: ExtractionInput): string {
  return `Someone saved this to teach their personal goal coach. Their goal: ${input.goal || DEFAULT_GOAL}

Pull out a short title (max 8 words), 3 to 5 concrete takeaways (each under 25 words, written as advice they can act on), and 1 to 3 short lowercase topic tags.

Type: ${KIND_LABEL[input.kind]}
Link: ${input.url || "(none)"}
Title they gave: ${input.title || "(none)"}
Content:
${input.content.slice(0, LIMITS.itemContentChars)}`;
}

/** JSON schema the extraction model must follow (structured outputs). */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "takeaways", "tags"],
  properties: {
    title: { type: "string" },
    takeaways: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
  },
} as const;
