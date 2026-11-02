/**
 * Extra videos and questions, sold for Telegram Stars when someone's free daily
 * amount runs out. Telegram requires Stars for digital goods sold in bots, and
 * requires /terms, /support and /paysupport:
 * https://core.telegram.org/bots/payments-stars
 */
import type { InlineButton, Invoice, PackKind } from "./types";

/**
 * What one pack adds. At 100 Stars (about $1.30 paid out) even the worst case
 * stays above cost: 10 videos at up to ~8.5¢, 20 questions at up to ~5¢.
 */
export const PACKS: Record<PackKind, number> = { videos: 10, questions: 20 };

/** "10 more videos" */
export const packName = (kind: PackKind) => `${PACKS[kind]} more ${kind}`;

export function invoiceFor(kind: PackKind, stars: number): Invoice {
  return {
    title: packName(kind),
    description: `For when your free ${kind} for the day run out. They never expire. By paying you agree to the /terms.`,
    payload: `pack:${kind}:${stars}`,
    stars,
  };
}

/** What a payment was for, read back from its payload. Null if it isn't one of ours. */
export function readPack(payload: string): { kind: PackKind; stars: number } | null {
  const m = /^pack:(videos|questions):(\d+)$/.exec(payload);
  return m ? { kind: m[1] as PackKind, stars: Number(m[2]) } : null;
}

export const buyButton = (kind: PackKind, stars: number): InlineButton[][] => [[{ text: `${packName(kind)}, ${stars} ⭐`, callback_data: `buy:${kind}` }]];

export const TERMS = `<b>Knowing terms</b>

1. Knowing is in early testing. You get a few free videos and questions each day.
2. You can buy extra videos and questions with Telegram Stars. They never expire and are used after your free ones run out. They can't be turned back into Stars or money, except by a refund.
3. If a purchase goes wrong, send /paysupport and you'll get help or a refund.
4. Knowing can make mistakes. Double-check anything important before you rely on it.
5. /delete erases your saves, our chats and what I remember about you. Extras you bought stay with you.

Telegram's own support can't help with purchases made in this bot. Use /paysupport instead.`;

export const SUPPORT_HELP = `Write your question or problem in the same message, like:
<code>/support it didn't answer my last message</code>

The owner gets it and will reply here.`;

export const PAYSUPPORT_HELP = `Tell me what went wrong in the same message, like:
<code>/paysupport I paid but didn't get my videos</code>

The owner gets it and can fix it or refund you. Telegram's own support can't help with purchases made in this bot.`;
