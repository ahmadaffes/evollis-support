import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import type { Config } from "drizzle-kit";

const url =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL;

if (!url) {
  throw new Error("Set DATABASE_URL in .env.local before running drizzle-kit.");
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
} satisfies Config;
