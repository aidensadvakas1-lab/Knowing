/**
 * The bot's Claude calls: watch a video into a save, and answer questions
 * from saves. Watching uses MODELS.watch (Sonnet by default: it happens once
 * per video and has to read the details right). Answering uses MODELS.bot
 * (Sonnet by default too, so it knows the topic; Haiku makes answers almost free),
 * thinking at BOT_EFFORT so it can troubleshoot a tutorial step by step.
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { BOT_EFFORT, MODELS } from "../constants";
import { getAnthropic } from "../server";
import { ANSWER_MAX_TOKENS, QUESTION_CHARS, REWRITE_MAX_TOKENS, WATCH_MAX_TOKENS, WRAPUP_MAX_TOKENS } from "./costs";
import { buildAskSystem, buildFixPrompt, buildRewritePrompt, buildWatchPrompt, buildWrapUpPrompt, cleanDraft, cleanWatch, frameLabel, parseAnswer, recentHistory, WATCH_SCHEMA } from "./prompts";
import type { Brain } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

/** Said when an answer used up its room thinking before it wrote anything. */
export const NO_ROOM = "That one needed more room than I have for a single answer. Could you ask it in smaller parts?";

async function watchJson(content: Anthropic.ContentBlockParam[], maxTokens: number, model: string = MODELS.watch): Promise<unknown> {
  const response = await getAnthropic().messages.create({
    model,
    // Thinking counts toward this too. A cap per call keeps the worst case of each video known (costs.ts).
    max_tokens: maxTokens,
    output_config: { effort: "medium", format: { type: "json_schema", schema: WATCH_SCHEMA } },
    messages: [{ role: "user", content }],
  });
  // A gaming clip can trip the strong model's safety filter by mistake; the cheap model gets a second look.
  if (response.stop_reason === "refusal" && model !== MODELS.fallback) return watchJson(content, maxTokens, MODELS.fallback);
  if (response.stop_reason === "refusal") throw new Error("refused");
  const text = response.content.find((b) => b.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "{}");
}

export function createBrain(): Brain {
  return {
    async watch({ frames, frameTimes, transcript, screenText, caption, note, facts, saves }) {
      const content: Anthropic.ContentBlockParam[] = [
        { type: "text", text: buildWatchPrompt({ caption, transcript, screenText, note, frameCount: frames.length, facts, saves }) },
      ];
      for (const [i, data] of frames.entries()) {
        content.push({ type: "text", text: frameLabel(i, frameTimes?.[i]) });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
      }
      return cleanWatch(await watchJson(content, WATCH_MAX_TOKENS), saves, caption.slice(0, 60) || "Saved video");
    },

    async rewrite(save, text, kind = "words") {
      const prompt = kind === "fix" ? buildFixPrompt(save, text) : buildRewritePrompt(save, text);
      return cleanDraft(await watchJson([{ type: "text", text: prompt }], REWRITE_MAX_TOKENS), save.title);
    },

    async answer({ user, question, saves, retrieved, name, memories, usage }) {
      const history = recentHistory(user.turns);
      const system = buildAskSystem(user, saves, retrieved, today(), { name, memories, usage });
      const ask = (model: string) =>
        getAnthropic().messages.create({
          model,
          // Thinking counts toward this too. Capped so a question's worst case stays known (costs.ts).
          max_tokens: ANSWER_MAX_TOKENS,
          // Medium by default: enough thinking to read an error and find the real fix.
          output_config: { effort: BOT_EFFORT },
          system,
          messages: [...history, { role: "user", content: question.slice(0, QUESTION_CHARS) }],
        });
      let response = await ask(MODELS.bot);
      // A safety filter can misfire on a harmless chat too; the cheap model gets a second look.
      if (response.stop_reason === "refusal" && MODELS.bot !== MODELS.fallback) response = await ask(MODELS.fallback);
      if (response.stop_reason === "refusal") throw new Error("refused");
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (!text.trim() && response.stop_reason === "max_tokens") return parseAnswer(`${NO_ROOM}\nSOURCES: none`, []);
      return parseAnswer(text, saves.map((s) => s.id));
    },

    async wrapUp({ kept, others, facts }) {
      const response = await getAnthropic().messages.create({
        model: MODELS.bot,
        max_tokens: WRAPUP_MAX_TOKENS,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: buildWrapUpPrompt(kept, others, facts) }],
      });
      if (response.stop_reason === "refusal") throw new Error("refused");
      return response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    },
  };
}
