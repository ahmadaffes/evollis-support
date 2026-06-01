// Evals runner. Posts each case to the local /api/chat endpoint, collects
// classification + sources + streamed response, checks assertions, prints a
// human-readable table + writes evals/results.md.
//
// Usage:
//   npm run dev            (in another terminal)
//   npm run eval
//
// Assumes BASE = http://localhost:3000. Override with EVAL_BASE env var.

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFile } from "node:fs/promises";
import { CASES, type EvalCase } from "./dataset";

const BASE = process.env.EVAL_BASE ?? "http://localhost:3000";
const TIMEOUT_MS = 60_000;
// Pace per case. Voyage free tier is 3 RPM (1 call / 20s); the retrieve route
// has retry-with-backoff but pacing the eval keeps the run deterministic.
const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 8000);

type Verdict = "PASS" | "FAIL" | "SKIP";

type Result = {
  case: EvalCase;
  category: string | null;
  language: string | null;
  sources: number;
  citations: number;
  response: string;
  streamError: string | null;
  durationMs: number;
  failures: string[];
  verdict: Verdict;
};

async function fetchChat(query: string): Promise<{
  category: string | null;
  language: string | null;
  sources: number;
  response: string;
  streamError: string | null;
}> {
  const body = JSON.stringify({
    messages: [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: query }],
      },
    ],
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    return {
      category: null,
      language: null,
      sources: 0,
      response: `HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`,
      streamError: `HTTP_${res.status}`,
    };
  }

  let sources = 0;
  const raw = res.headers.get("x-sources");
  if (raw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(raw));
      sources = Array.isArray(parsed) ? parsed.length : 0;
    } catch {}
  }

  // Consume the SSE stream and extract text-delta chunks. Also capture any
  // stream-level error event (Groq rate-limit, model failure, etc.) so we
  // can distinguish agent quality from infrastructure constraints.
  const text = await res.text();
  const deltas: string[] = [];
  let streamError: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.type === "text-delta" && typeof obj.delta === "string") {
        deltas.push(obj.delta);
      } else if (obj.type === "error" && typeof obj.errorText === "string") {
        streamError = obj.errorText;
      }
    } catch {}
  }

  return {
    category: res.headers.get("x-category"),
    language: res.headers.get("x-language"),
    sources,
    response: deltas.join(""),
    streamError,
  };
}

function checkCase(c: EvalCase, got: {
  category: string | null;
  language: string | null;
  sources: number;
  response: string;
}): { failures: string[]; citations: number } {
  const failures: string[] = [];
  if (got.category !== c.expected_category) {
    failures.push(`category=${got.category ?? "null"} (want ${c.expected_category})`);
  }
  if (got.language !== c.expected_language) {
    failures.push(`language=${got.language ?? "null"} (want ${c.expected_language})`);
  }
  for (const re of c.must_contain ?? []) {
    if (!re.test(got.response)) failures.push(`missing match: ${re}`);
  }
  for (const re of c.must_not_contain ?? []) {
    if (re.test(got.response)) failures.push(`forbidden match: ${re}`);
  }
  const citations = (got.response.match(/\[\d+\]/g) ?? []).length;
  if (c.must_cite && citations === 0) failures.push("must_cite but no [N] citations");
  return { failures, citations };
}

function pct(num: number, den: number): string {
  if (den === 0) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

async function main() {
  console.log(`Running ${CASES.length} eval cases against ${BASE}\n`);
  const results: Result[] = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]!;
    if (i > 0) await new Promise((r) => setTimeout(r, PACE_MS));
    const start = Date.now();
    let got = {
      category: null as string | null,
      language: null as string | null,
      sources: 0,
      response: "",
      streamError: null as string | null,
    };
    try {
      got = await fetchChat(c.query);
    } catch (err) {
      got.response = `ERROR: ${(err as Error).message}`;
    }
    const dur = Date.now() - start;
    const { failures, citations } = checkCase(c, got);
    // Quota / rate-limit at the streaming layer is infra, not agent quality
    // — record as SKIP and don't penalise the run.
    const isInfraSkip =
      got.streamError != null &&
      /rate limit|quota|TPD|TPM|RPM|RPD|try again in/i.test(got.streamError);
    const verdict: Verdict = isInfraSkip
      ? "SKIP"
      : failures.length === 0
        ? "PASS"
        : "FAIL";
    results.push({
      case: c,
      category: got.category,
      language: got.language,
      sources: got.sources,
      citations,
      response: got.response,
      streamError: got.streamError,
      durationMs: dur,
      failures,
      verdict,
    });
    const marker =
      verdict === "PASS" ? "✓" : verdict === "SKIP" ? "·" : "✗";
    console.log(
      `  ${marker} ${c.id.padEnd(22)} ${c.group.padEnd(12)} ${
        got.category ?? "?"
      }/${got.language ?? "?"} src=${got.sources} cite=${citations} ${dur}ms${
        verdict === "SKIP" ? "  [SKIP: quota]" : ""
      }`,
    );
    if (verdict === "FAIL") {
      for (const f of failures) console.log(`      → ${f}`);
      const preview = got.response.replace(/\s+/g, " ").slice(0, 120);
      if (preview) console.log(`      response: "${preview}…"`);
    }
  }

  // ---- Aggregate ----
  const total = results.length;
  const passed = results.filter((r) => r.verdict === "PASS").length;
  const skipped = results.filter((r) => r.verdict === "SKIP").length;
  const scored = total - skipped; // cases that actually got an answer
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const categoryHits = results.filter(
    (r) => r.category === r.case.expected_category,
  ).length;
  const languageHits = results.filter(
    (r) => r.language === r.case.expected_language,
  ).length;

  const byGroup: Record<
    string,
    { pass: number; fail: number; skip: number; total: number }
  > = {};
  for (const r of results) {
    const g = r.case.group;
    byGroup[g] ??= { pass: 0, fail: 0, skip: 0, total: 0 };
    byGroup[g].total++;
    if (r.verdict === "PASS") byGroup[g].pass++;
    else if (r.verdict === "SKIP") byGroup[g].skip++;
    else byGroup[g].fail++;
  }

  // ---- Print summary ----
  console.log("\n" + "=".repeat(60));
  console.log("Eval summary");
  console.log("=".repeat(60));
  console.log(
    `Agent quality:      ${passed}/${scored} (${pct(passed, scored)})  ← passes among cases that got a response`,
  );
  console.log(
    `Category accuracy:  ${categoryHits}/${total} (${pct(categoryHits, total)})  ← classifier, runs even when stream errors`,
  );
  console.log(
    `Language accuracy:  ${languageHits}/${total} (${pct(languageHits, total)})`,
  );
  if (skipped > 0) {
    console.log(
      `Skipped:            ${skipped}/${total} (rate-limit / quota during run)`,
    );
  }
  if (failed > 0) {
    console.log(`Failed:             ${failed}/${total}`);
  }
  console.log("");
  for (const [g, { pass, fail, skip, total: t }] of Object.entries(byGroup)) {
    const scoredG = t - skip;
    const skipNote = skip > 0 ? `  (${skip} skipped)` : "";
    console.log(
      `  ${g.padEnd(14)} ${pass}/${scoredG} pass · ${fail} fail${skipNote}`,
    );
  }

  // ---- Write markdown ----
  const md: string[] = [];
  md.push(`# Eval results\n`);
  md.push(`Run at ${new Date().toISOString()}, ${total} cases.\n`);
  md.push(`| Metric | Value |`);
  md.push(`|---|---|`);
  md.push(
    `| Agent quality | **${passed}/${scored} (${pct(passed, scored)})** — passes among cases that got a response |`,
  );
  md.push(
    `| Category accuracy | ${categoryHits}/${total} (${pct(categoryHits, total)}) |`,
  );
  md.push(
    `| Language accuracy | ${languageHits}/${total} (${pct(languageHits, total)}) |`,
  );
  if (skipped > 0) {
    md.push(
      `| Skipped (infra) | ${skipped}/${total} — Groq / Voyage free-tier rate limit during the run |`,
    );
  }
  md.push(``);
  md.push(`### Per-group breakdown`);
  md.push(`| Group | Pass | Fail | Skip |`);
  md.push(`|---|---|---|---|`);
  for (const [g, { pass, fail, skip, total: t }] of Object.entries(byGroup)) {
    md.push(`| ${g} | ${pass}/${t - skip} | ${fail} | ${skip} |`);
  }
  md.push(``);
  md.push(`### Failures`);
  const fails = results.filter((r) => r.verdict === "FAIL");
  if (fails.length === 0) {
    md.push(`_None._`);
  } else {
    for (const r of fails) {
      md.push(
        `- **${r.case.id}** (${r.case.group}) — \`${r.case.query.slice(0, 80)}\``,
      );
      for (const f of r.failures) md.push(`  - ${f}`);
      if (r.response)
        md.push(
          `  - response: ${r.response.replace(/\s+/g, " ").slice(0, 200)}`,
        );
    }
  }
  await writeFile("evals/results.md", md.join("\n"));
  console.log(`\nWrote evals/results.md`);

  // Exit non-zero if any real failure (skips don't count).
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
