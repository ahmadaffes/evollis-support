import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";
import { z } from "zod";

export const runtime = "edge";

const Schema = z.object({
  category: z.enum([
    "facturation",
    "technique",
    "contrat",
    "commande",
    "autre",
  ]),
  language: z.enum(["fr", "en", "es", "it", "pt", "nl", "other"]),
  reasoning: z.string().max(280),
});

export async function POST(req: Request) {
  const { message } = (await req.json()) as { message: string };

  const { object } = await generateObject({
    model: groq("openai/gpt-oss-120b"),
    schema: Schema,
    providerOptions: { groq: { strictJsonSchema: false } },
    system: [
      "You are a router for Evollis customer support.",
      "Pick exactly one category:",
      "- facturation: billing, SEPA direct debit, invoice, monthly rent amount, payment failure.",
      "- technique: device broken / stolen, repair, warranty, theft declaration.",
      "- contrat: contract duration, early termination, product swap (month 18), end-of-contract options.",
      "- commande: order status, delivery, shipping.",
      "- autre: anything else, small talk, or explicit human-handoff request.",
      "Also detect the user's language (ISO 639-1).",
      "Reasoning: 1–2 short sentences grounded in the user's words. Do not invent facts.",
    ].join("\n"),
    prompt: message,
  });

  return Response.json(object);
}
