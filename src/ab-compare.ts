// A/B comparison: tool-augmented vs full-context candidate generation.
//
// Runs generatePacket() twice on the same student x lesson — once with
// USE_TOOL_AUGMENTED=true (mid-draft tool calls), once with
// USE_TOOL_AUGMENTED=false (full IEP + lesson dumped into prompt) — then
// scores each winner with an independent audit judge using the same 5-dim
// rubric as src/eval.ts. Writes examples/AB_COMPARISON.md.
//
// Run:  bun run ab-compare [studentId] [lessonId]
// Default: jasmine community-essay

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePacket, type GenerationResult } from "./refine.js";
import { getModelClient, type ModelClient } from "./model.js";
import { verifyPacket, type VerificationReport } from "./verify-citations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXAMPLES_DIR = join(ROOT, "examples");

// ---- Audit judge (mirrors src/eval.ts rubric, kept in-file to stay independent) ----

const DIMENSIONS = [
  "grounding",
  "actionability",
  "fidelity",
  "student_fit",
  "prose",
] as const;
type Dim = (typeof DIMENSIONS)[number];

const DIM_DESCRIPTIONS: Record<Dim, string> = {
  grounding:
    "GROUNDING — every modification cites a specific IEP element AND a specific lesson part.",
  actionability:
    "ACTIONABILITY — a brand-new gen-ed teacher could execute this packet tomorrow morning with no extra prep.",
  fidelity:
    "FIDELITY — preserves the grade-level standard; does not water down the academic target.",
  student_fit:
    "STUDENT-FIT — supports match this specific student's profile (not generic special-ed boilerplate).",
  prose:
    "PROSE — plain teacher-to-teacher language; no jargon, no model-speak, no filler.",
};

const AUDIT_SYSTEM_PROMPT =
  "You are an audit judge for special-ed instructional packets. Score each on 5 dimensions, 1-10, with one-sentence reasoning per dim, and overall /50.";

interface EvalScores {
  grounding: number;
  actionability: number;
  fidelity: number;
  student_fit: number;
  prose: number;
  overall: number;
}

interface EvalReasoning {
  grounding: string;
  actionability: string;
  fidelity: string;
  student_fit: string;
  prose: string;
  overall: string;
}

function buildAuditPrompt(student: string, lesson: string, packet: string): string {
  const dims = DIMENSIONS.map((d) => `- ${DIM_DESCRIPTIONS[d]}`).join("\n");
  return `Student: ${student}
Lesson: ${lesson}

Score this differentiated teacher packet on these 5 dimensions (1-10 each):
${dims}

Then give an OVERALL score out of 50 (sum of the 5 dimension scores) and one
sentence summarizing your overall judgment.

Respond with ONLY valid JSON in exactly this shape (no markdown fences, no prose):

{
  "scores": {
    "grounding": <int 1-10>,
    "actionability": <int 1-10>,
    "fidelity": <int 1-10>,
    "student_fit": <int 1-10>,
    "prose": <int 1-10>,
    "overall": <int 5-50>
  },
  "reasoning": {
    "grounding": "<one sentence>",
    "actionability": "<one sentence>",
    "fidelity": "<one sentence>",
    "student_fit": "<one sentence>",
    "prose": "<one sentence>",
    "overall": "<one sentence>"
  }
}

=== PACKET START ===
${packet}
=== PACKET END ===`;
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in audit response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateAudit(parsed: unknown): { scores: EvalScores; reasoning: EvalReasoning } {
  if (!parsed || typeof parsed !== "object") throw new Error("Audit response not object");
  const obj = parsed as Record<string, unknown>;
  const scores = obj.scores as Record<string, unknown> | undefined;
  const reasoning = obj.reasoning as Record<string, unknown> | undefined;
  if (!scores || !reasoning) throw new Error("Audit missing scores or reasoning");
  const out: EvalScores = {
    grounding: Number(scores.grounding),
    actionability: Number(scores.actionability),
    fidelity: Number(scores.fidelity),
    student_fit: Number(scores.student_fit),
    prose: Number(scores.prose),
    overall: Number(scores.overall),
  };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isFinite(v)) throw new Error(`Score "${k}" not numeric: ${v}`);
  }
  const reas: EvalReasoning = {
    grounding: String(reasoning.grounding ?? ""),
    actionability: String(reasoning.actionability ?? ""),
    fidelity: String(reasoning.fidelity ?? ""),
    student_fit: String(reasoning.student_fit ?? ""),
    prose: String(reasoning.prose ?? ""),
    overall: String(reasoning.overall ?? ""),
  };
  return { scores: out, reasoning: reas };
}

async function auditScore(
  client: ModelClient,
  studentId: string,
  lessonId: string,
  packet: string,
): Promise<{ scores: EvalScores; reasoning: EvalReasoning }> {
  const raw = await client.complete(AUDIT_SYSTEM_PROMPT, [
    { role: "user", content: buildAuditPrompt(studentId, lessonId, packet) },
  ]);
  return validateAudit(extractJson(raw));
}

// ---- Run captures ----

interface RunCapture {
  label: string;
  mode: "tool-augmented" | "full-context";
  result: GenerationResult;
  verification: VerificationReport;
  audit: { scores: EvalScores; reasoning: EvalReasoning };
  packetPath: string;
}

async function runOne(
  client: ModelClient,
  studentId: string,
  lessonId: string,
  mode: "tool-augmented" | "full-context",
  label: string,
): Promise<RunCapture> {
  const useToolAugmented = mode === "tool-augmented";
  process.stderr.write(`[ab-compare] ${label} (${mode}) — generating...\n`);
  const result = await generatePacket(client, {
    studentId,
    lessonId,
    useToolAugmented,
  });
  process.stderr.write(
    `[ab-compare] ${label} done: winner=cand${result.winnerIndex} iterations=${result.iterations}\n`,
  );

  const winnerPacket = result.packet;
  const verification = verifyPacket({
    packetText: winnerPacket,
    packetPath: `ab-${mode}`,
    studentId,
    lessonId,
  });
  process.stderr.write(
    `[ab-compare] ${label} citations: ${verification.matched}/${verification.total} (${(verification.match_rate * 100).toFixed(1)}%)\n`,
  );

  process.stderr.write(`[ab-compare] ${label} audit-scoring...\n`);
  const audit = await auditScore(client, studentId, lessonId, winnerPacket);
  process.stderr.write(`[ab-compare] ${label} audit overall=${audit.scores.overall}/50\n`);

  const fname = `${studentId}_${lessonId}_AB_${mode.toUpperCase()}.md`;
  const packetPath = join(EXAMPLES_DIR, fname);
  writeFileSync(packetPath, winnerPacket);

  return { label, mode, result, verification, audit, packetPath };
}

// ---- Comparison artifact ----

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function buildComparisonMarkdown(
  studentId: string,
  lessonId: string,
  client: ModelClient,
  a: RunCapture,
  b: RunCapture,
): string {
  const ts = new Date().toISOString();
  const aRel = `./${a.packetPath.split("/").pop()}`;
  const bRel = `./${b.packetPath.split("/").pop()}`;

  const dimRow = (dim: Dim, label: string) =>
    `| ${label} | ${a.audit.scores[dim]}/10 | ${b.audit.scores[dim]}/10 |`;

  const winner =
    a.audit.scores.overall === b.audit.scores.overall
      ? "tie"
      : a.audit.scores.overall > b.audit.scores.overall
        ? "Tool-augmented"
        : "Full-context";

  const judgeNote = `Tool-augmented run: ${a.audit.reasoning.overall}\n\nFull-context run: ${b.audit.reasoning.overall}\n\n**Overall winner by audit score:** ${winner}.`;

  return `# A/B Comparison — Tool-Augmented vs Full-Context

_Generated ${ts} by \`bun run ab-compare\`. Judge: ${client.provider}:${client.model}._

| | |
| --- | --- |
| Student | ${studentId} |
| Lesson | ${lessonId} |
| Run A | Tool-augmented (\`USE_TOOL_AUGMENTED=true\`): candidates pull IEP sections + lesson excerpts via tool calls mid-draft. |
| Run B | Full-context (\`USE_TOOL_AUGMENTED=false\`): full IEP JSON + full lesson text dumped into the candidate prompt. |

## Headline metrics

| Metric | Tool-augmented (A) | Full-context (B) |
| --- | ---: | ---: |
| Total model calls (iterations) | ${a.result.iterations} | ${b.result.iterations} |
| Winner candidate | #${a.result.winnerIndex} | #${b.result.winnerIndex} |
| Citation match rate (winner) | ${pct(a.verification.match_rate)} (${a.verification.matched}/${a.verification.total}) | ${pct(b.verification.match_rate)} (${b.verification.matched}/${b.verification.total}) |
| Audit overall | **${a.audit.scores.overall}/50** | **${b.audit.scores.overall}/50** |

## Per-dimension audit (1–10)

| Dimension | Tool-augmented (A) | Full-context (B) |
| --- | ---: | ---: |
${dimRow("grounding", "Grounding")}
${dimRow("actionability", "Actionability")}
${dimRow("fidelity", "Fidelity")}
${dimRow("student_fit", "Student-Fit")}
${dimRow("prose", "Prose")}
| **Overall** | **${a.audit.scores.overall}/50** | **${b.audit.scores.overall}/50** |

## Citation verification breakdown

| Kind | Tool-augmented (matched/total) | Full-context (matched/total) |
| --- | ---: | ---: |
${["quote", "paragraph", "mcq"]
  .map((k) => {
    const av = a.verification.by_kind[k] ?? { matched: 0, total: 0 };
    const bv = b.verification.by_kind[k] ?? { matched: 0, total: 0 };
    return `| ${k} | ${av.matched}/${av.total} | ${bv.matched}/${bv.total} |`;
  })
  .join("\n")}

## Judge note

${judgeNote}

## Per-dimension reasoning

### Tool-augmented (A)
- **Grounding (${a.audit.scores.grounding}/10):** ${a.audit.reasoning.grounding}
- **Actionability (${a.audit.scores.actionability}/10):** ${a.audit.reasoning.actionability}
- **Fidelity (${a.audit.scores.fidelity}/10):** ${a.audit.reasoning.fidelity}
- **Student-Fit (${a.audit.scores.student_fit}/10):** ${a.audit.reasoning.student_fit}
- **Prose (${a.audit.scores.prose}/10):** ${a.audit.reasoning.prose}

### Full-context (B)
- **Grounding (${b.audit.scores.grounding}/10):** ${b.audit.reasoning.grounding}
- **Actionability (${b.audit.scores.actionability}/10):** ${b.audit.reasoning.actionability}
- **Fidelity (${b.audit.scores.fidelity}/10):** ${b.audit.reasoning.fidelity}
- **Student-Fit (${b.audit.scores.student_fit}/10):** ${b.audit.reasoning.student_fit}
- **Prose (${b.audit.scores.prose}/10):** ${b.audit.reasoning.prose}

## Packets

- Tool-augmented winner: [${aRel}](${aRel})
- Full-context winner: [${bRel}](${bRel})
`;
}

// ---- main ----

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const studentId = argv[0] ?? "jasmine";
  const lessonId = argv[1] ?? "community-essay";

  const client = getModelClient();
  console.error(`[ab-compare] Using ${client.provider}:${client.model}`);
  console.error(`[ab-compare] Target: ${studentId} / ${lessonId}`);

  const a = await runOne(client, studentId, lessonId, "tool-augmented", "Run A");
  const b = await runOne(client, studentId, lessonId, "full-context", "Run B");

  const md = buildComparisonMarkdown(studentId, lessonId, client, a, b);
  const outPath = join(EXAMPLES_DIR, "AB_COMPARISON.md");
  writeFileSync(outPath, md);
  console.error(`[ab-compare] Wrote ${outPath}`);
  console.error(`[ab-compare] Wrote ${a.packetPath}`);
  console.error(`[ab-compare] Wrote ${b.packetPath}`);
}

main().catch((err) => {
  console.error(`[ab-compare] Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
