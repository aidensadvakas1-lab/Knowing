/**
 * Prompts and parsing for the bot. Kept free of network calls so they can be
 * tested directly.
 *
 * The bot is a memory tool, not a coach: it saves exactly what a video showed,
 * remembers what the user has mentioned about themselves, and hands both back
 * when asked, so nobody has to save captions or re-explain anything.
 */
import { SAVE_TYPE_LABEL, SAVE_TYPES, type Answer, type BotUser, type Relation, type Save, type SaveDraft, type SaveType, type WatchResult } from "./types";

const RELATIONS: readonly Relation[] = ["none", "related", "duplicate", "alternative"];

export const WATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "topic", "type", "summary", "steps", "details", "needsWords", "reply", "relation", "relatedId"],
  properties: {
    title: { type: "string" },
    topic: { type: "string" },
    type: { type: "string", enum: [...SAVE_TYPES] },
    summary: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    details: { type: "string" },
    needsWords: { type: "boolean" },
    reply: { type: "string" },
    relation: { type: "string", enum: [...RELATIONS] },
    relatedId: { type: "string" },
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
For a game setup, name the map, site, operators or characters and where each goes, including the exact surface (wall, floor, ceiling, hatch, window) and which one. For a drill, give reps, distances and cues.
Only write what you can actually see or hear. If you can't tell where something goes, say that plainly instead of guessing.

Then react in "reply" the way a friend who just watched it with them would, warm and casual, in 1 to 3 short sentences: say in plain words what it is, and point out anything that connects to what they've already saved or told you (same map or skill; it's another way to do something they already saved: say what's different and when each one fits, never as a contradiction; it's basically a duplicate; it covers something they mentioned). Don't coach, don't add advice that isn't in the video, don't push them to start it. Ask a question only when it's basically a duplicate (keep both or replace?). If nothing connects, just say what it is. No "Great video!".
- relation: none, related, duplicate, or alternative (another way to do the same thing as an existing save), compared with their existing saves.
- relatedId: the id of the existing save it duplicates or offers another way to (or relates to most), else "".`;

/** What they've told us and what they've saved, for spotting connections. */
function contextBlock(facts: string[], saves: Save[]): string {
  return `WHAT THEY'VE TOLD YOU: ${facts.length ? facts.join("; ") : "(nothing yet)"}
THEIR EXISTING SAVES:
${saves.slice(0, 100).map((s) => `[id ${s.id}] "${s.title}" (${s.topic || "?"}): ${s.summary} ${s.steps.slice(0, 4).join(" / ")}`).join("\n") || "(none yet)"}`;
}

/** The text that goes before the frames when Claude watches a video. */
export function buildWatchPrompt(input: { caption: string; transcript: string; note: string; frameCount: number; facts?: string[]; saves?: Save[] }): string {
  const parts = [`Someone shared a short video so you'll remember it for them.`];
  if (input.frameCount) parts.push(`The ${input.frameCount} images are frames from across it, in order.`);
  if (input.note) parts.push(`They said: "${input.note}"`);
  if (input.caption) parts.push(`CAPTION:\n${input.caption.slice(0, 2_000)}`);
  parts.push(input.transcript ? `WHAT IS SAID (transcript):\n${input.transcript.slice(0, 15_000)}` : "There is no transcript, so read on-screen text and what happens.");
  parts.push(WATCH_RULES);
  parts.push(contextBlock(input.facts ?? [], input.saves ?? []));
  return parts.join("\n\n");
}

export function buildRewritePrompt(save: Save, words: string): string {
  return `You saved this from a video's frames. Here is what the video actually says. Rewrite the save so it's exact, using what they say. For "reply", say in one sentence what changed.\n\nSAVE:\n${saveText(save)}\n\nWHAT THE VIDEO SAYS:\n${words.slice(0, 8_000)}\n\n${WATCH_RULES}\n\n${contextBlock([], [])}`;
}

/** The person who saved it says part of it is wrong. Their word beats what the frames seemed to show. */
export function buildFixPrompt(save: Save, correction: string): string {
  return `You saved this from a video, and the person who saved it says something in it is wrong. They watched it, so their correction wins over what you saw in the frames. Rewrite the save with the correction applied everywhere it matters (title, steps, details) and keep everything else as it was. For "reply", say in one sentence what changed.\n\nSAVE:\n${saveText(save)}\n\nTHEIR CORRECTION:\n${correction.slice(0, 4_000)}\n\n${WATCH_RULES}\n\n${contextBlock([], [])}`;
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

/** The draft plus the reaction, with ids checked against real saves. */
export function cleanWatch(raw: unknown, saves: Save[], fallbackTitle = "Saved video"): WatchResult {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const relatedId = typeof r.relatedId === "string" && saves.some((s) => s.id === r.relatedId) ? r.relatedId : "";
  const relation = RELATIONS.includes(r.relation as Relation) && relatedId ? (r.relation as Relation) : "none";
  return { draft: cleanDraft(raw, fallbackTitle), reply: str(r.reply, 600), relation, relatedId };
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
/** What retrieval found: saves best first, each with its best passages from the video itself. */
export interface Retrieved {
  save: Save;
  passages: string[];
}

export function buildAskSystem(user: BotUser, saves: Save[], retrieved: Retrieved[], today: string): string {
  const hits = retrieved.map((r) => r.save);
  const passages = new Map(retrieved.map((r) => [r.save.id, r.passages]));
  const mindsets = saves.filter((s) => s.type === "mindset" && !hits.includes(s)).slice(0, 6);
  const rest = saves.filter((s) => !hits.includes(s) && !mindsets.includes(s)).slice(0, 120);
  return `You are Knowing, a memory tool in Telegram. The person shares videos (drills, game setups, study methods, plans, ways of thinking) so they never have to save captions or re-explain things. Later they ask, and you hand back exactly what they saved, plus what they've already told you about themselves. You're not a coach, but you talk like a friendly person who watched these videos with them: warm, relaxed and easy to talk to, while staying quick and exact.

WHAT THEY'VE TOLD YOU ABOUT THEMSELVES (use it so they never repeat themselves):
${user.facts.length ? user.facts.map((f) => `- ${f}`).join("\n") : "(nothing yet)"}

How to answer:
- If a save answers the question, answer from it. Lead with the steps or setup itself, exact details (names, positions, reps). No generic tips on top unless asked.
- If nothing saved matches exactly, don't stop at what's missing: find a way to get them what they need. Adapt the closest save to their situation (take the idea behind the Bank Castle setup and work out how it carries over to Clubhouse), combine pieces from several saves, and fill any gap with what you know. Say in a few words which parts come straight from their videos and which you worked out ("From your Bank video: ... Carried over to Clubhouse: ..."), so they always know what's exact.
- If something in their way (a different map, missing gear, no partner, not enough time) means a save doesn't fit as is, work around it: change the steps so it still works for them.
- If two saves do it differently, don't point out a contradiction. Use both: say when each one fits best, or blend them into one plan.
- Never tell them they're wrong or correct how they named something. Just give them the closest useful thing.
- Help with what they ask, and only that. Don't lecture.
- Telegram chat style: as long as needed and no longer. A numbered list for steps, at most 1 or 2 sentences around it. **bold** is fine; no headings, no tables. Talk like a person, not a report: contractions, short friendly sentences. No long greetings, no hype or motivation speeches, no "great question", no follow-up offers.
- If their message states a lasting fact about them worth remembering (rank, platform, position, school year, schedule, what they're working toward), add a line REMEMBER: <the fact in under 15 words>. One line per new fact.
- Last line, always: SOURCES: the ids of the saves you used, comma separated, or SOURCES: none. Put REMEMBER lines just before it.
Today is ${today}.

THEIR SAVES THAT MATCH THIS QUESTION:
${hits.length ? hits.map((h) => saveText(h) + ((passages.get(h.id) ?? []).length ? `\nExact words from the video:\n${passages.get(h.id)!.map((p) => `> ${p}`).join("\n")}` : "")).join("\n\n") : "(none match)"}
${mindsets.length ? `\nTHEIR SAVED WAYS OF THINKING (use when relevant):\n${mindsets.map(saveText).join("\n\n")}\n` : ""}
EVERYTHING ELSE THEY'VE SAVED (you may use and cite these too):
${rest.map((s) => `[id ${s.id}] "${s.title}" (${s.topic || "?"}) ${s.summary}`).join("\n") || "(nothing)"}`;
}

/** The wrap-up after a scroll session: what they kept and how it connects. */
export function buildWrapUpPrompt(kept: Save[], others: Save[], facts: string[]): string {
  return `Someone just finished scrolling and sent you ${kept.length} videos to keep. Write a short wrap-up the way a friend who watched them too would, warm and casual.

- Start with one line like "From that scroll you kept ${kept.length}:" then one short bullet per video: what it is, and how it fits with what they already had (it adds to a save, it's another way to do one, it fills a gap, it matches something they told you). Use the exact titles and names.
- If a few of them fit together into something they could use (a session, a full setup, a plan), say so in one line at the end.
- No coaching, no pushing them to start, no questions, no advice that isn't in the videos. Under 90 words. **bold** is fine; no headings.

WHAT THEY KEPT:
${kept.map(saveText).join("\n\n")}

${contextBlock(facts, others)}`;
}

/** Split Claude's reply into the visible text and the trailing control lines. */
export function parseAnswer(raw: string, knownIds: string[]): Answer {
  const m = raw.match(/^SOURCES:\s*(.+)$/m);
  const sources = (m?.[1] ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((id) => knownIds.includes(id));
  const remember = [...raw.matchAll(/^REMEMBER:\s*(.+)$/gm)].map((x) => (x[1] ?? "").trim().slice(0, 160)).filter(Boolean);
  const text = raw.replace(/\n?^(?:REMEMBER|SOURCES):[\s\S]*$/m, "").trim();
  return { text, sources: [...new Set(sources)], remember };
}
