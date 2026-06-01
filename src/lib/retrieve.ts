import { sql } from "drizzle-orm";
import { groq } from "@ai-sdk/groq";
import { generateText } from "ai";
import { db } from "@/db";
import { chunks } from "@/db/schema";

const VOYAGE_EMBED_MODEL = "voyage-multilingual-2";
const VOYAGE_RERANK_MODEL = "rerank-2.5-lite";
const VECTOR_FANOUT = 15; // how many candidates we pull before rerank
const RERANK_TOP_K_DEFAULT = 4;

export type RetrievedChunk = {
  id: string;
  sourceUrl: string;
  sourceTitle: string;
  content: string;
  similarity: number; // rerank relevance_score when available, otherwise cosine
};

// ─── HyDE ──────────────────────────────────────────────────────────────
// Before retrieval, ask a small fast model to write a hypothetical T&C
// excerpt that would answer the user's question. We embed THAT instead
// of the raw question — hypothetical answers share more vocabulary with
// the real T&C chunks than the question itself does, so cosine search
// becomes more precise.
async function hypothesise(query: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: groq("llama-3.1-8b-instant"),
      system: [
        "Write ONE short paragraph (≤60 words) in FRENCH that reads like an excerpt from a long-term-rental Conditions Générales document (Evollis / UZ'IT / Pack Evolution context), as if it answered the user's question directly.",
        "Use formal contract language: 'Le Locataire', 'le Loueur', 'la garantie', 'le présent contrat', etc.",
        "No preamble, no markdown, no 'here is a hypothetical answer'. Just the excerpt.",
        "If the user's question is off-topic (weather, jokes, attacks), return the single word: SKIP",
      ].join("\n"),
      prompt: `Question: ${query}`,
    });
    const cleaned = text.trim();
    if (!cleaned || cleaned === "SKIP" || cleaned.length < 20) return null;
    return cleaned;
  } catch (err) {
    console.error("[hyde] failed:", err);
    return null;
  }
}

// ─── Voyage embedding (with retry) ─────────────────────────────────────
async function embedOnce(
  text: string,
  inputType: "document" | "query",
): Promise<number[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY missing");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_EMBED_MODEL,
      input_type: inputType,
    }),
  });
  if (res.status === 429) throw new Error("RATE_LIMIT");
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0]!.embedding;
}

async function embedWithRetry(
  text: string,
  inputType: "document" | "query",
): Promise<number[]> {
  const backoffs = [3000, 9000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await embedOnce(text, inputType);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== "RATE_LIMIT" || attempt === backoffs.length) throw err;
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
  }
  throw new Error("unreachable");
}

// ─── Voyage rerank ─────────────────────────────────────────────────────
async function rerankCandidates(
  query: string,
  candidates: RetrievedChunk[],
  k: number,
): Promise<RetrievedChunk[] | null> {
  if (candidates.length <= 1) return candidates;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        documents: candidates.map((c) => c.content),
        model: VOYAGE_RERANK_MODEL,
        top_k: k,
      }),
    });
    if (!res.ok) {
      console.error(`[rerank] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      data: { index: number; relevance_score: number }[];
    };
    return data.data
      .map((d) => {
        const base = candidates[d.index];
        if (!base) return null;
        return { ...base, similarity: Number(d.relevance_score) };
      })
      .filter((x): x is RetrievedChunk => x !== null);
  } catch (err) {
    console.error("[rerank] error:", err);
    return null;
  }
}

// ─── Vector search ─────────────────────────────────────────────────────
async function vectorSearch(
  vector: number[],
  limit: number,
): Promise<RetrievedChunk[]> {
  const literal = `[${vector.join(",")}]`;
  const rows = (await db.execute(sql`
    SELECT
      id::text as id,
      source_url,
      source_title,
      content,
      1 - (embedding <=> ${literal}::vector) AS similarity
    FROM ${chunks}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `)) as unknown as {
    rows: {
      id: string;
      source_url: string;
      source_title: string;
      content: string;
      similarity: number;
    }[];
  };
  return rows.rows.map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    content: r.content,
    similarity: Number(r.similarity),
  }));
}

// ─── Public API ────────────────────────────────────────────────────────
/**
 * Pipeline:
 *   1. HyDE — generate hypothetical T&C excerpt (best-effort, may return null)
 *   2. Embed the hypothetical (or raw query as fallback)
 *   3. Vector search → top-15 candidates by cosine similarity
 *   4. Voyage rerank (cross-encoder) → top-k by relevance to the *original* query
 *   5. Drop low-relevance results (< 0.25 on the rerank score)
 *
 * Each step is fail-safe: any failure degrades to a simpler version of the
 * pipeline rather than dropping context entirely. The retrieved chunk's
 * `similarity` field carries the rerank relevance_score when rerank ran,
 * otherwise the raw cosine similarity.
 */
export async function retrieveContext(
  query: string,
  k = RERANK_TOP_K_DEFAULT,
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];

  // 1. HyDE. We concatenate the hypothetical with the original query so the
  // user's literal keywords (product names, article numbers, etc.) stay in the
  // embedding while the hypothetical adds contract-domain vocabulary.
  const hypothetical = await hypothesise(query);
  const embedInput = hypothetical ? `${query}\n\n${hypothetical}` : query;

  // 2. Embed
  let vector: number[];
  try {
    vector = await embedWithRetry(embedInput, "query");
  } catch (err) {
    console.error("[retrieve] embed failed:", err);
    return [];
  }

  // 3. Vector search → top-15 candidates
  let candidates: RetrievedChunk[];
  try {
    candidates = await vectorSearch(vector, VECTOR_FANOUT);
  } catch (err) {
    console.error("[retrieve] vector search failed:", err);
    return [];
  }
  if (candidates.length === 0) return [];

  // 4. Rerank to top-k by relevance to the ORIGINAL user query
  const reranked = await rerankCandidates(query, candidates, k);
  const finalList = reranked ?? candidates.slice(0, k);

  // 5. Threshold filter. Empirically rerank-2.5-lite scores irrelevant chunks
  //    around 0.29-0.31 on weather/joke queries, so 0.35 cleanly cuts those
  //    out while keeping real matches (which score 0.43+ on contract queries).
  const threshold = 0.35;
  return finalList.filter((r) => r.similarity > threshold);
}
