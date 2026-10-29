/**
 * Retrieval for the bot: finding the saves (and the exact passages inside
 * them) that answer a question.
 *
 * - Every save is split into chunks: its card (title, steps), its details,
 *   and the video's own words (transcript + caption) in overlapping pieces.
 *   Each chunk starts with the save's title and topic, so a piece of
 *   transcript still says what it belongs to.
 * - Search is hybrid: meaning (vector embeddings) and exact words (Postgres
 *   full-text, good for names like "Mira" or "Bank"), merged with reciprocal
 *   rank fusion. Without an embeddings key it still works on words alone.
 * - Answers get the best-matching saves plus their best passages verbatim,
 *   so details the summary dropped are still there.
 */
import type { Save } from "./types";

export interface Chunk {
  saveId: string;
  userId: number;
  kind: "card" | "details" | "source";
  text: string;
}

export interface Hit {
  saveId: string;
  text: string;
  kind: Chunk["kind"];
  score: number;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface Retriever {
  index(save: Save): Promise<void>;
  remove(userId: number, saveId: string): Promise<void>;
  /** Best chunks for a query, highest score first. */
  search(userId: number, query: string, k?: number): Promise<Hit[]>;
}

/** Characters per transcript chunk, and how much neighbouring chunks overlap. */
export const CHUNK_CHARS = 900;
const OVERLAP = 150;

/** Split long text into overlapping pieces, preferring sentence ends. */
export function splitText(text: string, size = CHUNK_CHARS, overlap = OVERLAP): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const stop = clean.lastIndexOf(". ", end);
      if (stop > start + size / 2) end = stop + 1;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** All the chunks for one save. */
export function chunkSave(save: Save): Chunk[] {
  const head = `${save.title} (${save.topic || "no topic"}, ${save.type})`;
  const base = { saveId: save.id, userId: save.userId };
  const chunks: Chunk[] = [
    { ...base, kind: "card", text: `${head}\n${save.summary}\n${save.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` },
  ];
  const details = [save.details, save.words && `What it says: ${save.words}`].filter(Boolean).join("\n");
  if (details) chunks.push({ ...base, kind: "details", text: `${head}\n${details}` });
  for (const piece of splitText(save.source)) chunks.push({ ...base, kind: "source", text: `${head}\nFrom the video: ${piece}` });
  return chunks;
}

/**
 * Reciprocal rank fusion: merge ranked lists into one. Items near the top of
 * any list win; items high in both win most. `k` damps the effect of rank.
 */
export function fuseRanks<T>(lists: T[][], key: (item: T) => string, k = 60): Array<{ item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const prev = scores.get(id);
      const add = 1 / (k + rank + 1);
      if (prev) prev.score += add;
      else scores.set(id, { item, score: add });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

/** Group chunk hits by save, best save first, keeping each save's best passages. */
export function groupHits(hits: Hit[], maxSaves = 6, passagesPerSave = 2): Array<{ saveId: string; passages: string[] }> {
  const order: string[] = [];
  const passages = new Map<string, string[]>();
  for (const h of hits) {
    if (!passages.has(h.saveId)) {
      if (order.length >= maxSaves) continue;
      order.push(h.saveId);
      passages.set(h.saveId, []);
    }
    const list = passages.get(h.saveId)!;
    if (h.kind === "source" && list.length < passagesPerSave) list.push(h.text.replace(/^[^\n]*\nFrom the video: /, ""));
  }
  return order.map((saveId) => ({ saveId, passages: passages.get(saveId) ?? [] }));
}

/** The search text: the question, plus the previous message when the question leans on it ("and the other one?"). */
export function searchQuery(question: string, previousUserMessage = ""): string {
  const short = question.split(/\s+/).length < 8;
  const refers = /\b(it|that|this|those|these|one|again|other|same|them)\b/i.test(question);
  return short || refers ? `${question} ${previousUserMessage}`.trim() : question;
}

export const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Same cut-off as the SQL (cosine distance < 0.75): chunks less similar than this aren't "close in meaning". */
export const MIN_SIMILARITY = 0.25;

const terms = (t: string) => t.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

/** The same hybrid search, in memory. Used in tests and as a reference for the SQL. */
export class MemoryRetriever implements Retriever {
  chunks: Array<Chunk & { embedding: number[] | null }> = [];
  constructor(private readonly embedder: Embedder | null = null) {}

  async index(save: Save) {
    await this.remove(save.userId, save.id);
    const chunks = chunkSave(save);
    const vectors = this.embedder ? await this.embedder.embed(chunks.map((c) => c.text)) : [];
    chunks.forEach((c, i) => this.chunks.push({ ...c, embedding: vectors[i] ?? null }));
  }
  async remove(userId: number, saveId: string) {
    this.chunks = this.chunks.filter((c) => !(c.userId === userId && c.saveId === saveId));
  }
  async search(userId: number, query: string, k = 12): Promise<Hit[]> {
    const mine = this.chunks.filter((c) => c.userId === userId);
    const q = new Set(terms(query));
    const byWords = mine
      .map((c) => ({ c, s: terms(c.text).filter((t) => q.has(t)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    let byMeaning: typeof mine = [];
    if (this.embedder) {
      const [qv] = await this.embedder.embed([query]);
      byMeaning = mine
        .filter((c) => c.embedding && qv)
        .map((c) => ({ c, s: cosine(c.embedding!, qv!) }))
        .filter((x) => x.s > MIN_SIMILARITY)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((x) => x.c);
    }
    return fuseRanks([byWords, byMeaning], (c) => `${c.saveId}|${c.kind}|${c.text}`)
      .slice(0, k)
      .map(({ item, score }) => ({ saveId: item.saveId, text: item.text, kind: item.kind, score }));
  }
}
