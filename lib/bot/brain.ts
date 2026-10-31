/**
 * The bot's Claude calls: watch a video into a save, and answer questions
 * from saves. Watching uses MODELS.watch (Sonnet by default: it happens once
 * per video and has to read the details right). Answering uses MODELS.bot
 * (Sonnet by default too, so it knows the topic; Haiku makes answers almost free).
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
  if (response.stop_reason === "refusal" && model !== MODELS.fallback) return watchJson(content, MODELS.fallback);
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
      const system = buildAskSystem(user, saves, retrieved, today(), { name, memories });
      const ask = (model: string) =>
        getAnthropic().messages.create({
          model,
          // Thinking counts toward this too, and a cut-off answer loses its SOURCES line.
          max_tokens: 8_000,
          // Chat needs knowledge more than long thinking, and low effort keeps replies quick.
          output_config: { effort: "low" },
          system,
          messages: [...history, { role: "user", content: question }],
        });
      let response = await ask(MODELS.bot);
      // A safety filter can misfire on a harmless chat too; the cheap model gets a second look.
      if (response.stop_reason === "refusal" && MODELS.bot !== MODELS.fallback) response = await ask(MODELS.fallback);
      if (response.stop_reason === "refusal") throw new Error("refused");
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return parseAnswer(text, saves.map((s) => s.id));
    },

    async wrapUp({ kept, others, facts }) {
      const response = await getAnthropic().messages.create({
        model: MODELS.bot,
        max_tokens: 8_000,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: buildWrapUpPrompt(kept, others, facts) }],
      });
      if (response.stop_reason === "refusal") throw new Error("refused");
      return response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    },
  };
}
