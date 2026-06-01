import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { extractText, getDocumentProxy } from "unpdf";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { chunks, EMBEDDING_DIM } from "../src/db/schema";

// ---- Sources ----
const SOURCES = [
  {
    url: "https://static-evollis.evollis.com/cgs/Conditions_generales_Pack_Evolution.pdf",
    title: "Conditions Générales — Pack Evolution (Evollis)",
  },
  {
    url: "https://static-samsung.evollis.com/pdf/Conditions-Generales-et-Particulieres-du-Contrat-de-Services.pdf",
    title: "Conditions Générales et Particulières — Samsung Rent+",
  },
  {
    url: "https://static-michelin.evollis.com/pdf/conditions_generales_de_l_offre.pdf",
    title: "Contrat de location longue durée — Michelin (Evollis)",
  },
  {
    url: "https://static-samsung.evollis.com/pdi/uzit/pdf/uzit_direct_cgl_production.pdf",
    title: "Conditions Générales de Location — UZ'IT (Evollis)",
  },
];

// ---- Voyage free-tier-safe parameters ----
// Free tier: 3 RPM, 10K TPM. We send small batches well under both.
const VOYAGE_MODEL = "voyage-multilingual-2";
const VOYAGE_BATCH = 8;            // ~8 chunks * ~350 tokens = ~2800 tokens/req
const VOYAGE_DELAY_MS = 21_000;    // 21s between requests keeps us at < 3 RPM
const TARGET_CHARS = 1400;         // ~350 tokens per chunk
const OVERLAP_CHARS = 180;

const VOYAGE_KEY = process.env.VOYAGE_API_KEY;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  if (!VOYAGE_KEY) throw new Error("VOYAGE_API_KEY missing in .env.local");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VOYAGE_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: inputType,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // On 429, sleep and let the caller retry.
    if (res.status === 429) throw new Error(`RATE_LIMIT: ${body}`);
    throw new Error(`Voyage ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

async function embedWithRetry(texts: string[]): Promise<number[][]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await embed(texts, "document");
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("RATE_LIMIT")) {
        const wait = (attempt + 1) * 25_000;
        console.log(`  rate-limited, sleeping ${wait / 1000}s…`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Gave up after 5 rate-limit retries");
}

async function fetchPdfText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch ${url} -> ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocumentProxy(buf);
  const { text } = await extractText(doc, { mergePages: true });
  return text as string;
}

function chunkText(text: string): string[] {
  const clean = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const sentences = clean
    .split(/(?<=[.?!])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const result: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (!cur) {
      cur = s;
      continue;
    }
    if (cur.length + s.length + 1 <= TARGET_CHARS) {
      cur += " " + s;
    } else {
      result.push(cur);
      const tail = cur.length > OVERLAP_CHARS ? cur.slice(-OVERLAP_CHARS) : "";
      cur = (tail ? tail + " " : "") + s;
    }
  }
  if (cur) result.push(cur);
  return result.filter((c) => c.length > 80);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL missing");
  const sql = neon(dbUrl);
  const db = drizzle(sql);

  const startedAt = Date.now();

  for (const src of SOURCES) {
    console.log(`\n=== ${src.title} ===`);

    // Idempotent: skip if this source is already in DB.
    const existing = await db
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.sourceUrl, src.url))
      .limit(1);
    if (existing.length > 0) {
      console.log(`  already ingested, skipping`);
      continue;
    }

    try {
      console.log(`  fetch ${src.url}`);
      const raw = await fetchPdfText(src.url);
      const pieces = chunkText(raw);
      console.log(
        `  parsed ${raw.length} chars → ${pieces.length} chunks`,
      );

      for (let i = 0; i < pieces.length; i += VOYAGE_BATCH) {
        const batch = pieces.slice(i, i + VOYAGE_BATCH);
        const vectors = await embedWithRetry(batch);
        if (vectors[0]?.length !== EMBEDDING_DIM) {
          throw new Error(
            `Embedding dim ${vectors[0]?.length} != schema ${EMBEDDING_DIM}`,
          );
        }
        await db.insert(chunks).values(
          batch.map((content, j) => ({
            sourceUrl: src.url,
            sourceTitle: src.title,
            content,
            embedding: vectors[j],
          })),
        );
        const done = Math.min(i + VOYAGE_BATCH, pieces.length);
        console.log(
          `  ${done}/${pieces.length} chunks (elapsed ${Math.round(
            (Date.now() - startedAt) / 1000,
          )}s)`,
        );
        // Respect 3 RPM unless we're done.
        if (done < pieces.length) await sleep(VOYAGE_DELAY_MS);
      }
    } catch (err) {
      console.error(`  FAILED on ${src.url}:`, (err as Error).message);
    }
  }

  const { rows } = (await db.execute(
    drizzleSql`SELECT count(*)::int AS n FROM chunks`,
  )) as unknown as { rows: { n: number }[] };
  console.log(
    `\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s. Total chunks: ${rows[0]?.n ?? "?"}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
