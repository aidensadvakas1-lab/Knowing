/**
 * Prompts and parsing for the bot. Kept free of network calls so they can be
 * tested directly.
 *
 * The bot's whole point: answer from the user's own saved videos and goal,
 * exactly, instead of the generic answer any AI would give. The goal is a
 * direction, not a cage: when a question pulls against it, the bot names the
 * tradeoff and offers to keep, switch or combine goals.
 */
import { SAVE_TYPE_LABEL, SAVE_TYPES, type Answer, type BotUser, type Save, type SaveDraft, type SaveType } from "./types";

export const WATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "topic", "type", "summary", "steps", "details", "needsWords"],
  properties: {
    title: { type: "string" },
    topic: { type: "string" },
    type: { type: "string", enum: [...SAVE_TYPES] },
    summary: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    details: { type: "string" },
    needsWords: { type: "boolean" },
  },
} as const;

const WATCH_RULES = `Record what it actually teaches, with every specific detail it shows or says, so a later question like "what was that setup / drill / plan?" gets THIS one back, not a generic answer. Don't add advice that isn't in it.

- title: what it teaches, max 8 words, specific ("Bank basement: lockers + CCTV setup", "Split dodge to weak hand").
- topic: the subject, then the specific part ("Siege, Bank", "Lacrosse, Dodging", "SAT, Reading", "Business, Mindset").
- type: drill (something to practice), setup (a configuration to copy), plan (a schedule or routine), tip (one trick), mindset (a way of seeing things: a belief, an argument or big-picture strategy about career, money, life or a skill), info (facts).
- summary: one sentence, what it is and when to use it.
- steps: the exact steps or key claims in order, each short and specific: names, positions, numbers, reps, timings. 2 to 10.
- details: everything else worth remembering, exact specifics, up to 300 words.
- needsWords: true only if someone is clearly talking, important details are only spoken, and there is no transcript below.
For a game setup, name the map, site, operators or characters and where each goes. For a drill, give reps, distances and cues.`;

/** The text that goes before the frames when Claude watches a video. */
export function buildWatchPrompt(input: { caption: string; transcript: string; note: string; frameCount: number }): string {
  const parts = [`Someone shared a short video so you'll remember it for them.`];
  if (input.frameCount) parts.push(`The ${input.frameCount} images are frames from across it, in order.`);
  if (input.note) parts.push(`They said: "${input.note}"`);
  if (input.caption) parts.push(`CAPTION:\n${input.caption.slice(0, 2_000)}`);
  parts.push(input.transcript ? `WHAT IS SAID (transcript):\n${input.transcript.slice(0, 15_000)}` : "There is no transcript, so read on-screen text and what happens.");
  parts.push(WATCH_RULES);
  return parts.join("\n\n");
}

export function buildRewritePrompt(save: Save, words: string): string {
  return `You saved this from a video's frames. Here is what the video actually says. Rewrite the save so it's exact, using what they say.\n\nSAVE:\n${saveText(save)}\n\nWHAT THE VIDEO SAYS:\n${words.slice(0, 8_000)}\n\n${WATCH_RULES}`;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Trim and cap whatever Claude returned into a valid draft. */
export function cleanDraft(raw: unknown, fallbackTitle = "Saved video"): SaveDraft {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const type = SAVE_TYPES.includes(r.type as SaveType) ? (r.type as SaveType) : "info";
  return {
    title: str(r.title, 100) || fallbackTitle,
    topic: str(r.topic, 60),
    type,
    summary: str(r.summary, 240),
    steps: (Array.isArray(r.steps) ? r.steps : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 12),
    details: str(r.details, 3_000),
    needsWords: r.needsWords === true,
  };
}

/** A save as Claude sees it when answering. */
export function saveText(s: Save): string {
  return `[id ${s.id}] "${s.title}" (${s.topic || "no topic"}, ${SAVE_TYPE_LABEL[s.type]})
Steps:
${s.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}
Details: ${s.details}${s.words ? `\nWhat the video says: ${s.words}` : ""}`;
}

const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** Saves that share words with the question, best match first. */
export function relevantSaves(saves: Save[], query: string, limit = 6): Save[] {
  const q = words(query);
  if (!q.size) return [];
  return saves
    .map((s) => {
      const w = words([s.topic, s.title, s.summary, s.steps.join(" "), s.details, s.words].join(" "));
      let score = 0;
      q.forEach((x) => {
        if (w.has(x)) score++;
      });
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** The instructions for answering a question, with the saves it may draw on. */
export function buildAskSystem(user: BotUser, saves: Save[], question: string, today: string): string {
  const recent = user.turns.slice(-4).map((t) => t.content).join(" ");
  const hits = relevantSaves(saves, `${question} ${recent}`);
  const mindsets = saves.filter((s) => s.type === "mindset" && !hits.includes(s)).slice(0, 6);
  const rest = saves.filter((s) => !hits.includes(s) && !mindsets.includes(s)).slice(0, 120);
  return `You are Knowing, a Telegram bot. The person shares videos with you (drills, game setups, study methods, plans, ways of thinking) so you remember them, then asks about them later. Your whole value: you answer from THEIR goal and THEIR saved videos, exactly, instead of the generic answer any AI would give.

THEIR MAIN GOAL: ${user.goal || "(not set yet)"}

How to answer:
- If a save answers the question, answer from it. Lead with the steps or setup itself, exact details (names, positions, reps). Don't pile generic tips on top unless asked.
- Match exactly. If they ask about Clubhouse and the save is for Bank, say so plainly, then offer general advice clearly marked as general.
- If nothing saved fits, say "Nothing saved on that yet." in one line, then give a short general answer.
- Their goal is a direction, not a cage, and they're allowed to change course. When a question pulls against the goal (e.g. the goal is business and they ask about a college path), be upfront in 2 to 4 sentences: how it conflicts, what they'd gain, what they'd sacrifice (time, money, years, focus), and what their saved videos argued. Then actually help with what they asked. No lecturing, no refusing. Then add the lines SWITCH: <the goal if they went this way, under 15 words> and BOTH: <one goal combining both paths, under 15 words>.
- If the question fits their goal, don't add SWITCH or BOTH.
- If no goal is set and they state one, add GOAL: <their goal in under 15 words>.
- Telegram chat style: short. A numbered list for steps, 1 or 2 sentences around it. **bold** is fine; no headings, no tables. No greetings, no "great question", no closing offers.
- Last line, always: SOURCES: the ids of the saves you used, comma separated, or SOURCES: none. Put any GOAL, SWITCH or BOTH lines just before it.
Today is ${today}.

THEIR SAVES THAT MATCH THIS QUESTION:
${hits.length ? hits.map(saveText).join("\n\n") : "(none match)"}
${mindsets.length ? `\nTHEIR SAVED WAYS OF THINKING (use when relevant to the goal):\n${mindsets.map(saveText).join("\n\n")}\n` : ""}
EVERYTHING ELSE THEY'VE SAVED (you may use and cite these too):
${rest.map((s) => `[id ${s.id}] "${s.title}" (${s.topic || "?"}) ${s.summary}`).join("\n") || "(nothing)"}`;
}

/** Split Claude's reply into the visible text and the trailing control lines. */
export function parseAnswer(raw: string, knownIds: string[]): Answer {
  const line = (key: string) => {
    const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1] ? m[1].trim().slice(0, 160) : "";
  };
  const sources = line("SOURCES")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((id) => knownIds.includes(id));
  const text = raw.replace(/\n?^(?:GOAL|SWITCH|BOTH|SOURCES):[\s\S]*$/m, "").trim();
  return { text, sources: [...new Set(sources)], goal: line("GOAL"), switchTo: line("SWITCH"), both: line("BOTH") };
}
