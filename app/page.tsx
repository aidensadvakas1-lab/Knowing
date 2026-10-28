"use client";
/**
 * The whole app on one screen: a header with the Chat / Teach / Me tabs and
 * the selected view underneath. Works the same on phone and desktop.
 */
import { useState } from "react";
import { ChatView } from "@/components/ChatView";
import { MeView } from "@/components/MeView";
import { Notice } from "@/components/Notice";
import { TeachView } from "@/components/TeachView";
import { useKnowing } from "@/hooks/useKnowing";

type Tab = "chat" | "teach" | "me";
const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "teach", label: "Teach" },
  { id: "me", label: "Me" },
];

export default function Home() {
  const state = useKnowing();
  const [tab, setTab] = useState<Tab>("chat");
  const count = state.items.length;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>Knowing</h1>
          <span className="count">
            {count} thing{count === 1 ? "" : "s"} learned
          </span>
        </div>
        <nav role="tablist" aria-label="Sections">
          {TABS.map(({ id, label }) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <Notice state={state} />
      <main>
        {!state.ready ? null : tab === "chat" ? (
          <ChatView state={state} />
        ) : tab === "teach" ? (
          <TeachView state={state} />
        ) : (
          <MeView state={state} />
        )}
      </main>
    </div>
  );
}
