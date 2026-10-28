/**
 * Turn a web page's HTML into plain readable text, without a DOM.
 * Good enough to give the model an article's words; not a full readability engine.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decode the common named and numeric HTML entities. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return safeChar(parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith("#")) return ENTITIES[lower] ?? safeChar(parseInt(lower.slice(1), 10), whole);
    return ENTITIES[lower] ?? whole;
  });
}

function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : fallback;
}

/** Read the page's <title>, if any. */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

/**
 * Strip scripts, styles, navigation and tags, keeping paragraph breaks.
 * Prefers the <article> or <main> element when the page has one.
 */
export function htmlToText(html: string): string {
  const focused =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  const text = focused
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
