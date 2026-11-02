/**
 * Extra videos and questions, sold for Telegram Stars any time (/buy) and
 * offered when someone's free ones run out. Telegram requires Stars for digital goods sold in bots, and
 * requires /terms, /support and /paysupport:
 * https://core.telegram.org/bots/payments-stars
 */
import type { InlineButton, Invoice, Pack, PackKind } from "./types";

/** The pack sizes on sale. Each one's price comes from its worst case (costs.ts pricedPacks). */
export const PACK_SIZES: Record<PackKind, number[]> = { videos: [10, 20, 50], questions: [20, 40, 100] };

/** "10 more videos" */
export const packName = (pack: { kind: PackKind; count: number }) => `${pack.count} more ${pack.kind}`;

export function invoiceFor(pack: Pack): Invoice {
  return {
    title: packName(pack),
    description: `Used after your free ${pack.kind}, and they never expire. By paying you agree to the /terms.`,
    payload: `pack:${pack.kind}:${pack.count}:${pack.stars}`,
    stars: pack.stars,
  };
}

/** What a payment was for, read back from its payload. Null if it isn't one of ours (or is from before pack sizes). */
export function readPack(payload: string): Pack | null {
  const m = /^pack:(videos|questions):(\d+):(\d+)$/.exec(payload);
  return m ? { kind: m[1] as PackKind, count: Number(m[2]), stars: Number(m[3]) } : null;
}

/** "10 videos for 150 ⭐, 20 for 300 ⭐, 50 for 750 ⭐" */
export function priceList(packs: Pack[], kind: PackKind): string {
  return packs
    .filter((p) => p.kind === kind)
    .map((p, i) => `${p.count}${i ? "" : ` ${kind}`} for ${p.stars} ⭐`)
    .join(", ");
}

/** Buy buttons: one kind's packs one per row, or all of them with videos and questions side by side. */
export function buyButtons(packs: Pack[], kind?: PackKind): InlineButton[][] {
  const button = (p: Pack, label: string): InlineButton => ({ text: `${label}, ${p.stars} ⭐`, callback_data: `buy:${p.kind}:${p.count}` });
  if (kind) return packs.filter((p) => p.kind === kind).map((p) => [button(p, packName(p))]);
  const videos = packs.filter((p) => p.kind === "videos");
  const questions = packs.filter((p) => p.kind === "questions");
  return Array.from({ length: Math.max(videos.length, questions.length) }, (_, i) =>
    [videos[i], questions[i]].filter((p): p is Pack => !!p).map((p) => button(p, `${p.count} ${p.kind}`)),
  );
}

export const TERMS = `<b>Knowing terms</b>

1. Knowing is in early testing. You get a few free videos and questions to start. They're given once and don't refill.
2. You can buy extra videos and questions with Telegram Stars any time with /buy. They never expire and are used after your free ones run out. They can't be turned back into Stars or money, except by a refund.
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
