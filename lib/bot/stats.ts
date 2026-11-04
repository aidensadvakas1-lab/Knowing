/**
 * /stats: everything the owner can know about Knowing in one message. People,
 * videos, questions, money in (Stars) and money out (what the AI really cost,
 * measured by meter.ts and logged per day in bot_costs).
 *
 * It only reads. Nothing here costs an AI call.
 */
import { PAYOUT_PER_STAR } from "./costs";
import { escapeHtml as esc } from "./format";
import { planActive, planLevel } from "./plan";
import type { DigestState, PackKind, Referral, Usage, Wallet } from "./types";

/** One person, as /stats needs them. `active` is when they last messaged the bot (ISO). */
export interface StatUser {
  id: number;
  usage: Usage;
  wallet: Wallet;
  referral: Referral;
  digest: DigestState;
  active: string;
}

/** One day of one person's real AI cost for videos or questions (bot_costs). */
export interface CostRow {
  day: string;
  userId: number;
  kind: PackKind;
  /** Videos watched or questions answered, including ones that failed. */
  uses: number;
  /** Ones that failed and were given back. */
  failed: number;
  dollars: number;
}

export interface StatsData {
  users: StatUser[];
  saves: Array<{ userId: number; createdAt: string; type: string; folder: string }>;
  /** Chats (questions and answers) from the last 30 days. */
  chats: Array<{ userId: number; createdAt: string }>;
  /** The last 30 days of costs, or null when bot_costs doesn't exist yet (docs/supabase.sql not run again). */
  costs: CostRow[] | null;
}

export interface StatsSettings {
  ownerId: number;
  /** The most people who can join (0 = no limit). */
  cap: number;
  limits: { videos: number; questions: number };
}

const DAY_MS = 86_400_000;
const money = (d: number) => `$${d < 10 ? d.toFixed(2) : d.toFixed(0)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

/** Counts in the last day, 7 days and 30 days, from a list of times. */
function windows(times: string[], now: Date): [number, number, number] {
  const ago = (iso: string) => now.getTime() - Date.parse(iso);
  const within = (days: number) => times.filter((t) => Number.isFinite(Date.parse(t)) && ago(t) >= 0 && ago(t) < days * DAY_MS).length;
  return [within(1), within(7), within(30)];
}

const daysAgo = (now: Date, n: number) => new Date(now.getTime() - n * DAY_MS).toISOString().slice(0, 10);

/** The biggest few entries of a count map, as "Gym 12, Cars 8". */
function top(counts: Map<string, number>, n: number): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${esc(k || "Unsorted")} ${v}`)
    .join(", ");
}

export function statsText(data: StatsData, settings: StatsSettings, now = new Date()): string {
  const people = data.users.filter((u) => u.id !== settings.ownerId);
  const lines: string[] = [`📊 <b>Knowing stats</b> (${now.toISOString().slice(0, 16).replace("T", " ")} UTC)`];

  // People
  const started = people.filter((u) => u.usage.day);
  const newSince = (days: number) => started.filter((u) => u.usage.day > daysAgo(now, days)).length;
  const [activeDay, activeWeek, activeMonth] = windows(people.map((u) => u.active), now);
  const usedUp = (kind: PackKind) => people.filter((u) => u.usage[kind] >= settings.limits[kind]).length;
  const invited = people.filter((u) => u.referral.by).length;
  const rewards = people.reduce((sum, u) => sum + u.referral.rewarded, 0);
  lines.push(
    "",
    "<b>👥 People</b> (not counting you)",
    `Joined: ${people.length}${settings.cap ? ` of ${settings.cap} spots` : ""}. Never used it: ${people.length - started.length}.`,
    `New: ${newSince(1)} today, ${newSince(7)} this week, ${newSince(30)} in 30 days.`,
    `Active: ${activeDay} today, ${activeWeek} this week, ${activeMonth} in 30 days.`,
    `Used all free videos: ${usedUp("videos")}. Used all free questions: ${usedUp("questions")}.`,
    `Came from an invite link: ${invited}. Invite rewards given: ${rewards}.`,
    `Weekly flashback on: ${people.filter((u) => u.digest.on).length}.`,
  );

  // Videos
  const theirSaves = data.saves.filter((s) => s.userId !== settings.ownerId);
  const [savedDay, savedWeek, savedMonth] = windows(theirSaves.map((s) => s.createdAt), now);
  const types = new Map<string, number>();
  const folders = new Map<string, number>();
  for (const s of theirSaves) {
    types.set(s.type, (types.get(s.type) ?? 0) + 1);
    folders.set(s.folder, (folders.get(s.folder) ?? 0) + 1);
  }
  const savers = new Set(theirSaves.map((s) => s.userId)).size;
  lines.push(
    "",
    "<b>🎬 Videos saved</b>",
    `${savedDay} today, ${savedWeek} this week, ${savedMonth} in 30 days, ${theirSaves.length} in all.`,
    `People with a save: ${savers}. Average: ${savers ? (theirSaves.length / savers).toFixed(1) : "0"} each.`,
  );
  if (types.size) lines.push(`Kinds: ${top(types, 5)}.`);
  if (folders.size) lines.push(`Top folders: ${top(folders, 5)}.`);

  // Questions
  const theirChats = data.chats.filter((c) => c.userId !== settings.ownerId);
  const [askedDay, askedWeek, askedMonth] = windows(theirChats.map((c) => c.createdAt), now);
  lines.push("", "<b>💬 Questions asked</b>", `${askedDay} today, ${askedWeek} this week, ${askedMonth} in 30 days.`);

  // Money in
  const plans = people.map((u) => u.wallet.plan).filter((p) => planActive(p, now));
  const payments = people.flatMap((u) => u.wallet.paid);
  const recent = payments.filter((p) => Date.parse(p.at) >= now.getTime() - 30 * DAY_MS);
  const stars = (list: typeof payments) => list.reduce((sum, p) => sum + p.stars, 0);
  const starsMonth = stars(recent);
  lines.push(
    "",
    "<b>⭐ Money in</b>",
    `Knowing Plus: ${plural(plans.length, "subscriber")}${plans.length ? ` (renewal off: ${plans.filter((p) => p?.canceled).length}, slowed: ${plans.filter((p) => p && planLevel(p) === "slow").length}, paused: ${plans.filter((p) => p && planLevel(p) === "paused").length})` : ""}.`,
    `Paid: ${stars(payments)} ⭐ in all (${payments.filter((p) => p.plan).length} Plus payments, ${payments.filter((p) => !p.plan).length} refills), about ${money(stars(payments) * PAYOUT_PER_STAR)} to you.`,
    `Last 30 days: ${starsMonth} ⭐, about ${money(starsMonth * PAYOUT_PER_STAR)}.`,
    `Paying people: ${people.filter((u) => u.wallet.paid.length).length} of ${people.length} (${pct(people.filter((u) => u.wallet.paid.length).length, people.length)}).`,
    `Unused extras people hold: ${people.reduce((s, u) => s + u.wallet.videos, 0)} videos, ${people.reduce((s, u) => s + u.wallet.questions, 0)} questions.`,
  );

  // Money out
  lines.push("", "<b>🧾 AI spend</b> (measured)");
  if (!data.costs) {
    lines.push("Not tracked yet. Run the new SQL in Supabase to start.");
  } else {
    const since = (days: number) => data.costs!.filter((c) => c.day > daysAgo(now, days));
    const sum = (rows: CostRow[]) => rows.reduce((s, c) => s + c.dollars, 0);
    const month = since(30);
    const of = (kind: PackKind) => month.filter((c) => c.kind === kind);
    const avg = (rows: CostRow[]) => {
      const uses = rows.reduce((s, c) => s + c.uses, 0);
      return uses ? `${(sum(rows) / uses * 100).toFixed(1)}¢` : "none yet";
    };
    const failed = (rows: CostRow[]) => rows.reduce((s, c) => s + c.failed, 0);
    const uses = (rows: CostRow[]) => rows.reduce((s, c) => s + c.uses, 0);
    const yours = sum(month.filter((c) => c.userId === settings.ownerId));
    const profit = starsMonth * PAYOUT_PER_STAR - sum(month);
    lines.push(
      `${money(sum(since(1)))} today, ${money(sum(since(7)))} this week, ${money(sum(month))} in 30 days${yours ? ` (${money(yours)} of it yours)` : ""}.`,
      `Average: ${avg(of("videos"))} a video, ${avg(of("questions"))} a question.`,
      `Failed and given back (30 days): ${failed(of("videos"))} of ${uses(of("videos"))} videos, ${failed(of("questions"))} of ${uses(of("questions"))} questions.`,
      `30 days in minus out: ${profit >= 0 ? "" : "−"}${money(Math.abs(profit))}${profit >= 0 ? " ahead" : " behind"}.`,
    );
    const spenders = new Map<number, number>();
    for (const c of month) spenders.set(c.userId, (spenders.get(c.userId) ?? 0) + c.dollars);
    const biggest = [...spenders].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (biggest.length) lines.push(`Biggest costs (30 days): ${biggest.map(([id, d]) => `<code>${id}</code>${id === settings.ownerId ? " (you)" : ""} ${money(d)}`).join(", ")}.`);
  }

  // Most active
  const savesBy = new Map<number, number>();
  for (const s of theirSaves) savesBy.set(s.userId, (savesBy.get(s.userId) ?? 0) + 1);
  const chatsBy = new Map<number, number>();
  for (const c of theirChats) chatsBy.set(c.userId, (chatsBy.get(c.userId) ?? 0) + 1);
  const ranked = people
    .map((u) => ({ id: u.id, saves: savesBy.get(u.id) ?? 0, chats: chatsBy.get(u.id) ?? 0 }))
    .filter((u) => u.saves || u.chats)
    .sort((a, b) => b.saves + b.chats - (a.saves + a.chats))
    .slice(0, 5);
  if (ranked.length) lines.push("", "<b>🏆 Most active</b>", ...ranked.map((u) => `<code>${u.id}</code>: ${plural(u.saves, "save")}, ${plural(u.chats, "question")} in 30 days`));

  return lines.join("\n");
}
