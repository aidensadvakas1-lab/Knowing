"use client";
/**
 * Chat tab: ask about a goal and get an answer built from the profile and
 * everything the user has taught. Streams the answer as it is written.
 *
 * The + button attaches files to a message. Videos are watched and saved to
 * what Knowing knows; images, PDFs and text files are read with the message.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, streamChat } from "@/lib/api-client";
import { attachedLine, classifyFile, fitsInRequest, type AttachmentKind, type ChatAttachment } from "@/lib/attachments";
import { ATTACHMENTS, LIMITS, STARTER_PROMPTS } from "@/lib/constants";
import { renderMarkdown } from "@/lib/markdown";
import { effectiveGoal } from "@/lib/prompt";
import { AttachmentError, readAttachment } from "@/lib/read-attachment";
import { newId } from "@/lib/storage";
import { checkVideo, VideoError, watchVideo } from "@/lib/watch-video";
import type { KnowingState } from "@/hooks/useKnowing";
import type { ChatTurn, KnowledgeItem } from "@/lib/types";

interface Pending {
  question: string;
  answer: string;
  /** Progress while attachments are processed, before the answer starts. */
  status?: string;
}

interface Picked {
  id: string;
  file: File;
  kind: Exclude<AttachmentKind, "unsupported">;
}

/** What the file picker offers. Anything else is rejected with a note. */
const ACCEPT = "video/*,image/*,application/pdf,.pdf,text/*,.txt,.md,.csv,.json,.srt,.vtt";

/** Asked on the user's behalf when they send files without typing anything. */
const DEFAULT_QUESTION = "What should I take from this for my goal?";

export function ChatView({ state }: { state: KnowingState }) {
  const { chat, setChat, profile, items, password, health, addItem, updateItem, deleteItem } = state;
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const busy = pending !== null;

  // Keep the newest text in view while the answer streams in, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || !pending) el.scrollTop = el.scrollHeight;
  }, [chat, pending]);

  // Grow the composer with its content, up to a limit.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  /** Add files from the + button, skipping ones Knowing can't read. */
  function onPick(files: FileList | null) {
    if (!files) return;
    const next = [...picked];
    const skipped: string[] = [];
    for (const file of Array.from(files)) {
      const kind = classifyFile(file);
      if (kind === "unsupported") skipped.push(file.name);
      else if (next.length < ATTACHMENTS.max) next.push({ id: newId(), file, kind });
      else skipped.push(file.name);
    }
    setPicked(next);
    if (fileInput.current) fileInput.current.value = "";
    if (skipped.length) {
      setNote({
        text: `Skipped ${skipped.join(", ")}. Attach up to ${ATTACHMENTS.max} videos, photos, PDFs or text files.`,
        error: true,
      });
    }
  }

  /**
   * Watch attached videos (saving each as a taught item) and read the other
   * files. Returns what to send with the message, plus any problems to show.
   */
  async function prepare(files: Picked[], display: string) {
    const attachments: ChatAttachment[] = [];
    const watched: KnowledgeItem[] = [];
    const problems: string[] = [];
    for (const { file, kind } of files) {
      if (kind !== "video") {
        try {
          attachments.push(await readAttachment(file, kind));
        } catch (error) {
          problems.push(error instanceof AttachmentError ? error.message : `Couldn't read ${file.name}.`);
        }
        continue;
      }
      let id: string | null = null;
      try {
        const status = (text: string) => setPending({ question: display, answer: "", status: `${file.name}: ${text}` });
        status("Opening the video…");
        const durationSec = await checkVideo(file);
        const draft: KnowledgeItem = {
          id: newId(),
          kind: "video",
          title: file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Attached video",
          url: "",
          content: "",
          takeaways: [],
          tags: [],
          status: "reading",
          createdAt: Date.now(),
        };
        if (!addItem(draft)) {
          problems.push("Storage is full, so the video wasn't saved. Delete some items in Teach.");
          continue;
        }
        id = draft.id;
        const result = await watchVideo(
          {
            file,
            kind: "video",
            title: "",
            url: "",
            notes: "",
            goal: effectiveGoal(profile),
            password,
            canTranscribe: Boolean(health?.transcriptionConfigured),
            onStatus: status,
          },
          durationSec,
        );
        updateItem(id, result.patch);
        watched.push({ ...draft, ...result.patch });
        problems.push(...result.notes);
      } catch (error) {
        if (id) deleteItem(id);
        problems.push(
          error instanceof VideoError || error instanceof ApiError ? `${file.name}: ${error.message}` : `Couldn't watch ${file.name}.`,
        );
      }
    }
    return { attachments, watched, problems };
  }

  async function send(raw: string) {
    const files = picked;
    // Leave room for the attachment lines added below.
    const typed = raw.trim().slice(0, LIMITS.messageChars - 600);
    if ((!typed && files.length === 0) || busy) return;
    const question = typed || DEFAULT_QUESTION;
    const display = [question, attachedLine(files.map((f) => f.file.name))].filter(Boolean).join("\n\n");
    const history: ChatTurn[] = [...chat, { role: "user", content: display }];
    setDraft("");
    setPicked([]);
    setNote(null);
    setPending({ question: display, answer: "", status: files.length ? "Reading your files…" : undefined });
    controller.current = new AbortController();

    const { attachments, watched, problems } = files.length
      ? await prepare(files, display)
      : { attachments: [], watched: [], problems: [] as string[] };
    if (!fitsInRequest(attachments)) {
      setChat(history);
      setPending(null);
      controller.current = null;
      return setNote({ text: "Those files are too big to send together. Attach fewer or smaller files.", error: true });
    }
    // Tell Knowing which saved items are the videos just attached.
    const asked = watched.length
      ? `${question}\n\n(I just attached ${watched.map((w) => `"${w.title}"`).join(", ")}. You've watched it and it's in what I taught you.)`
      : question;
    const knowledge = [...watched, ...items.filter((i) => !watched.some((w) => w.id === i.id))];
    const problemNote = problems.length ? problems.join(" ") : "";

    try {
      const result = await streamChat(
        {
          profile,
          items: knowledge,
          messages: [...chat, { role: "user" as const, content: asked }].slice(-LIMITS.chatTurnsSent),
          attachments,
        },
        password,
        { onText: (answer) => setPending({ question: display, answer }) },
        controller.current.signal,
      );
      if (result.text) setChat([...history, { role: "assistant", content: result.text }]);
      if (problemNote) setNote({ text: problemNote, error: false });
      if (result.stopReason === "max_tokens") setNote({ text: "This answer was cut short. Ask it to continue.", error: false });
      if (result.stopReason === "refusal") setNote({ text: "Knowing couldn't answer that. Try asking another way.", error: true });
    } catch (error) {
      const partial = (error as { partial?: string }).partial;
      const aborted = (error as Error).name === "AbortError";
      if (partial) setChat([...history, { role: "assistant", content: partial }]);
      else if (!aborted) setChat(history);
      if (!aborted) {
        setNote({ text: error instanceof ApiError ? error.message : "Couldn't reach Knowing. Check your connection.", error: true });
      }
    } finally {
      controller.current = null;
      setPending(null);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  }

  function clearChat() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    controller.current?.abort();
    setConfirmClear(false);
    setChat([]);
    setNote(null);
  }

  const empty = chat.length === 0 && !pending;

  return (
    <section className="view" aria-label="Chat">
      <div className="scroll" ref={scroller}>
        {!empty && (
          <div className="toolbar">
            <button type="button" className={`btn ghost small${confirmClear ? " danger" : ""}`} onClick={clearChat}>
              {confirmClear ? "Tap again to clear" : "Clear chat"}
            </button>
          </div>
        )}
        {empty && (
          <div className="empty">
            <h2>Ask about your goals. Get answers built on what you&apos;ve taught it.</h2>
            <p>Knowing reads your profile and every video, TikTok and note you add before it answers.</p>
            <div className="chips">
              {STARTER_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" className="chip" onClick={() => void send(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="thread" aria-live="polite">
          {chat.map((turn, i) => (
            <Message key={i} turn={turn} />
          ))}
          {pending && (
            <>
              <Message turn={{ role: "user", content: pending.question }} />
              <div className="msg bot">
                <div className="who">Knowing</div>
                {pending.answer ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(pending.answer) }} />
                ) : (
                  <p className="thinking">{pending.status ?? "Thinking…"}</p>
                )}
              </div>
            </>
          )}
          {note && <p className={`note${note.error ? " err" : ""}`}>{note.text}</p>}
        </div>
      </div>
      {picked.length > 0 && (
        <ul className="attachments" aria-label="Attached files">
          {picked.map((p) => (
            <li key={p.id} className="attachment">
              <span className="attachment-kind">{p.kind === "pdf" ? "PDF" : p.kind}</span>
              <span className="attachment-name">{p.file.name}</span>
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${p.file.name}`}
                onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="composer" onSubmit={onSubmit}>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => onPick(e.target.files)}
        />
        <button
          type="button"
          className="btn ghost plus"
          aria-label="Attach videos or files"
          title="Attach videos or files"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          +
        </button>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={picked.length ? "Ask about your files…" : "Ask about a goal…"}
          aria-label="Message"
          maxLength={LIMITS.messageChars}
        />
        {busy ? (
          <button type="button" className="btn ghost" onClick={() => controller.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn" disabled={!draft.trim() && picked.length === 0}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}

/** One chat bubble. Assistant text is rendered as sanitized Markdown. */
function Message({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") return <div className="msg user">{turn.content}</div>;
  return (
    <div className="msg bot">
      <div className="who">Knowing</div>
      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.content) }} />
    </div>
  );
}
