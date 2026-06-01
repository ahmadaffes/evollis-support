import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql as drizzleSql } from "drizzle-orm";

const QUERY = process.argv[2] ?? "Quelles sont les conditions pour resilier mon contrat?";
const VOYAGE_MODEL = "voyage-multilingual-2";

async function main() {
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [QUERY],
      model: VOYAGE_MODEL,
      input_type: "query",
    }),
  });
  const j = (await r.json()) as { data: { embedding: number[] }[] };
  const vec = j.data[0]!.embedding;
  const literal = `[${vec.join(",")}]`;

  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);
  const res = (await db.execute(drizzleSql`
    SELECT source_title, 1 - (embedding <=> ${literal}::vector) AS similarity,
           substring(content for 200) as preview
    FROM chunks
    ORDER BY embedding <=> ${literal}::vector
    LIMIT 8
  `)) as unknown as { rows: { source_title: string; similarity: number; preview: string }[] };

  console.log(`Query: "${QUERY}"\n`);
  for (const row of res.rows) {
    console.log(`sim=${Number(row.similarity).toFixed(3)}  ${row.source_title.slice(0, 50)}`);
    console.log(`  ${row.preview.replace(/\s+/g, " ")}\n`);
  }
}

main().catch(console.error);
