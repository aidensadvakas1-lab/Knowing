/**
 * The bot's Claude calls: watch a video into a save, and answer questions
 * from saves. Uses MODELS.bot (Claude Haiku by default, to stay cheap).
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../constants";
import { getAnthropic } from "../server";
import { buildAskSystem, buildRewritePrompt, buildWatchPrompt, cleanDraft, parseAnswer, WATCH_SCHEMA } from "./prompts";
import type { Brain, SaveDraft } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

async function draftFrom(content: Anthropic.ContentBlockParam[], fallbackTitle: string): Promise<SaveDraft> {
  const response = await getAnthropic().messages.create({
    model: MODELS.bot,
    max_tokens: 4_000,
    output_config: { format: { type: "json_schema", schema: WATCH_SCHEMA } },
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("refused");
  const text = response.content.find((b) => b.type === "text");
  return cleanDraft(JSON.parse(text?.type === "text" ? text.text : "{}"), fallbackTitle);
}

export function createBrain(): Brain {
  return {
    async watch({ frames, transcript, caption, note }) {
      const content: Anthropic.ContentBlockParam[] = [
        { type: "text", text: buildWatchPrompt({ caption, transcript, note, frameCount: frames.length }) },
        ...frames.map((data): Anthropic.ContentBlockParam => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
      ];
      return draftFrom(content, caption.slice(0, 60) || "Saved video");
    },

    async rewrite(save, words) {
      return draftFrom([{ type: "text", text: buildRewritePrompt(save, words) }], save.title);
    },

    async answer({ user, question, saves }) {
      const history: Anthropic.MessageParam[] = user.turns.slice(-8).map((t) => ({ role: t.role, content: t.content }));
      while (history.length && history[0]?.role !== "user") history.shift();
      const response = await getAnthropic().messages.create({
        model: MODELS.bot,
        max_tokens: 2_000,
        system: buildAskSystem(user, saves, question, today()),
        messages: [...history, { role: "user", content: question }],
      });
      if (response.stop_reason === "refusal") throw new Error("refused");
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return parseAnswer(text, saves.map((s) => s.id));
    },
  };
}
