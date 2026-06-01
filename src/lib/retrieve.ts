import { sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks } from "@/db/schema";

const VOYAGE_MODEL = "voyage-multilingual-2";

export type RetrievedChunk = {
  id: string;
  sourceUrl: string;
  sourceTitle: string;
  content: string;
  similarity: number; // 0..1, higher = closer
};

async function embedQuery(text: string): Promise<number[]> {
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
      model: VOYAGE_MODEL,
      input_type: "query",
    }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0]!.embedding;
}

/**
 * Retrieve the top-k chunks most similar to the user's query, using
 * pgvector cosine distance. Results above MAX_DISTANCE are dropped to
 * avoid pulling in irrelevant context.
 */
export async function retrieveContext(
  query: string,
  k = 4,
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];

  let vector: number[];
  try {
    vector = await embedQuery(query);
  } catch (err) {
    console.error("[retrieve] embed failed:", err);
    return [];
  }

  // pgvector's "<=>" operator is cosine distance (0..2). We want small.
  // similarity = 1 - distance (range -1..1, but for normalized text usually 0..1)
  const literal = `[${vector.join(",")}]`;

  try {
    const rows = (await db.execute(sql`
      SELECT
        id::text as id,
        source_url,
        source_title,
        content,
        1 - (embedding <=> ${literal}::vector) AS similarity
      FROM ${chunks}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${k}
    `)) as unknown as {
      rows: {
        id: string;
        source_url: string;
        source_title: string;
        content: string;
        similarity: number;
      }[];
    };

    return rows.rows
      .map((r) => ({
        id: r.id,
        sourceUrl: r.source_url,
        sourceTitle: r.source_title,
        content: r.content,
        similarity: Number(r.similarity),
      }))
      .filter((r) => r.similarity > 0.35); // tune threshold
  } catch (err) {
    console.error("[retrieve] query failed:", err);
    return [];
  }
}
