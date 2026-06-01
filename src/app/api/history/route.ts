import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages as messagesTable } from "@/db/schema";

export const runtime = "nodejs";

const SESSION_COOKIE = "evollis_session";

export async function GET() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return Response.json({ messages: [] });

  const convo = await db.query.conversations.findFirst({
    where: eq(conversations.sessionId, sessionId),
  });
  if (!convo) return Response.json({ messages: [] });

  const rows = await db.query.messages.findMany({
    where: eq(messagesTable.conversationId, convo.id),
    orderBy: asc(messagesTable.createdAt),
  });

  // Map to AI SDK UIMessage shape that useChat expects.
  const uiMessages = rows.map((r) => ({
    id: r.id,
    role: r.role as "user" | "assistant",
    parts: [{ type: "text" as const, text: r.content }],
    metadata: {
      category: r.category,
      language: r.language,
      createdAt: r.createdAt.toISOString(),
    },
  }));

  return Response.json({ messages: uiMessages });
}

export async function DELETE() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return Response.json({ ok: true });

  // Drop the conversation; ON DELETE CASCADE removes messages too.
  await db.delete(conversations).where(eq(conversations.sessionId, sessionId));
  return Response.json({ ok: true });
}

