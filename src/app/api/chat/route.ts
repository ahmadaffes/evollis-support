import { streamText, convertToModelMessages, generateObject, type UIMessage } from "ai";
import { groq } from "@ai-sdk/groq";
import { z } from "zod";
import { EVOLLIS_CONTEXT } from "@/lib/evollis-kb";

export const runtime = "edge";
export const maxDuration = 30;

const CATEGORY_PROMPTS: Record<string, string> = {
  facturation:
    "Topic: billing. SEPA direct debit runs on the 5th of the month with no prior notice. " +
    "Initial payment + fixed monthly rent. If the user reports a failed debit, ask them to " +
    "first check their bank (insufficient funds, expired card-not-applicable since SEPA) " +
    "and then offer human escalation. Never quote a specific monthly amount.",
  technique:
    "Topic: device issue. Pack Evolution covers breakdown, theft, and annual maintenance " +
    "(when subscribed). For theft, instruct the user to file a police report (déclaration " +
    "de vol) first — it is required to trigger the theft guarantee. For physical damage, " +
    "ask: device model, contract reference, brief description, photos if possible. Then escalate.",
  contrat:
    "Topic: contract life. Durations are typically 24 or 36 months. Product swap is available " +
    "from month 18 on 36-month contracts only. End-of-contract options (return / buy / swap) " +
    "exist but exact terms vary — direct the user to their specific T&C document. Never " +
    "invent clauses, fees, or buy-out amounts.",
  commande:
    "Topic: order / delivery. Evollis itself does not run a single direct-to-consumer storefront " +
    "for every program — many flows are operated through brand partners (e.g. Samsung Rent+, " +
    "Michelin) or retailers. Ask through which partner the order was placed and redirect to that " +
    "partner's order-tracking channel when relevant.",
  autre:
    "General inquiry. Be helpful in one short paragraph. If the request is out of scope " +
    "(weather, jokes, unrelated topics), politely decline and steer back to Evollis. If the " +
    "user explicitly asks for a human, collect: full name, contract number (if any), short " +
    "description of the issue, and confirm escalation.",
};

const ClassifySchema = z.object({
  category: z.enum(["facturation", "technique", "contrat", "commande", "autre"]),
  language: z.enum(["fr", "en", "es", "it", "pt", "nl", "other"]),
  reasoning: z.string().max(280),
});

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: UIMessage[] };

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserText =
    lastUser?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n") ?? "";

  // 1) Classify intent + detect language. If the classifier ever returns
  // malformed JSON, fall back to a safe default so the chat still responds.
  let meta: z.infer<typeof ClassifySchema>;
  try {
    const r = await generateObject({
      model: groq("openai/gpt-oss-120b"),
      schema: ClassifySchema,
      providerOptions: { groq: { strictJsonSchema: false } },
      system: [
        "You are a router for Evollis customer support.",
        "Categories: facturation | technique | contrat | commande | autre.",
        "Detect the user's language (ISO 639-1).",
        "Reason briefly. Do not invent facts.",
      ].join("\n"),
      prompt: lastUserText,
    });
    meta = r.object;
  } catch {
    meta = {
      category: "autre",
      language: "other",
      reasoning: "Classifier unavailable, defaulted to autre.",
    };
  }

  // 2) Stream the answer with a category-aware system prompt
  const result = streamText({
    model: groq("llama-3.3-70b-versatile"),
    system: [
      EVOLLIS_CONTEXT,
      "",
      `Detected category: ${meta.category}.`,
      `Detected user language (ISO 639-1): ${meta.language}.`,
      `Router reasoning: ${meta.reasoning}`,
      "",
      `Category guidance: ${CATEGORY_PROMPTS[meta.category]}`,
      "",
      "STYLE RULES:",
      `- Reply in the same language as the user's last message (${meta.language}).`,
      "- Be concise: 3–6 sentences. No marketing fluff.",
      "- If you are not sure of a fact, say so plainly and offer human escalation.",
      "- Never make up a refund amount, a contract clause, a phone number, or an email.",
    ].join("\n"),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    headers: {
      "x-category": meta.category,
      "x-language": meta.language,
      "x-reason": encodeURIComponent(meta.reasoning),
    },
  });
}
