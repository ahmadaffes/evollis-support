import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  vector,
} from "drizzle-orm/pg-core";

// Voyage multilingual-2 produces 1024-dim embeddings.
export const EMBEDDING_DIM = 1024;

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("conversations_session_idx").on(t.sessionId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    category: text("category"), // facturation | technique | contrat | commande | autre
    language: text("language"), // ISO 639-1
    reasoning: text("reasoning"), // router's justification (user msgs only)
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId)],
);

// Knowledge-base chunks for RAG. Populated by scripts/ingest.ts.
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceUrl: text("source_url").notNull(),
    sourceTitle: text("source_title").notNull(),
    section: text("section"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("chunks_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("chunks_source_idx").on(t.sourceUrl),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
