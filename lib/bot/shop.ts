/**
 * Extra videos and questions, sold for Telegram Stars any time (/buy) and
 * offered when someone's free ones run out. Telegram requires Stars for digital goods sold in bots, and
 * requires /terms, /support and /paysupport:
 * https://core.telegram.org/bots/payments-stars
 */
import type { InlineButton, Invoice, Pack } from "./types";

/**
 * The refill packs on sale: videos and questions together, so it's one
 * purchase. Just one, so the choice is easy (Aiden: "keep the options down").
 * Its price comes from its worst case (costs.ts pricedPacks).
 */
export const PACK_SIZES: Array<{ videos: number; questions: number }> = [{ videos: 5, questions: 10 }];

/** "5 videos + 10 questions" (or just one kind, for a payment from before bundles). */
export function packName(pack: { videos: number; questions: number }): string {
  const parts = [pack.videos && `${pack.videos} video${pack.videos === 1 ? "" : "s"}`, pack.questions && `${pack.questions} question${pack.questions === 1 ? "" : "s"}`].filter(Boolean);
  return parts.join(" + ");
}

export function invoiceFor(pack: Pack): Invoice {
  return {
    title: packName(pack),
    description: `Used after your free ones, and they never expire. By paying you agree to the /terms.`,
    payload: `bundle:${pack.videos}:${pack.questions}:${pack.stars}`,
    stars: pack.stars,
  };
}

/** What a payment was for, read back from its payload. Null if it isn't one of ours. Reads packs from before bundles too, for refunds. */
export function readPack(payload: string): Pack | null {
  const bundle = /^bundle:(\d+):(\d+):(\d+)$/.exec(payload);
  if (bundle) return { videos: Number(bundle[1]), questions: Number(bundle[2]), stars: Number(bundle[3]) };
  const old = /^pack:(videos|questions):(\d+):(\d+)$/.exec(payload);
  if (!old) return null;
  const count = Number(old[2]);
  return { videos: old[1] === "videos" ? count : 0, questions: old[1] === "questions" ? count : 0, stars: Number(old[3]) };
}

/** "5 videos + 10 questions for 150 ⭐" (and ", 10 + 20 for 300 ⭐" for each more pack) */
export function priceList(packs: Pack[]): string {
  return packs.map((p, i) => `${i ? `${p.videos} + ${p.questions}` : packName(p)} for ${p.stars} ⭐`).join(", ");
}

/** Buy buttons: one bundle a row. */
export function buyButtons(packs: Pack[]): InlineButton[][] {
  return packs.map((p) => [{ text: `${packName(p)}, ${p.stars} ⭐`, callback_data: `buy:${p.videos}:${p.questions}` }]);
}

export const TERMS = `<b>Knowing terms</b>

1. Knowing is in early testing. You get a few free videos and questions to start. They're given once and don't refill.
2. You can buy extra videos and questions, together in one pack, with Telegram Stars any time with /buy. They never expire and are used after your free ones run out. They can't be turned back into Stars or money, except by a refund.
3. Knowing Plus (/plan) is a monthly Telegram Stars subscription with videos and questions every day. They start again at midnight UTC and unused ones don't carry over. It renews every 30 days until you cancel, which you can do any time with /plan; it keeps working until the month ends. Fair use: if a month's use gets very heavy, it drops to fewer a day, and at most pauses until it renews. Your free ones and extras still work then.
4. If a purchase goes wrong, send /paysupport and you'll get help or a refund.
5. Knowing can make mistakes. Double-check anything important before you rely on it.
6. /delete erases your saves, our chats and what I remember about you. Extras and Knowing Plus stay with you.

Telegram's own support can't help with purchases made in this bot. Use /paysupport instead.`;

export const SUPPORT_HELP = `Write your question or problem in the same message, like:
<code>/support it didn't answer my last message</code>

The owner gets it and will reply here.`;

export const PAYSUPPORT_HELP = `Tell me what went wrong in the same message, like:
<code>/paysupport I paid but didn't get my videos</code>

The owner gets it and can fix it or refund you. Telegram's own support can't help with purchases made in this bot.`;
