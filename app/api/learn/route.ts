/**
 * POST /api/learn
 *
 * Turns a taught item into something Knowing can use:
 * 1. If no text was pasted, fetch it from the link (YouTube transcript,
 *    TikTok caption, or the article's text).
 * 2. Ask a fast model for a title, takeaways and tags.
 *
 * For an uploaded video, the browser sends its transcript as `content` plus a
 * few frames, and a stronger model watches it: takeaways, an assessment of
 * how useful it is, and notes on what the frames show.
 *
 * Both steps fail soft. If the AI step fails, the item is still returned with
 * its text and a warning, so nothing the user typed is lost.
 */
import { MODELS } from "@/lib/constants";
import { fetchSource } from "@/lib/fetch-source";
import { buildExtractionPrompt, buildVideoPrompt, EXTRACTION_SCHEMA, VIDEO_EXTRACTION_SCHEMA } from "@/lib/prompt";
import type Anthropic from "@anthropic-ai/sdk";
import { apiError, getAnthropic, guardAiRoute } from "@/lib/server";
import type { LearnResponse, SourceOrigin } from "@/lib/types";
import { cleanExtraction, describeZodError, LearnRequestSchema, type LearnRequest } from "@/lib/validate";
import { formatTimestamp } from "@/lib/video-math";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
  const parsed = LearnRequestSchema.safeParse(body);
  if (!parsed.success) return apiError("bad_request", describeZodError(parsed.error));
  const input = parsed.data;

  // Step 1: get the text.
  const isVideo = input.frames.length > 0;
  let content = input.content.trim();
  let origin: SourceOrigin = isVideo ? "video-upload" : "pasted";
  let fetchedTitle = "";
  let warning: string | undefined;
  if (!content && !isVideo && input.url.trim()) {
    const fetched = await fetchSource(input.url);
    content = fetched.text;
    origin = fetched.origin;
    fetchedTitle = fetched.title;
    warning = fetched.warning;
  }
  if (!content && !isVideo) {
    return apiError("bad_request", warning ?? "Nothing to learn from. Paste what it says.");
  }

  // Step 2: pull out the key points.
  const fallbackTitle = input.title.trim() || fetchedTitle || content.slice(0, 60) || "Uploaded video";
  try {
    const response = await getAnthropic().messages.create(
      isVideo
        ? {
            model: MODELS.video,
            max_tokens: 4_000,
            output_config: { format: { type: "json_schema", schema: VIDEO_EXTRACTION_SCHEMA } },
            messages: [{ role: "user", content: videoContent(input, content) }],
          }
        : {
            model: MODELS.extract,
            max_tokens: 2_000,
            output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
            messages: [{ role: "user", content: buildExtractionPrompt({ ...input, content }) }],
          },
    );
    if (response.stop_reason === "refusal") throw new Error("refused");
    const textBlock = response.content.find((b) => b.type === "text");
    const extracted = cleanExtraction(JSON.parse(textBlock?.type === "text" ? textBlock.text : "{}"));
    if (isVideo && extracted.visualNotes) {
      content = [content, `What the video shows: ${extracted.visualNotes}`].filter(Boolean).join("\n\n");
    }
    const result: LearnResponse = {
      title: input.title.trim() || extracted.title || fallbackTitle,
      takeaways: extracted.takeaways,
      tags: extracted.tags,
      assessment: extracted.assessment || undefined,
      content,
      origin,
      warning,
    };
    return Response.json(result);
  } catch (error) {
    console.error("Extraction failed", error);
    const result: LearnResponse = {
      title: fallbackTitle,
      takeaways: [],
      tags: [],
      content,
      origin,
      warning: isVideo
        ? "Saved the transcript, but Claude couldn't watch the video. Try again in a moment."
        : "Saved, but the key points couldn't be pulled out. It will still use the full text.",
    };
    return Response.json(result);
  }
}

/** The prompt text followed by each frame, labeled with its timestamp. */
function videoContent(input: LearnRequest, transcript: string): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: buildVideoPrompt({ ...input, content: transcript, frameTimes: input.frames.map((f) => f.at) }) },
  ];
  for (const frame of input.frames) {
    blocks.push({ type: "text", text: `Frame at ${formatTimestamp(frame.at)}:` });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } });
  }
  return blocks;
}
