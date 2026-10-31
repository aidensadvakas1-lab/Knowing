/**
 * The bot's Claude calls: watch a video into a save, and answer questions
 * from saves. Watching uses MODELS.watch (Sonnet by default: it happens once
 * per video and has to read the details right). Answering uses MODELS.bot
 * (Haiku by default, to stay cheap).
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../constants";
import { getAnthropic } from "../server";
import { buildAskSystem, buildFixPrompt, buildRewritePrompt, buildWatchPrompt, buildWrapUpPrompt, cleanDraft, cleanWatch, frameLabel, parseAnswer, WATCH_SCHEMA } from "./prompts";
import type { Brain } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

async function watchJson(content: Anthropic.ContentBlockParam[], model: string = MODELS.watch): Promise<unknown> {
  const response = await getAnthropic().messages.create({
    model,
    max_tokens: 16_000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: WATCH_SCHEMA } },
    messages: [{ role: "user", content }],
  });
  // A gaming clip can trip the strong model's safety filter by mistake; the cheap model gets a second look.
  if (response.stop_reason === "refusal" && model !== MODELS.bot) return watchJson(content, MODELS.bot);
  if (response.stop_reason === "refusal") throw new Error("refused");
  const text = response.content.find((b) => b.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "{}");
}

export function createBrain(): Brain {
  return {
    async watch({ frames, frameTimes, transcript, caption, note, facts, saves }) {
      const content: Anthropic.ContentBlockParam[] = [
        { type: "text", text: buildWatchPrompt({ caption, transcript, note, frameCount: frames.length, facts, saves }) },
      ];
      for (const [i, data] of frames.entries()) {
        content.push({ type: "text", text: frameLabel(i, frameTimes?.[i]) });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
      }
      return cleanWatch(await watchJson(content), saves, caption.slice(0, 60) || "Saved video");
    },

    async rewrite(save, text, kind = "words") {
      const prompt = kind === "fix" ? buildFixPrompt(save, text) : buildRewritePrompt(save, text);
      return cleanDraft(await watchJson([{ type: "text", text: prompt }]), save.title);
    },

    async answer({ user, question, saves, retrieved, name, memories }) {
      const history: Anthropic.MessageParam[] = user.turns.map((t) => ({ role: t.role, content: t.content }));
      while (history.length && history[0]?.role !== "user") history.shift();
      const response = await getAnthropic().messages.create({
        model: MODELS.bot,
        max_tokens: 2_000,
        system: buildAskSystem(user, saves, retrieved, today(), { name, memories }),
        messages: [...history, { role: "user", content: question }],
      });
      if (response.stop_reason === "refusal") throw new Error("refused");
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return parseAnswer(text, saves.map((s) => s.id));
    },

    async wrapUp({ kept, others, facts }) {
      const response = await getAnthropic().messages.create({
        model: MODELS.bot,
        max_tokens: 2_000,
        messages: [{ role: "user", content: buildWrapUpPrompt(kept, others, facts) }],
      });
      if (response.stop_reason === "refusal") throw new Error("refused");
      return response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    },
  };
}
