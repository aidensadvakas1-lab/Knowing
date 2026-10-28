"use client";
/**
 * Banner shown above the tabs when the server isn't ready (no API key) or
 * needs a password. Lets the user enter the password once per device.
 */
import { useState, type FormEvent } from "react";
import type { KnowingState } from "@/hooks/useKnowing";

export function Notice({ state }: { state: KnowingState }) {
  const { health, password, setPassword } = state;
  const [value, setValue] = useState("");

  if (!health) return null;
  if (!health.aiConfigured) {
    return (
      <div className="notice" role="alert">
        The server has no <code>ANTHROPIC_API_KEY</code> yet, so chat and learning are off. See the README to add it.
      </div>
    );
  }
  if (health.passwordRequired && !password) {
    const onSubmit = (event: FormEvent) => {
      event.preventDefault();
      if (value.trim()) setPassword(value.trim());
    };
    return (
      <form className="notice" onSubmit={onSubmit}>
        <label className="inline">
          Enter the app password
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="current-password" />
        </label>
        <button className="btn small" type="submit">
          Unlock
        </button>
      </form>
    );
  }
  return null;
}
