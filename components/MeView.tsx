"use client";
/**
 * Me tab: the profile every answer starts from, plus backup and restore so
 * the same data can be moved between phone and computer.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_GOAL } from "@/lib/constants";
import type { KnowingState } from "@/hooks/useKnowing";
import type { Profile } from "@/lib/types";

const FIELDS: { key: keyof Omit<Profile, "updatedAt">; label: string; hint?: string; placeholder?: string; long: boolean }[] = [
  { key: "now", label: "Where you are now", hint: "School and grade, job, age, anything that sets your starting point", long: true },
  { key: "goal", label: "Your main goal", long: true },
  { key: "skills", label: "Skills and experience you already have", placeholder: "e.g. Some Python, ran a small resale business, good at pitching", long: true },
  { key: "time", label: "Time you can put in each week", placeholder: "e.g. 10 hours on weekdays, more in summer", long: false },
  { key: "more", label: "Anything else it should know", hint: "Interests, money limits, deadlines, people you know", long: true },
];

export function MeView({ state }: { state: KnowingState }) {
  const { profile, setProfile, exportBackup, importBackup } = state;
  const [form, setForm] = useState<Profile>(profile);
  const [status, setStatus] = useState("");
  const [backupStatus, setBackupStatus] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // Refresh the form when the saved profile changes (first load, restore).
  useEffect(() => setForm({ ...profile, goal: profile.goal || DEFAULT_GOAL }), [profile]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = Object.fromEntries(
      FIELDS.map(({ key }) => [key, (form[key] ?? "").trim()]),
    ) as Omit<Profile, "updatedAt">;
    setStatus(setProfile({ ...trimmed, updatedAt: Date.now() }) ? "Saved" : "Couldn't save. Storage may be full.");
  }

  function download() {
    const blob = new Blob([exportBackup()], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href,
      download: `knowing-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(href);
    setBackupStatus("Backup downloaded.");
  }

  async function restore(file: File | undefined) {
    if (!file) return;
    try {
      const { items } = importBackup(await file.text());
      setBackupStatus(`Restored ${items} item${items === 1 ? "" : "s"}.`);
    } catch (error) {
      setBackupStatus((error as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <section className="view" aria-label="Me">
      <div className="scroll">
        <div className="stack">
          <form className="panel" onSubmit={onSubmit}>
            <h2>Where you are now</h2>
            <p className="lede">This is the starting point for every answer. The more specific it is, the less generic the advice.</p>
            {FIELDS.map(({ key, label, hint, placeholder, long }) => (
              <label key={key}>
                {label} {hint && <span className="hint">{hint}</span>}
                {long ? (
                  <textarea rows={3} value={form[key] ?? ""} placeholder={placeholder} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                ) : (
                  <input type="text" value={form[key] ?? ""} placeholder={placeholder} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                )}
              </label>
            ))}
            <div className="actions">
              <button className="btn" type="submit">
                Save
              </button>
              <span className="status" role="status">
                {status}
              </span>
            </div>
            <p className="where">Saved on this device. Use backup below to move it to another device.</p>
          </form>

          <div className="panel">
            <h2>Backup</h2>
            <p className="lede">Download everything Knowing knows, then restore it on your phone or another computer.</p>
            <div className="actions">
              <button className="btn ghost" type="button" onClick={download}>
                Download backup
              </button>
              <button className="btn ghost" type="button" onClick={() => fileInput.current?.click()}>
                Restore from file
              </button>
              <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void restore(e.target.files?.[0])} />
              <span className="status" role="status">
                {backupStatus}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
