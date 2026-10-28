"use client";
/**
 * Teach tab: add a TikTok, video, article or note. Paste a link and Knowing
 * fetches what it can (YouTube transcript, TikTok caption, article text), or
 * upload a video file and Knowing watches it: it hears the speech and looks
 * at frames. Then it pulls out the key points. Lists everything it has learned.
 */
import { useRef, useState, type FormEvent } from "react";
import { ApiError, learn, transcribe } from "@/lib/api-client";
import { ITEM_KINDS, KIND_LABEL, LIMITS } from "@/lib/constants";
import { effectiveGoal } from "@/lib/prompt";
import { parseHttpUrl, suggestKind } from "@/lib/sources";
import { newId } from "@/lib/storage";
import type { KnowingState } from "@/hooks/useKnowing";
import type { ItemKind, KnowledgeItem } from "@/lib/types";
import { checkVideo, extractAudio, extractFrames, VideoError } from "@/lib/video";
import { formatTimestamp } from "@/lib/video-math";

export function TeachView({ state }: { state: KnowingState }) {
  const { items, addItem, updateItem, deleteItem, profile, password, health } = state;
  const [kind, setKind] = useState<ItemKind>("tiktok");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function onVideoChange(file: File | null) {
    setVideo(file);
    if (file && kind !== "tiktok") setKind("video");
  }

  function clearVideo() {
    setVideo(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  /** Preselect the type when a recognizable link is pasted. */
  function onUrlChange(value: string) {
    setUrl(value);
    const suggested = suggestKind(value);
    if (suggested) setKind(suggested);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (video) return teachVideo(video);
    const link = url.trim();
    const text = content.trim();
    if (!link && !text) return setStatus("Paste a link or what it says first.");
    if (link && !parseHttpUrl(link)) return setStatus("That link doesn't look right. It should start with https://");

    setBusy(true);
    setStatus(text ? "Reading it…" : "Fetching the link…");
    const id = newId();
    const draft: KnowledgeItem = {
      id,
      kind,
      title: title.trim() || text.slice(0, 60) || link.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60),
      url: link,
      content: text.slice(0, LIMITS.itemContentChars),
      takeaways: [],
      tags: [],
      status: "reading",
      createdAt: Date.now(),
    };
    if (!addItem(draft)) {
      setBusy(false);
      return setStatus("Storage is full. Delete some items first.");
    }
    setTitle("");
    setUrl("");
    setContent("");

    try {
      const result = await learn({ kind, title: title.trim(), url: link, content: text, goal: effectiveGoal(profile) }, password);
      updateItem(id, {
        title: result.title,
        content: result.content.slice(0, LIMITS.itemContentChars),
        takeaways: result.takeaways,
        tags: result.tags,
        status: result.takeaways.length ? "done" : "saved",
      });
      setStatus(result.warning ?? "Learned it.");
    } catch (error) {
      if (text) {
        updateItem(id, { status: "saved" });
        setStatus(`Saved your notes. ${error instanceof ApiError ? error.message : "Couldn't reach the server."}`);
      } else {
        deleteItem(id);
        setUrl(link);
        setStatus(error instanceof ApiError ? error.message : "Couldn't reach the server. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Watch an uploaded video: grab frames, transcribe the speech chunk by chunk,
   * then send both to the server so Claude can assess the whole thing.
   */
  async function teachVideo(file: File) {
    const link = url.trim();
    const notes = content.trim();
    if (link && !parseHttpUrl(link)) return setStatus("That link doesn't look right. It should start with https://");

    setBusy(true);
    let id: string | null = null;
    try {
      setStatus("Opening the video…");
      const durationSec = await checkVideo(file);

      id = newId();
      const draft: KnowledgeItem = {
        id,
        kind,
        title: title.trim() || file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Uploaded video",
        url: link,
        content: notes.slice(0, LIMITS.itemContentChars),
        takeaways: [],
        tags: [],
        status: "reading",
        createdAt: Date.now(),
      };
      if (!addItem(draft)) {
        id = null;
        return setStatus("Storage is full. Delete some items first.");
      }

      setStatus("Looking at the video…");
      const frames = await extractFrames(file);

      let transcript = "";
      let hearingNote = "";
      if (health?.transcriptionConfigured) {
        setStatus("Pulling out the audio…");
        const chunks = await extractAudio(file);
        if (chunks.length === 0) hearingNote = "No speech found, so it watched the frames only.";
        const lines: string[] = [];
        for (const [i, chunk] of chunks.entries()) {
          setStatus(chunks.length > 1 ? `Listening… part ${i + 1} of ${chunks.length}` : "Listening…");
          try {
            const text = await transcribe(chunk.wav, password);
            if (text) lines.push(`[${formatTimestamp(chunk.start)}] ${text}`);
          } catch (error) {
            hearingNote = `Couldn't hear all of it: ${error instanceof ApiError ? error.message : "the server didn't answer."}`;
            if (error instanceof ApiError && (error.code === "not_configured" || error.code === "unauthorized")) break;
          }
        }
        transcript = lines.join("\n");
      } else {
        hearingNote = "The server can't hear audio yet (no OPENAI_API_KEY), so it watched the frames only.";
      }
      if (!frames.length && !transcript) throw new VideoError("Couldn't get any frames or speech out of that video.");

      const combined = [transcript, notes && `Their own notes: ${notes}`].filter(Boolean).join("\n\n");
      setStatus("Watching it…");
      const result = await learn(
        {
          kind,
          title: title.trim(),
          url: link,
          content: combined.slice(0, LIMITS.itemContentChars),
          goal: effectiveGoal(profile),
          frames,
          durationSec,
        },
        password,
      );
      updateItem(id, {
        title: result.title,
        content: result.content.slice(0, LIMITS.itemContentChars),
        takeaways: result.takeaways,
        tags: result.tags,
        assessment: result.assessment,
        status: result.takeaways.length ? "done" : "saved",
      });
      setTitle("");
      setUrl("");
      setContent("");
      clearVideo();
      setStatus([result.warning ?? "Watched it.", hearingNote].filter(Boolean).join(" "));
    } catch (error) {
      if (id) deleteItem(id);
      setStatus(
        error instanceof VideoError || error instanceof ApiError
          ? error.message
          : "Couldn't process that video. Try a shorter clip or a different browser.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="view" aria-label="Teach">
      <div className="scroll">
        <div className="stack">
          <form className="panel" onSubmit={onSubmit}>
            <h2>Teach it something</h2>
            <p className="lede">
              Upload a video and Knowing watches all of it: it hears what's said and looks at what's on screen. Or
              paste a YouTube, TikTok or article link, or your own notes.
            </p>
            <div className="row">
              <label>
                Type
                <select value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
                  {ITEM_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Title <span className="hint">Optional</span>
                <input type="text" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. How YC picks founders" />
              </label>
            </div>
            <label>
              Video file <span className="hint">Save the TikTok or video to your device, then pick it here</span>
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                onChange={(e) => onVideoChange(e.target.files?.[0] ?? null)}
              />
            </label>
            {video && (
              <p className="where">
                {video.name} ({Math.round(video.size / 1024 / 1024)} MB).{" "}
                <button type="button" className="btn ghost small" onClick={clearVideo}>
                  Remove
                </button>
              </p>
            )}
            <label>
              Link <span className="hint">Optional</span>
              <input type="url" inputMode="url" value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://www.tiktok.com/@…" />
            </label>
            <label>
              {video ? "Your notes" : "What it says"}{" "}
              <span className="hint">{video ? "Optional" : "Optional with a YouTube link"}</span>
              <textarea
                rows={6}
                value={content}
                maxLength={LIMITS.itemContentChars}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste the transcript or caption, or write what you took away from it."
              />
            </label>
            <div className="actions">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Learning…" : video ? "Watch it" : "Teach it"}
              </button>
              <span className="status" role="status">
                {status}
              </span>
            </div>
          </form>

          <p className="section-label">{items.length ? `What it knows (${items.length})` : "What it knows"}</p>
          <div className="stack">
            {items.length === 0 ? (
              <div className="item">
                <div className="item-title">Nothing yet</div>
                <p className="where">Add your first TikTok, video or note above. Each one makes its answers more about you.</p>
              </div>
            ) : (
              items.map((item) => <ItemCard key={item.id} item={item} onDelete={() => deleteItem(item.id)} />)
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** One learned item, with a two-tap delete. */
function ItemCard({ item, onDelete }: { item: KnowledgeItem; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  const date = new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const link = parseHttpUrl(item.url);

  return (
    <article className="item">
      <div className="item-head">
        <div className="item-title">{item.title || "Untitled"}</div>
        <button
          type="button"
          className={`btn ghost small${armed ? " danger" : ""}`}
          onClick={() => (armed ? onDelete() : setArmed(true))}
          onBlur={() => setArmed(false)}
        >
          {armed ? "Tap to confirm" : "Delete"}
        </button>
      </div>
      <div className="meta">
        <span className="kind">{KIND_LABEL[item.kind]}</span>
        <span>{date}</span>
        {item.tags.map((tag) => (
          <span key={tag} className="tag">
            #{tag}
          </span>
        ))}
      </div>
      {item.assessment && item.status !== "reading" && <p className="assessment">{item.assessment}</p>}
      {item.status === "reading" ? (
        <p className="where">Pulling out the key points…</p>
      ) : (
        item.takeaways.length > 0 && (
          <ul>
            {item.takeaways.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        )
      )}
      {link && (
        <a href={link.toString()} target="_blank" rel="noopener noreferrer">
          {item.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}
        </a>
      )}
    </article>
  );
}
