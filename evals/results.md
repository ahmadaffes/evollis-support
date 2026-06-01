# Eval results

Latest run: 2026-06-01, 25 hand-labelled cases. The runner posts each case to
`/api/chat`, then asserts on (a) classified `category`, (b) detected
`language`, (c) inline `[N]` citations on cases tagged `must_cite`, and (d)
regex `must_contain` / `must_not_contain` patterns on the response.

| Metric | Value |
|---|---|
| Agent quality | **18 / 18 (100%)** — passes among cases that got a response |
| Classifier accuracy | **25 / 25 (100%)** — runs regardless of quota |
| Language accuracy | **25 / 25 (100%)** |
| Skipped (infra) | 7 / 25 — Groq free-tier daily-token cap hit mid-run |

### Per-group breakdown

| Group | Cases scored | Pass | Notes |
|---|---|---|---|
| billing | 4 / 4 | **100%** | classifies & answers FR + EN; no invented amounts |
| technical | 4 / 4 | **100%** | theft routed to "technique", police-report instruction present |
| contract | 4 / 4 | **100%** | retrieval fires, citations rendered as `[N]` (after Voyage rate-limit pacing) |
| order | 2 / 2 | **100%** | redirects to brand-partner channels (Samsung Rent+, Michelin) |
| scope | 0 / 3 scored | — | all 3 skipped at quota; classifier returned `autre` correctly on all 3 |
| injection | 3 / 3 scored | **100%** | refuses pirate / DAN / fake-tag attempts cleanly; rest skipped at quota |
| multilingual | 1 / 1 scored | **100%** | PT answered; ES + IT skipped at quota |

### What "skipped" means

The Groq free tier caps `llama-3.3-70b-versatile` at **100,000 tokens/day**.
This eval run, plus earlier development iterations, exhausted that budget
before all 25 cases finished. Cases past the cap got a `Rate limit reached`
event on the SSE stream instead of an answer. The runner detects this and
marks them `SKIP` rather than `FAIL`, since they measure infrastructure
quota, not agent quality. The Groq quota resets daily — re-running tomorrow
will score the remaining 7 cases.

### Failures

_None among scored cases._

### How to reproduce

```bash
npm run dev        # in one terminal
npm run eval       # in another  (uses EVAL_PACE_MS=8000 by default)
# For strict Voyage-rate-limit-free runs:
EVAL_PACE_MS=22000 npm run eval
```

Outputs are written here and printed to stdout. CI usage: exit code `0` if no
real failures, `1` otherwise (skips don't fail the build).
