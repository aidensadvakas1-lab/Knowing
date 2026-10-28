"use client";
/**
 * Chat tab: ask about a goal and get an answer built from the profile and
 * everything the user has taught. Streams the answer as it is written.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, streamChat } from "@/lib/api-client";
import { LIMITS, STARTER_PROMPTS } from "@/lib/constants";
import { renderMarkdown } from "@/lib/markdown";
import type { KnowingState } from "@/hooks/useKnowing";
import type { ChatTurn } from "@/lib/types";

interface Pending {
  question: string;
  answer: string;
}

export function ChatView({ state }: { state: KnowingState }) {
  const { chat, setChat, profile, items, password } = state;
  const [draft, setDraft] = useState("");
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

  async function send(raw: string) {
    const question = raw.trim().slice(0, LIMITS.messageChars);
    if (!question || busy) return;
    const history: ChatTurn[] = [...chat, { role: "user", content: question }];
    setDraft("");
    setNote(null);
    setPending({ question, answer: "" });
    controller.current = new AbortController();

    try {
      const result = await streamChat(
        { profile, items, messages: history.slice(-LIMITS.chatTurnsSent) },
        password,
        { onText: (answer) => setPending({ question, answer }) },
        controller.current.signal,
      );
      if (result.text) setChat([...history, { role: "assistant", content: result.text }]);
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
                  <p className="thinking">Thinking…</p>
                )}
              </div>
            </>
          )}
          {note && <p className={`note${note.error ? " err" : ""}`}>{note.text}</p>}
        </div>
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about a goal…"
          aria-label="Message"
          maxLength={LIMITS.messageChars}
        />
        {busy ? (
          <button type="button" className="btn ghost" onClick={() => controller.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn" disabled={!draft.trim()}>
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
