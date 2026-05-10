// Post-hoc audit eval for Waypoint winner packets.
// Scores each examples/<student>_<lesson>_PACKET.md on 5 dimensions
// using a fresh judge call (independent of the in-loop judge).
//
// Run:  bun run eval     (requires OPENAI_API_KEY or ANTHROPIC_API_KEY)
// Outputs:
//   examples/EVAL.md           — Markdown table
//   examples/eval-results.json — raw structured results

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModelClient } from "./model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXAMPLES_DIR = join(ROOT, "examples");
const STUDENTS_DIR = join(ROOT, "data", "students");

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

const SYSTEM_PROMPT =
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

interface EvalResult {
  student: string;
  lesson: string;
  disability: string;
  scores: EvalScores;
  reasoning: EvalReasoning;
}

function buildUserPrompt(student: string, lesson: string, packet: string): string {
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
  // Strip ```json fences if the model added them despite instructions.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  // Fall back to first {...} block.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in judge response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateResult(parsed: unknown): { scores: EvalScores; reasoning: EvalReasoning } {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Judge response is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const scores = obj.scores as Record<string, unknown> | undefined;
  const reasoning = obj.reasoning as Record<string, unknown> | undefined;
  if (!scores || !reasoning) {
    throw new Error("Judge response missing scores or reasoning");
  }
  const out: EvalScores = {
    grounding: Number(scores.grounding),
    actionability: Number(scores.actionability),
    fidelity: Number(scores.fidelity),
    student_fit: Number(scores.student_fit),
    prose: Number(scores.prose),
    overall: Number(scores.overall),
  };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isFinite(v)) throw new Error(`Score "${k}" is not a number: ${v}`);
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

function loadDisability(student: string): string {
  try {
    const raw = readFileSync(join(STUDENTS_DIR, `${student}.json`), "utf8");
    const data = JSON.parse(raw) as { disability?: { category?: string } };
    return data.disability?.category ?? "Unknown";
  } catch {
    return "Unknown";
  }
}

function parsePacketFilename(filename: string): { student: string; lesson: string } | null {
  const m = filename.match(/^([a-z0-9-]+)_([a-z0-9-]+)_PACKET\.md$/i);
  if (!m) return null;
  return { student: m[1]!, lesson: m[2]! };
}

async function scorePacket(
  client: ReturnType<typeof getModelClient>,
  student: string,
  lesson: string,
  packet: string,
): Promise<{ scores: EvalScores; reasoning: EvalReasoning }> {
  const userPrompt = buildUserPrompt(student, lesson, packet);
  const raw = await client.complete(SYSTEM_PROMPT, [{ role: "user", content: userPrompt }]);
  const parsed = extractJson(raw);
  return validateResult(parsed);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function buildMarkdown(results: EvalResult[]): string {
  const header =
    "| Student | Disability | Grounding | Actionability | Fidelity | Student-Fit | Prose | Overall | Judge note |\n" +
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |";
  const rows = results.map((r) => {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    return [
      cap(r.student),
      r.disability,
      String(r.scores.grounding),
      String(r.scores.actionability),
      String(r.scores.fidelity),
      String(r.scores.student_fit),
      String(r.scores.prose),
      `${r.scores.overall}/50`,
      escapeCell(r.reasoning.overall),
    ]
      .map(escapeCell)
      .join(" | ");
  });
  const ts = new Date().toISOString();
  return `# Post-hoc Audit Eval — Winner Packets

_Generated ${ts}. Each packet scored by an independent judge call (system prompt: audit judge for special-ed instructional packets). Dimensions scored 1–10; overall is the sum (max 50)._

| | |
| --- | --- |
| Lesson | community-essay |
| Packets evaluated | ${results.length} |

${header}
${rows.join("\n")}

## Per-dimension reasoning

${results
  .map((r) => {
    const cap = r.student.charAt(0).toUpperCase() + r.student.slice(1);
    return `### ${cap} (${r.disability})
- **Grounding (${r.scores.grounding}/10):** ${r.reasoning.grounding}
- **Actionability (${r.scores.actionability}/10):** ${r.reasoning.actionability}
- **Fidelity (${r.scores.fidelity}/10):** ${r.reasoning.fidelity}
- **Student-Fit (${r.scores.student_fit}/10):** ${r.reasoning.student_fit}
- **Prose (${r.scores.prose}/10):** ${r.reasoning.prose}
- **Overall (${r.scores.overall}/50):** ${r.reasoning.overall}`;
  })
  .join("\n\n")}
`;
}

async function main(): Promise<void> {
  const client = getModelClient();
  console.error(`[eval] Using ${client.provider}:${client.model}`);

  const packets = readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith("_PACKET.md"))
    .sort();

  if (packets.length === 0) {
    console.error("[eval] No PACKET files found in examples/");
    process.exit(1);
  }

  const results: EvalResult[] = [];
  for (const filename of packets) {
    const parsed = parsePacketFilename(filename);
    if (!parsed) {
      console.error(`[eval] Skipping unrecognized filename: ${filename}`);
      continue;
    }
    const { student, lesson } = parsed;
    const packetPath = join(EXAMPLES_DIR, filename);
    const packet = readFileSync(packetPath, "utf8");
    const disability = loadDisability(student);
    process.stderr.write(`[eval] Scoring ${student} / ${lesson} ... `);
    try {
      const { scores, reasoning } = await scorePacket(client, student, lesson, packet);
      results.push({ student, lesson, disability, scores, reasoning });
      console.error(`overall=${scores.overall}/50`);
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }

  if (results.length === 0) {
    console.error("[eval] No results produced; aborting write.");
    process.exit(1);
  }

  const jsonPath = join(EXAMPLES_DIR, "eval-results.json");
  const mdPath = join(EXAMPLES_DIR, "EVAL.md");
  writeFileSync(jsonPath, JSON.stringify({ judge: `${client.provider}:${client.model}`, generatedAt: new Date().toISOString(), results }, null, 2));
  writeFileSync(mdPath, buildMarkdown(results));
  console.error(`[eval] Wrote ${mdPath}`);
  console.error(`[eval] Wrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(`[eval] Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
