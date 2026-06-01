import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const url =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Provision a Neon/Vercel Postgres DB and put the connection string in .env.local (and in Vercel project env vars).",
  );
}

const sql = neon(url);
export const db = drizzle(sql, { schema });
export { schema };
