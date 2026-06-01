# Evollis Support — AI customer-support agent

A working first-line customer-support agent for **Evollis** (French Device-as-a-Service company).
Built as a 24-hour interview deliverable.

> **Live demo:** <https://evollis-support-sooty.vercel.app/>
> **Repo:** <https://github.com/ahmadaffes/evollis-support>

---

## What it does

1. **Accepts a free-text message** from a user (FR / EN / ES / IT / PT / NL — auto-detected).
2. **Classifies the intent** into one of five categories with `openai/gpt-oss-120b` on Groq:
   - `facturation` — billing, SEPA debit, invoice, monthly rent
   - `technique` — broken / stolen device, repair, warranty
   - `contrat` — contract duration, end-of-contract, product swap
   - `commande` — order status, delivery
   - `autre` — out-of-scope or explicit human-handoff request
3. **Streams a category-aware answer** with `llama-3.3-70b-versatile` on Groq, using a
   verified knowledge base of public Evollis facts (no hallucinated phone numbers,
   prices, or contract clauses).
4. **Replies in the user's language**, detected at classification time.
5. **Offers human escalation** whenever the user asks for it or when the agent is unsure.

The UI shows the classified category + detected language as badges, so you can see the
routing decision live.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui |
| LLM SDK | Vercel AI SDK 6 (`ai` + `@ai-sdk/groq` + `@ai-sdk/react`) |
| Models | `openai/gpt-oss-120b` (classifier, structured outputs) + `llama-3.3-70b-versatile` (streaming chat) |
| Hosting | Vercel (Hobby) |
| Runtime | Edge |

Everything in this stack is free for the demo footprint.

---

## How it works (architecture)

```
                ┌─────────────────────────────┐
   user msg ──▶ │  /api/chat (Edge route)     │
                │                             │
                │  1. generateObject (zod)    │ ── Groq gpt-oss-120b ──▶ {category, language, reasoning}
                │     intent + language       │
                │                             │
                │  2. streamText              │ ── Groq llama-3.3-70b ──▶ streamed reply
                │     system = KB + category- │
                │              specific guide │
                └──────────────┬──────────────┘
                               │
                  UI message stream + x-category / x-language headers
                               │
                               ▼
                       useChat() in page.tsx
```

The knowledge base lives in `src/lib/evollis-kb.ts` and contains only facts traceable to
public sources (see **Sources** below). The system prompt explicitly forbids inventing
prices, phone numbers, emails, or contract clauses — when the agent is unsure, it offers
human handoff and asks for name + contract number + short description.

---

## Local setup

```bash
git clone <repo-url>
cd evollis-support
npm install
echo "GROQ_API_KEY=gsk_..." > .env.local
npm run dev
```

Then open <http://localhost:3000>. Get a free Groq API key at
<https://console.groq.com/keys> (no credit card required).

---

## What I'd do next with 3 more days

1. **Replace the inline KB with real retrieval.** Scrape the public Evollis / UZ'IT /
   partner T&C PDFs (Samsung Rent+, Michelin, Pack Evolution), chunk them, embed with
   `nomic-embed-text-v1.5` via Groq (or a local model), and store in Vercel Postgres +
   pgvector. The chat route would retrieve the top-k chunks before answering and the UI
   would render the matching T&C excerpts as citations under each response. This turns
   the agent from "smart paraphraser of a static prompt" into something that can quote
   the exact clause a user is asking about.
2. **Real human handoff.** When the classifier returns `autre` with `human_request: true`,
   or when the user explicitly asks, open a ticket via an Evollis CRM webhook (or fall
   back to a structured email) with: full transcript, detected category, language, and
   any contract number captured. Today the agent only *says* it will escalate.
3. **Evals + observability.** A `evals/` folder with ~50 hand-labelled real-style
   questions: each row has expected category + assertions on the answer (must mention
   SEPA-5 for billing, must mention police report for theft, must not quote a euro
   amount, etc.). Run on every PR via GitHub Actions. Add a thumbs-up/down on each reply
   in the UI that writes to Postgres, plus a small `/admin` dashboard surfacing
   low-rated categories so prompts can be iterated with data.
4. **Multi-turn memory across sessions** (anonymous cookie → conversation history in
   Postgres) so a user reopening the page sees their previous exchange and the agent
   has context.
5. **Hardening:** rate-limit `/api/chat` per IP (Upstash Redis), PII redaction on logs,
   and a guardrail step that re-checks the final answer for forbidden patterns
   (concrete euro amounts, phone numbers not in the KB) before streaming.

---

## Sources for the Evollis knowledge base

All facts in `src/lib/evollis-kb.ts` are derived from these public pages.

- [Evollis — Crunchbase](https://www.crunchbase.com/organization/evollis)
- [Evollis — LinkedIn (France)](https://fr.linkedin.com/company/evollis)
- [Evollis — LinkedIn (IE mirror, mentions 6 countries + Rentall acquisition)](https://ie.linkedin.com/company/evollis)
- [Evollis — Dun & Bradstreet](https://www.dnb.com/business-directory/company-profiles.evollis.b33b9de1e0dd07a214cf8d219bebd815.html)
- [MoneyVox — "Evollis parie sur la location de biens high-tech et électroménagers"](https://www.moneyvox.fr/credit/actualites/53849/fintech-evollis-parie-sur-la-location-de-biens-high-tech-et-electromenagers)
- [Samsung Rent+ — Conditions Générales (hosted on static-samsung.evollis.com)](https://static-samsung.evollis.com/pdf/Conditions-Generales-et-Particulieres-du-Contrat-de-Services.pdf)
- [Michelin — Contrat de location longue durée (hosted on static-michelin.evollis.com)](https://static-michelin.evollis.com/pdf/conditions_generales_de_l_offre.pdf)
- [Pack Evolution — Conditions Générales (Evollis)](https://static-evollis.evollis.com/cgs/Conditions_generales_Pack_Evolution.pdf)
- [UZ'IT — Conditions Générales de location](https://www.uzit-direct.com/content/3-conditions-generales-de-location)
- [Evollis main site](https://www.evollis.com/)

---

## License & disclaimer

This is a demo project for an interview. Not affiliated with, endorsed by, or operated by
Evollis. Uses only publicly available information about the company.
