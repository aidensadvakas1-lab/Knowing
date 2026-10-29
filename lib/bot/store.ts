/**
 * Where the bot keeps users and saves.
 *
 * - `SupabaseStore` talks to Supabase's REST API with the service-role key
 *   (server only). Tables are in docs/supabase.sql.
 * - `MemoryStore` keeps everything in memory, for tests.
 */
import type { BotUser, Save, Store } from "./types";

/** Turns kept per user for follow-up questions. */
export const TURNS_KEPT = 12;

/** Lasting facts kept per user. */
export const FACTS_KEPT = 40;

export const newUser = (id: number): BotUser => ({ id, facts: [], turns: [], awaitingWordsFor: null });

/** A short id that fits inside Telegram's 64-byte button data. */
export function newSaveId(): string {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
}

export class MemoryStore implements Store {
  users = new Map<number, BotUser>();
  saves: Save[] = [];

  async getUser(id: number) {
    return structuredClone(this.users.get(id) ?? newUser(id));
  }
  async saveUser(user: BotUser) {
    this.users.set(user.id, structuredClone({ ...user, turns: user.turns.slice(-TURNS_KEPT), facts: user.facts.slice(-FACTS_KEPT) }));
  }
  async addSave(save: Save) {
    this.saves.unshift(structuredClone(save));
  }
  async updateSave(save: Save) {
    this.saves = this.saves.map((s) => (s.id === save.id && s.userId === save.userId ? structuredClone(save) : s));
  }
  async deleteSave(userId: number, id: string) {
    this.saves = this.saves.filter((s) => !(s.id === id && s.userId === userId));
  }
  async getSave(userId: number, id: string) {
    const s = this.saves.find((x) => x.id === id && x.userId === userId);
    return s ? structuredClone(s) : null;
  }
  async listSaves(userId: number, limit = 200) {
    return this.saves.filter((s) => s.userId === userId).slice(0, limit).map((s) => structuredClone(s));
  }
}

interface SaveRow {
  id: string;
  user_id: number;
  title: string;
  topic: string;
  type: Save["type"];
  summary: string;
  steps: string[];
  details: string;
  needs_words: boolean;
  source_url: string;
  words: string;
  practiced: number;
  created_at: string;
}

const toRow = (s: Save): SaveRow => ({
  id: s.id,
  user_id: s.userId,
  title: s.title,
  topic: s.topic,
  type: s.type,
  summary: s.summary,
  steps: s.steps,
  details: s.details,
  needs_words: s.needsWords,
  source_url: s.sourceUrl,
  words: s.words,
  practiced: s.practiced,
  created_at: s.createdAt,
});

const fromRow = (r: SaveRow): Save => ({
  id: r.id,
  userId: Number(r.user_id),
  title: r.title ?? "",
  topic: r.topic ?? "",
  type: r.type ?? "info",
  summary: r.summary ?? "",
  steps: Array.isArray(r.steps) ? r.steps : [],
  details: r.details ?? "",
  needsWords: Boolean(r.needs_words),
  sourceUrl: r.source_url ?? "",
  words: r.words ?? "",
  practiced: Number(r.practiced) || 0,
  createdAt: r.created_at,
});

export class SupabaseStore implements Store {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) throw new Error(`Supabase ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${await res.text().catch(() => "")}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async getUser(id: number): Promise<BotUser> {
    const rows = await this.rest<Array<{ id: number; facts: unknown; turns: BotUser["turns"]; awaiting_words_for: string | null }>>(`bot_users?id=eq.${id}&select=*`);
    const r = rows[0];
    if (!r) return newUser(id);
    return {
      id,
      facts: Array.isArray(r.facts) ? r.facts.map(String) : [],
      turns: Array.isArray(r.turns) ? r.turns : [],
      awaitingWordsFor: r.awaiting_words_for ?? null,
    };
  }

  async saveUser(user: BotUser): Promise<void> {
    await this.rest("bot_users", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: user.id,
        facts: user.facts.slice(-FACTS_KEPT),
        turns: user.turns.slice(-TURNS_KEPT),
        awaiting_words_for: user.awaitingWordsFor,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  async addSave(save: Save): Promise<void> {
    await this.rest("saves", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(toRow(save)) });
  }

  async updateSave(save: Save): Promise<void> {
    await this.rest(`saves?id=eq.${encodeURIComponent(save.id)}&user_id=eq.${save.userId}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(toRow(save)),
    });
  }

  async deleteSave(userId: number, id: string): Promise<void> {
    await this.rest(`saves?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`, { method: "DELETE" });
  }

  async getSave(userId: number, id: string): Promise<Save | null> {
    const rows = await this.rest<SaveRow[]>(`saves?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}&select=*`);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listSaves(userId: number, limit = 200): Promise<Save[]> {
    const rows = await this.rest<SaveRow[]>(`saves?user_id=eq.${userId}&select=*&order=created_at.desc&limit=${limit}`);
    return rows.map(fromRow);
  }
}
