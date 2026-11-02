/**
 * Invite a friend, earn free videos. Everyone has their own invite link
 * (/invite). Once a friend who joined with it has really used Knowing (saved a
 * video and asked something), the person who invited them gets REFERRAL_REWARD
 * free videos, for up to REFERRAL_MAX friends. Waiting for real use means a
 * fake account that only taps the link earns nothing, and friends who join this
 * way still use up the invite spots, so the total stays capped.
 *
 * The link's code is signed with a key made from the webhook secret, so a link
 * can't be made up for someone without it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Free videos for each friend who starts using it. */
export const REFERRAL_REWARD = 3;
/** Most friends who earn a reward, per person. */
export const REFERRAL_MAX = 5;
/** What a friend has to do first: save this many videos and ask this many questions. */
export const REFERRAL_VIDEOS = 1;
export const REFERRAL_QUESTIONS = 1;

const sign = (key: string, userId: number) => createHmac("sha256", key).update(`knowing-referral:${userId}`).digest("base64url").slice(0, 10);

/** The code in someone's own invite link (t.me/<bot>?start=<code>). Telegram allows letters, digits, _ and - in it. */
export function referralCode(key: string, userId: number): string {
  return `r${userId.toString(36)}_${sign(key, userId)}`;
}

/** Who a referral code belongs to, or 0 if it isn't one or was made up. */
export function readReferral(key: string, code: string): number {
  const m = /^r([0-9a-z]{1,13})_([A-Za-z0-9_-]{10})$/.exec(code);
  if (!m || !key) return 0;
  const id = parseInt(m[1]!, 36);
  return Number.isSafeInteger(id) && id > 0 && timingSafeEqual(Buffer.from(m[2]!), Buffer.from(sign(key, id))) ? id : 0;
}

/** True once a friend has done enough for the person who invited them to be rewarded. */
export function hasStarted(usage: { videos: number; questions: number }): boolean {
  return usage.videos >= REFERRAL_VIDEOS && usage.questions >= REFERRAL_QUESTIONS;
}
