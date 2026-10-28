"use client";
/**
 * Teach tab: add a TikTok, video, article or note. Paste a link and Knowing
 * fetches what it can (YouTube transcript, TikTok caption, article text), then
 * pulls out the key points. Lists everything it has learned.
 */
import { useState, type FormEvent } from "react";
import { ApiError, learn } from "@/lib/api-client";
import { ITEM_KINDS, KIND_LABEL, LIMITS } from "@/lib/constants";
import { effectiveGoal } from "@/lib/prompt";
import { parseHttpUrl, suggestKind } from "@/lib/sources";
import { newId } from "@/lib/storage";
import type { KnowingState } from "@/hooks/useKnowing";
import type { ItemKind, KnowledgeItem } from "@/lib/types";

export function TeachView({ state }: { state: KnowingState }) {
  const { items, addItem, updateItem, deleteItem, profile, password } = state;
  const [kind, setKind] = useState<ItemKind>("tiktok");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  /** Preselect the type when a recognizable link is pasted. */
  function onUrlChange(value: string) {
    setUrl(value);
    const suggested = suggestKind(value);
    if (suggested) setKind(suggested);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
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

  return (
    <section className="view" aria-label="Teach">
      <div className="scroll">
        <div className="stack">
          <form className="panel" onSubmit={onSubmit}>
            <h2>Teach it something</h2>
            <p className="lede">
              Paste a YouTube, TikTok or article link and Knowing grabs what it can. Add the transcript or your own
              notes for the best results.
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
              Link <span className="hint">Optional</span>
              <input type="url" inputMode="url" value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://www.tiktok.com/@…" />
            </label>
            <label>
              What it says <span className="hint">Optional with a YouTube link</span>
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
                {busy ? "Learning…" : "Teach it"}
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
