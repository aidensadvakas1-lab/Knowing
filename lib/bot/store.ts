/**
 * Where the bot keeps users and saves.
 *
 * - `SupabaseStore` talks to Supabase's REST API with the service-role key
 *   (server only). Tables are in docs/supabase.sql.
 * - `MemoryStore` keeps everything in memory, for tests.
 */
import type { BotUser, DigestState, Payment, Referral, Save, Sitting, Store, Wallet } from "./types";

/** Recent turns kept per user, so follow-ups make sense. Older chats are kept as searchable memories. */
export const TURNS_KEPT = 16;

/** Lasting facts kept per user. */
export const FACTS_KEPT = 40;

export const newUser = (id: number): BotUser => ({ id, facts: [], turns: [], awaitingWordsFor: null, usage: { day: "", videos: 0, questions: 0 }, sitting: null });

function readUsage(raw: unknown): BotUser["usage"] {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { day: typeof r.day === "string" ? r.day : "", videos: Number(r.videos) || 0, questions: Number(r.questions) || 0 };
}

function readSitting(raw: unknown): Sitting | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  return r && typeof r.last === "string" ? { last: r.last } : null;
}

export function readDigest(raw: unknown): DigestState {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { on: r.on === true, offered: r.offered === true, sent: typeof r.sent === "string" ? r.sent : "", quiet: Math.max(0, Math.floor(Number(r.quiet) || 0)) };
}

export function readReferral(raw: unknown): Referral {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  return { by: n(r.by), name: typeof r.name === "string" ? r.name.slice(0, 64) : "", credited: r.credited === true, rewarded: n(r.rewarded) };
}

/** Payments kept per user, for refunds and duplicate checks. */
const PAYMENTS_KEPT = 50;

export function readWallet(raw: unknown): Wallet {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const count = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  const paid = (Array.isArray(r.paid) ? r.paid : [])
    .filter((p): p is Payment => !!p && typeof p.charge === "string" && (p.kind === "videos" || p.kind === "questions"))
    // Payments from before pack sizes have no count: those packs were 10 videos or 20 questions.
    .map((p) => ({ charge: p.charge, kind: p.kind, count: count(p.count) || (p.kind === "videos" ? 10 : 20), stars: count(p.stars), at: String(p.at ?? "") }));
  return { videos: count(r.videos), questions: count(r.questions), paid: paid.slice(-PAYMENTS_KEPT) };
}

/** A short id that fits inside Telegram's 64-byte button data. */
export function newSaveId(): string {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
}

export class MemoryStore implements Store {
  users = new Map<number, BotUser>();
  wallets = new Map<number, Wallet>();
  digests = new Map<number, DigestState>();
  referrals = new Map<number, Referral>();
  /** When each user's row was last saved, like updated_at. */
  active = new Map<number, string>();
  saves: Save[] = [];

  async getUser(id: number) {
    return structuredClone(this.users.get(id) ?? newUser(id));
  }
  async saveUser(user: BotUser) {
    const sitting = this.users.get(user.id)?.sitting ?? null; // like the database, saving the row leaves the sitting alone
    this.users.set(user.id, structuredClone({ ...user, sitting, turns: user.turns.slice(-TURNS_KEPT), facts: user.facts.slice(-FACTS_KEPT) }));
    this.active.set(user.id, new Date().toISOString());
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
  async deleteUser(userId: number) {
    this.users.delete(userId);
    this.wallets.delete(userId);
    this.digests.delete(userId);
    this.referrals.delete(userId);
    this.saves = this.saves.filter((s) => s.userId !== userId);
  }
  async hasUser(id: number) {
    return this.users.has(id);
  }
  async listUserIds() {
    return [...this.users.keys()];
  }
  async getWallet(userId: number) {
    return readWallet(structuredClone(this.wallets.get(userId)));
  }
  async saveWallet(userId: number, wallet: Wallet) {
    this.wallets.set(userId, readWallet(structuredClone(wallet)));
  }
  async getSave(userId: number, id: string) {
    const s = this.saves.find((x) => x.id === id && x.userId === userId);
    return s ? structuredClone(s) : null;
  }
  async listSaves(userId: number, limit = 200) {
    return this.saves.filter((s) => s.userId === userId).slice(0, limit).map((s) => structuredClone(s));
  }
  async listOpenSittings() {
    return [...this.users.values()].filter((u) => u.sitting).map((u) => structuredClone(u));
  }
  async touchSitting(userId: number, at: string) {
    const user = this.users.get(userId);
    if (user) user.sitting = { last: at };
  }
  async closeSitting(userId: number, last: string) {
    const user = this.users.get(userId);
    if (user?.sitting?.last !== last) return false;
    user.sitting = null;
    return true;
  }
  async getDigest(userId: number) {
    return readDigest(structuredClone(this.digests.get(userId)));
  }
  async saveDigest(userId: number, digest: DigestState) {
    if (!this.users.has(userId)) this.users.set(userId, newUser(userId));
    this.digests.set(userId, readDigest(structuredClone(digest)));
  }
  async listDigestUsers() {
    return [...this.digests].filter(([, d]) => d.on).map(([id, d]) => ({ id, digest: structuredClone(d), active: this.active.get(id) ?? "" }));
  }
  async getReferral(userId: number) {
    return readReferral(structuredClone(this.referrals.get(userId)));
  }
  async saveReferral(userId: number, referral: Referral) {
    if (!this.users.has(userId)) this.users.set(userId, newUser(userId));
    this.referrals.set(userId, readReferral(structuredClone(referral)));
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
  source: string;
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
  source: s.source,
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
  source: r.source ?? "",
  practiced: Number(r.practiced) || 0,
  createdAt: r.created_at,
});

interface UserRow {
  id: number;
  facts: unknown;
  turns: BotUser["turns"];
  awaiting_words_for: string | null;
  usage: unknown;
  sitting?: unknown;
}

const fromUserRow = (r: UserRow): BotUser => ({
  id: Number(r.id),
  facts: Array.isArray(r.facts) ? r.facts.map(String) : [],
  turns: Array.isArray(r.turns) ? r.turns : [],
  awaitingWordsFor: r.awaiting_words_for ?? null,
  usage: readUsage(r.usage),
  sitting: readSitting(r.sitting),
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
    const rows = await this.rest<UserRow[]>(`bot_users?id=eq.${id}&select=*`);
    return rows[0] ? fromUserRow(rows[0]) : newUser(id);
  }

  async listOpenSittings(): Promise<BotUser[]> {
    const rows = await this.rest<UserRow[]>("bot_users?sitting=not.is.null&select=*");
    return rows.map(fromUserRow);
  }

  async touchSitting(userId: number, at: string): Promise<void> {
    await this.rest(`bot_users?id=eq.${userId}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ sitting: { last: at } }) });
  }

  async closeSitting(userId: number, last: string): Promise<boolean> {
    const rows = await this.rest<Array<{ id: number }>>(`bot_users?id=eq.${userId}&sitting->>last=eq.${encodeURIComponent(last)}&select=id`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ sitting: null }),
    });
    return Array.isArray(rows) && rows.length > 0;
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
        usage: user.usage,
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

  /** Saves, their search chunks and chat memories go with the user row (on delete cascade). */
  async deleteUser(userId: number): Promise<void> {
    await this.rest(`bot_users?id=eq.${userId}`, { method: "DELETE" });
  }

  async hasUser(id: number): Promise<boolean> {
    const rows = await this.rest<Array<{ id: number }>>(`bot_users?id=eq.${id}&select=id`);
    return rows.length > 0;
  }

  async listUserIds(): Promise<number[]> {
    const rows = await this.rest<Array<{ id: number }>>("bot_users?select=id");
    return rows.map((r) => Number(r.id));
  }

  /** Throws if the wallet column is missing (docs/supabase.sql not run again), so nobody is charged for nothing. */
  async getWallet(userId: number): Promise<Wallet> {
    const rows = await this.rest<Array<{ wallet: unknown }>>(`bot_users?id=eq.${userId}&select=wallet`);
    return readWallet(rows[0]?.wallet);
  }

  /** Writes only the wallet column, creating the row if needed. */
  async saveWallet(userId: number, wallet: Wallet): Promise<void> {
    await this.rest("bot_users", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: userId, wallet: readWallet(wallet) }),
    });
  }

  async getDigest(userId: number): Promise<DigestState> {
    const rows = await this.rest<Array<{ digest: unknown }>>(`bot_users?id=eq.${userId}&select=digest`);
    return readDigest(rows[0]?.digest);
  }

  /** Writes only the digest column, creating the row if needed. */
  async saveDigest(userId: number, digest: DigestState): Promise<void> {
    await this.rest("bot_users", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: userId, digest: readDigest(digest) }),
    });
  }

  async listDigestUsers(): Promise<Array<{ id: number; digest: DigestState; active: string }>> {
    const rows = await this.rest<Array<{ id: number; digest: unknown; updated_at: string }>>("bot_users?digest->>on=eq.true&select=id,digest,updated_at");
    return rows.map((r) => ({ id: Number(r.id), digest: readDigest(r.digest), active: r.updated_at ?? "" }));
  }

  async getReferral(userId: number): Promise<Referral> {
    const rows = await this.rest<Array<{ referral: unknown }>>(`bot_users?id=eq.${userId}&select=referral`);
    return readReferral(rows[0]?.referral);
  }

  /** Writes only the referral column, creating the row if needed. */
  async saveReferral(userId: number, referral: Referral): Promise<void> {
    await this.rest("bot_users", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: userId, referral: readReferral(referral) }),
    });
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
