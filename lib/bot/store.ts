/**
 * Where the bot keeps users and saves.
 *
 * - `SupabaseStore` talks to Supabase's REST API with the service-role key
 *   (server only). Tables are in docs/supabase.sql.
 * - `MemoryStore` keeps everything in memory, for tests.
 */
import { fetchRetry } from "../net";
import { readCollections } from "./collections";
import { readRules } from "./folders";
import type { BotUser, Collection, DigestState, FilingRule, PackKind, Payment, Plan, Referral, Save, Sitting, Spent, SpendRule, Store, Usage, Wallet } from "./types";

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
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : {}))
    .filter((p) => typeof p.charge === "string")
    .map((p): Payment => {
      // Payments from before bundles bought one kind: { kind, count }, and before pack sizes, 10 videos or 20 questions.
      const old = p.kind === "videos" || p.kind === "questions" ? (count(p.count) || (p.kind === "videos" ? 10 : 20)) : 0;
      return {
        charge: String(p.charge),
        videos: p.kind === "videos" ? old : count(p.videos),
        questions: p.kind === "questions" ? old : count(p.questions),
        stars: count(p.stars),
        at: String(p.at ?? ""),
        ...(p.plan === true ? { plan: true } : {}),
      };
    })
    .filter((p) => p.videos || p.questions || p.plan);
  return { videos: count(r.videos), questions: count(r.questions), paid: paid.slice(-PAYMENTS_KEPT), plan: readPlan(r.plan) };
}

/** Knowing Plus read from the wallet, or null if there's none (or it's broken). */
export function readPlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const until = String(r.until ?? "");
  const charge = String(r.charge ?? "");
  if (!Number.isFinite(Date.parse(until)) || !charge) return null;
  const count = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  const cost = Number(r.cost);
  return {
    until,
    first: String(r.first || charge),
    charge,
    stars: count(r.stars),
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(r.day)) ? String(r.day) : "",
    videos: count(r.videos),
    questions: count(r.questions),
    cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    canceled: r.canceled === true,
  };
}

/**
 * The rule bot_spend in docs/supabase.sql follows, in one place for the
 * in-memory store: today's plan, then a free one, then a bought one. Changes
 * `usage` and `wallet` in place.
 */
export function takeOne(usage: Usage, wallet: Wallet, kind: PackKind, rule: SpendRule): Spent | null {
  const plan = wallet.plan;
  if (plan && rule.planDaily > 0) {
    if (plan.day !== rule.day) Object.assign(plan, { day: rule.day, videos: 0, questions: 0 });
    if (plan[kind] < rule.planDaily) {
      plan[kind] += 1;
      return "plan";
    }
  }
  if (usage[kind] < rule.free) {
    usage[kind] += 1;
    if (!usage.day) usage.day = rule.day;
    return "free";
  }
  if (wallet[kind] > 0) {
    wallet[kind] -= 1;
    return "wallet";
  }
  return null;
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
  filing = new Map<number, FilingRule[]>();
  collections = new Map<number, Collection[]>();
  /** When each user's row was last saved, like updated_at. */
  active = new Map<number, string>();
  saves: Save[] = [];

  async getUser(id: number) {
    return structuredClone(this.users.get(id) ?? newUser(id));
  }
  async saveUser(user: BotUser) {
    const old = this.users.get(user.id);
    // Like the database, saving the row leaves the sitting and what they've used alone.
    const sitting = old?.sitting ?? null;
    const usage = old?.usage ?? newUser(user.id).usage;
    this.users.set(user.id, structuredClone({ ...user, sitting, usage, turns: user.turns.slice(-TURNS_KEPT), facts: user.facts.slice(-FACTS_KEPT) }));
    this.active.set(user.id, new Date().toISOString());
  }
  async setUsage(userId: number, usage: Usage) {
    const user = this.users.get(userId);
    if (user) user.usage = { ...usage };
  }
  async spend(userId: number, kind: PackKind, rule: SpendRule) {
    const user = this.users.get(userId);
    if (!user) return null;
    const wallet = readWallet(this.wallets.get(userId));
    const from = takeOne(user.usage, wallet, kind, rule);
    if (from) this.wallets.set(userId, wallet);
    return from;
  }
  async giveBack(userId: number, kind: PackKind, from: Spent, day: string) {
    const user = this.users.get(userId);
    const wallet = readWallet(this.wallets.get(userId));
    if (from === "free" && user) user.usage[kind] = Math.max(0, user.usage[kind] - 1);
    if (from === "wallet") wallet[kind] += 1;
    if (from === "plan" && wallet.plan?.day === day) wallet.plan[kind] = Math.max(0, wallet.plan[kind] - 1);
    this.wallets.set(userId, wallet);
  }
  async addPlanCost(userId: number, dollars: number) {
    const wallet = readWallet(this.wallets.get(userId));
    if (!wallet.plan) return null;
    wallet.plan.cost += Math.max(0, dollars);
    this.wallets.set(userId, wallet);
    return wallet.plan.cost;
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
    this.filing.delete(userId);
    this.collections.delete(userId);
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
  async moveSaves(userId: number, ids: string[], folder: string) {
    for (const s of this.saves) if (s.userId === userId && ids.includes(s.id)) s.folder = folder;
  }
  async getFiling(userId: number) {
    return readRules(structuredClone(this.filing.get(userId) ?? []));
  }
  async saveFiling(userId: number, rules: FilingRule[]) {
    if (!this.users.has(userId)) this.users.set(userId, newUser(userId));
    this.filing.set(userId, readRules(structuredClone(rules)));
  }
  async getCollections(userId: number) {
    return readCollections(structuredClone(this.collections.get(userId) ?? []));
  }
  async saveCollections(userId: number, collections: Collection[]) {
    if (!this.users.has(userId)) this.users.set(userId, newUser(userId));
    this.collections.set(userId, readCollections(structuredClone(collections)));
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
  /** Missing before docs/supabase.sql is run again. */
  folder?: string;
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
  folder: s.folder ?? "",
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

/** Supabase saying the saves table has no folder column yet (docs/supabase.sql not run again). */
export const missingFolderColumn = (error: unknown) => /PGRST204|'folder' column/.test(error instanceof Error ? error.message : String(error));

const fromRow = (r: SaveRow): Save => ({
  id: r.id,
  userId: Number(r.user_id),
  title: r.title ?? "",
  topic: r.topic ?? "",
  folder: r.folder ?? "",
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
    const res = await fetchRetry(
      `${this.url.replace(/\/$/, "")}/rest/v1/${path}`,
      { ...init, headers: { apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } },
      `Supabase ${init.method ?? "GET"} ${path.split("?")[0]}`,
    );
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
        // Not usage: only bot_spend and bot_give_back change it, so a slow reply can't undo a use.
        updated_at: new Date().toISOString(),
      }),
    });
  }

  /** A save still goes through before the folder column exists: it's then filed by its topic, like before. */
  private async writeSave(path: string, method: "POST" | "PATCH", save: Save): Promise<void> {
    // A new save is an upsert, so a retry after a dropped connection (the first try may have gone through) can't fail as a duplicate.
    const prefer = method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=minimal";
    const write = (row: Partial<SaveRow>) => this.rest(path, { method, headers: { prefer }, body: JSON.stringify(row) });
    try {
      await write(toRow(save));
    } catch (error) {
      if (!missingFolderColumn(error)) throw error;
      const { folder: _folder, ...row } = toRow(save);
      await write(row);
    }
  }

  async addSave(save: Save): Promise<void> {
    await this.writeSave("saves", "POST", save);
  }

  async updateSave(save: Save): Promise<void> {
    await this.writeSave(`saves?id=eq.${encodeURIComponent(save.id)}&user_id=eq.${save.userId}`, "PATCH", save);
  }

  async moveSaves(userId: number, ids: string[], folder: string): Promise<void> {
    if (!ids.length) return;
    const list = ids.map((id) => `"${id.replace(/["\\,()]/g, "")}"`).join(",");
    await this.rest(`saves?user_id=eq.${userId}&id=in.(${encodeURIComponent(list)})`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ folder }) });
  }

  async getFiling(userId: number): Promise<FilingRule[]> {
    const rows = await this.rest<Array<{ filing: unknown }>>(`bot_users?id=eq.${userId}&select=filing`);
    return readRules(rows[0]?.filing);
  }

  /** Writes only the filing column, creating the row if needed. */
  async saveFiling(userId: number, rules: FilingRule[]): Promise<void> {
    await this.rest("bot_users", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: userId, filing: readRules(rules) }),
    });
  }

  async getCollections(userId: number): Promise<Collection[]> {
    const rows = await this.rest<Array<{ collections: unknown }>>(`bot_users?id=eq.${userId}&select=collections`);
    return readCollections(rows[0]?.collections);
  }

  /** Writes only the collections column, creating the row if needed. */
  async saveCollections(userId: number, collections: Collection[]): Promise<void> {
    await this.rest("bot_users", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: userId, collections: readCollections(collections) }),
    });
  }

  async deleteSave(userId: number, id: string): Promise<void> {
    await this.rest(`saves?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`, { method: "DELETE" });
  }

  /** Saves, their search chunks and chat memories go with the user row (on delete cascade). */
  async deleteUser(userId: number): Promise<void> {
    await this.rest(`bot_users?id=eq.${userId}`, { method: "DELETE" });
  }

  /**
   * Until docs/supabase.sql has been run again, the one-step functions aren't
   * there. Then the bot keeps working the old way (read, then write) instead of
   * stopping, and says so in the log.
   */
  private async orOldWay<T>(rpc: () => Promise<T>, old: () => Promise<T>): Promise<T> {
    try {
      return await rpc();
    } catch (error) {
      if (!/PGRST202|Could not find the function|404/.test(String(error))) throw error;
      console.error("Run docs/supabase.sql again in Supabase: the bot_spend functions are missing", error);
      return old();
    }
  }

  private async readRow(userId: number): Promise<{ usage: Usage; wallet: Wallet } | null> {
    const rows = await this.rest<Array<{ usage: unknown; wallet: unknown }>>(`bot_users?id=eq.${userId}&select=usage,wallet`);
    return rows[0] ? { usage: readUsage(rows[0].usage), wallet: readWallet(rows[0].wallet) } : null;
  }

  private async writeRow(userId: number, row: { usage?: Usage; wallet?: Wallet }): Promise<void> {
    await this.rest(`bot_users?id=eq.${userId}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(row) });
  }

  async spend(userId: number, kind: PackKind, rule: SpendRule): Promise<Spent | null> {
    return this.orOldWay(
      async () => {
        const from = await this.rest<string | null>("rpc/bot_spend", {
          method: "POST",
          body: JSON.stringify({ p_id: userId, p_kind: kind, p_free: rule.free, p_plan_daily: rule.planDaily, p_day: rule.day }),
        });
        return from === "plan" || from === "free" || from === "wallet" ? from : null;
      },
      async () => {
        const row = await this.readRow(userId);
        if (!row) return null;
        const from = takeOne(row.usage, row.wallet, kind, rule);
        if (from) await this.writeRow(userId, from === "free" ? { usage: row.usage } : { wallet: row.wallet });
        return from;
      },
    );
  }

  async giveBack(userId: number, kind: PackKind, from: Spent, day: string): Promise<void> {
    await this.orOldWay(
      () => this.rest("rpc/bot_give_back", { method: "POST", body: JSON.stringify({ p_id: userId, p_kind: kind, p_from: from, p_day: day }) }),
      async () => {
        const row = await this.readRow(userId);
        if (!row) return;
        if (from === "free") return this.writeRow(userId, { usage: { ...row.usage, [kind]: Math.max(0, row.usage[kind] - 1) } });
        if (from === "wallet") row.wallet[kind] += 1;
        if (from === "plan" && row.wallet.plan?.day === day) row.wallet.plan[kind] = Math.max(0, row.wallet.plan[kind] - 1);
        await this.writeRow(userId, { wallet: row.wallet });
      },
    );
  }

  async addPlanCost(userId: number, dollars: number): Promise<number | null> {
    return this.orOldWay(
      async () => {
        const total = await this.rest<number | string | null>("rpc/bot_plan_cost", { method: "POST", body: JSON.stringify({ p_id: userId, p_dollars: dollars }) });
        return total === null ? null : Number(total);
      },
      async () => {
        const row = await this.readRow(userId);
        if (!row?.wallet.plan) return null;
        row.wallet.plan.cost += Math.max(0, dollars);
        await this.writeRow(userId, { wallet: row.wallet });
        return row.wallet.plan.cost;
      },
    );
  }

  async setUsage(userId: number, usage: Usage): Promise<void> {
    await this.rest(`bot_users?id=eq.${userId}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ usage }) });
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
