/**
 * The production retriever: chunks and embeddings in Supabase (pgvector),
 * searched by the match_chunks function in docs/supabase.sql, which runs the
 * same hybrid search as MemoryRetriever: meaning + exact words, fused by rank.
 */
import "server-only";
import { chunkSave, type Embedder, type Hit, type Retriever } from "./rag";
import type { Save } from "./types";

const DEFAULT_EMBED_URL = "https://api.openai.com/v1/embeddings";
/** text-embedding-3-small: 1536 dimensions, about $0.02 per million tokens. */
export const EMBED_MODEL = process.env.KNOWING_EMBED_MODEL || "text-embedding-3-small";

/** An OpenAI-compatible embeddings endpoint, or null when no key is set (search then uses words only). */
export function createEmbedder(): Embedder | null {
  const key = process.env.KNOWING_EMBED_KEY || process.env.OPENAI_API_KEY;
  if (!key) return null;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const res = await fetch(process.env.KNOWING_EMBED_URL || DEFAULT_EMBED_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => t.slice(0, 8_000)) }),
      });
      if (!res.ok) throw new Error(`Embeddings failed: ${res.status} ${await res.text().catch(() => "")}`);
      const body = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
      const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return data.map((d) => d.embedding);
    },
  };
}

export class SupabaseRetriever implements Retriever {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly embedder: Embedder | null,
  ) {}

  private async rest(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) throw new Error(`Supabase ${path.split("?")[0]}: ${res.status} ${await res.text().catch(() => "")}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async index(save: Save): Promise<void> {
    const chunks = chunkSave(save);
    const vectors = this.embedder ? await this.embedder.embed(chunks.map((c) => c.text)) : [];
    await this.remove(save.userId, save.id);
    await this.rest("save_chunks", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(
        chunks.map((c, i) => ({
          save_id: c.saveId,
          user_id: c.userId,
          kind: c.kind,
          content: c.text,
          embedding: vectors[i] ? `[${vectors[i]!.join(",")}]` : null,
        })),
      ),
    });
  }

  async remove(userId: number, saveId: string): Promise<void> {
    await this.rest(`save_chunks?save_id=eq.${encodeURIComponent(saveId)}&user_id=eq.${userId}`, { method: "DELETE" });
  }

  async search(userId: number, query: string, k = 12): Promise<Hit[]> {
    const [vector] = this.embedder ? await this.embedder.embed([query]) : [];
    const rows = (await this.rest("rpc/match_chunks", {
      method: "POST",
      body: JSON.stringify({ p_user_id: userId, p_query: query, p_embedding: vector ? `[${vector.join(",")}]` : null, p_k: k }),
    })) as Array<{ save_id: string; kind: Hit["kind"]; content: string; score: number }> | null;
    return (rows ?? []).map((r) => ({ saveId: r.save_id, kind: r.kind, text: r.content, score: Number(r.score) }));
  }
}
