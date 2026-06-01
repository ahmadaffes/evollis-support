"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useState, useRef, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const EXAMPLES = [
  "Je n'ai pas été prélevé ce mois-ci, est-ce normal ?",
  "My laptop screen is broken, what should I do?",
  "Puis-je changer de téléphone avant la fin de mon contrat 36 mois ?",
  "Where is my order?",
];

type Source = { n: number; title: string; url: string; similarity: number };
type Meta = {
  category?: string;
  language?: string;
  reason?: string;
  sources?: Source[];
};

// Replace [1], [2], [1][3] etc. with superscript links to the corresponding source.
function renderWithCitations(
  text: string,
  sources: Source[] | undefined,
  role: string,
): React.ReactNode {
  if (role !== "assistant" || !sources || sources.length === 0) return text;
  const byN = new Map(sources.map((s) => [s.n, s]));
  const parts: React.ReactNode[] = [];
  const regex = /\[(\d+)\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const n = Number(match[1]);
    const src = byN.get(n);
    if (src) {
      parts.push(
        <a
          key={`c${key++}`}
          href={src.url}
          target="_blank"
          rel="noreferrer noopener"
          title={src.title}
          className="ml-0.5 text-blue-600 hover:underline align-super text-[10px] font-medium"
        >
          [{n}]
        </a>,
      );
    } else {
      parts.push(match[0]);
    }
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function Home() {
  const [meta, setMeta] = useState<Meta>({});
  const [input, setInput] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, setMessages, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        let sources: Source[] | undefined;
        const rawSources = res.headers.get("x-sources");
        if (rawSources) {
          try {
            sources = JSON.parse(decodeURIComponent(rawSources)) as Source[];
          } catch {}
        }
        setMeta({
          category: res.headers.get("x-category") ?? undefined,
          language: res.headers.get("x-language") ?? undefined,
          reason: res.headers.get("x-reason")
            ? decodeURIComponent(res.headers.get("x-reason") as string)
            : undefined,
          sources,
        });
        return res;
      },
    }),
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Hydrate from server-side history on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        const data = (await res.json()) as { messages: UIMessage[] };
        if (!cancelled && Array.isArray(data.messages) && data.messages.length) {
          setMessages(data.messages);
        }
      } catch {
        // history is optional; ignore failures
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || isLoading) return;
    sendMessage({ text: t });
    setInput("");
  };

  const clear = async () => {
    try {
      await fetch("/api/history", { method: "DELETE" });
    } catch {}
    setMessages([]);
    setMeta({});
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-background to-muted/40">
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-10 space-y-6">
        <header className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-foreground text-background grid place-items-center font-bold">
                E
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Evollis Support
              </h1>
            </div>
            {messages.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clear}
                disabled={isLoading}
              >
                New chat
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            First-line customer-support agent — billing, technical issues,
            contract life, and orders. Auto-detects your language and remembers
            your conversation.
          </p>
        </header>

        {hydrated && messages.length === 0 && (
          <Card className="p-4 space-y-3">
            <p className="text-sm font-medium">Try a question:</p>
            <div className="grid gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="text-left text-sm text-blue-600 hover:underline disabled:opacity-50"
                  disabled={isLoading}
                >
                  → {ex}
                </button>
              ))}
            </div>
          </Card>
        )}

        <div
          ref={scrollRef}
          className="space-y-3 max-h-[55vh] overflow-y-auto pr-1"
        >
          {messages.map((m) => {
            const text = m.parts
              .filter(
                (p): p is { type: "text"; text: string } => p.type === "text",
              )
              .map((p) => p.text)
              .join("");
            return (
              <Card
                key={m.id}
                className={`p-3 ${m.role === "user" ? "bg-muted" : "bg-background"}`}
              >
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  {m.role === "user" ? "You" : "Evollis agent"}
                </div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {renderWithCitations(text, meta.sources, m.role)}
                </div>
              </Card>
            );
          })}
          {isLoading && (
            <div className="text-xs text-muted-foreground animate-pulse">
              Agent is typing…
            </div>
          )}
        </div>

        {meta.category && (
          <div className="flex flex-wrap gap-2 items-center">
            <Badge variant="secondary">category: {meta.category}</Badge>
            <Badge variant="outline">language: {meta.language}</Badge>
            {meta.reason && (
              <span className="text-xs text-muted-foreground">
                — {meta.reason}
              </span>
            )}
          </div>
        )}

        {meta.sources && meta.sources.length > 0 && (
          <Card className="p-3 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sources
            </p>
            <ol className="text-xs space-y-1">
              {meta.sources.map((s) => (
                <li key={s.n} className="flex gap-2">
                  <span className="text-muted-foreground tabular-nums">
                    [{s.n}]
                  </span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-blue-600 hover:underline"
                  >
                    {s.title}
                  </a>
                  <span className="text-muted-foreground">
                    · sim {s.similarity.toFixed(2)}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        )}

        <form onSubmit={handleSubmit} className="flex gap-2 sticky bottom-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Posez votre question / Ask your question…"
            disabled={isLoading}
            autoFocus
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            Send
          </Button>
        </form>

        <footer className="text-[11px] text-muted-foreground pt-4 border-t">
          Demo project — public information about Evollis only. Not affiliated
          with Evollis. Built with Next.js + Vercel AI SDK + Groq (Llama&nbsp;3.3&nbsp;70B)
          + Vercel Postgres / Drizzle.
        </footer>
      </div>
    </main>
  );
}
