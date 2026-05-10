// CLI: `bun run parse-iep <pdf-path>` — extract text from a PDF IEP and ask the
// configured LLM to coerce it into the canonical IEP JSON shape used by
// data/students/*.json. Writes the result to data/students/<id>.json.
//
// This is the "real-world" ingestion path: in production, IEPs arrive as
// scanned/typed PDFs, not hand-curated JSON.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModelClient } from "./model.js";

// pdf-parse v2 exposes a PDFParse class, not a function.
async function extractPdfText(pdfPath: string): Promise<string> {
  const buf = await readFile(pdfPath);
  return extractPdfTextFromBuffer(buf);
}

async function extractPdfTextFromBuffer(buf: Buffer): Promise<string> {
  const mod = await import("pdf-parse");
  const PDFParse = (mod as { PDFParse: new (opts: { data: Buffer }) => { getText: () => Promise<{ text?: string; pages?: Array<{ text?: string }> }> } }).PDFParse;
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  if (result?.text) return result.text;
  if (Array.isArray(result?.pages)) return result.pages.map((p) => p.text ?? "").join("\n\n");
  return "";
}

const REQUIRED_TOP_LEVEL = [
  "id",
  "student",
  "disability",
  "student_vision",
  "present_levels",
  "accommodations",
  "modifications",
  "annual_goals",
  "service_delivery",
  "placement",
  "assessment_accommodations",
] as const;

const SCHEMA_HINT = `{
  "id": "<lowercase first name>",
  "student": { "name": "Full Name", "id": "...", "dob": "YYYY-MM-DD", "age": 0, "grade": "7", "primary_language": "English", "school": "..." },
  "disability": { "category": "...", "english_learner": false, "requires_at": false, "summary": "..." },
  "student_vision": { "this_year": { "ela": "...", "math": "...", "science": "...", "history": "..." }, "long_term": ["...", "..."] },
  "present_levels": {
    "academics_general": { "current_performance": "...", "strengths": "...", "impact": "..." },
    "ela": { "current_performance": "...", "strengths": "...", "current_grade": "...", "homework_independent_accuracy": "...", "with_1_on_1_support_accuracy": "..." },
    "math": { "current_performance": "...", "current_average": "...", "target": "..." },
    "behavioral_social_emotional": { "current_performance": "...", "strengths": "...", "impact": "...", "bullying_vulnerability": "..." }
  },
  "accommodations": {
    "presentation_of_instruction": ["..."],
    "response": ["..."],
    "timing_scheduling": ["..."],
    "setting_environment": ["..."]
  },
  "modifications": { "instruction": "..." },
  "annual_goals": [
    { "id": 1, "area": "...", "baseline": "...", "goal": "...", "criteria": "...", "method": "...", "schedule": "...", "owner": "...", "benchmarks": ["..."] }
  ],
  "service_delivery": [
    { "goal": [1], "type": "...", "provider": "...", "location": "...", "frequency": "..." }
  ],
  "placement": "...",
  "assessment_accommodations": { "mcas": ["..."] }
}`;

const SYSTEM = `You are an expert special-education clerk. You convert raw IEP PDF text into a strict JSON shape. You output ONLY valid JSON — no commentary, no markdown fences. Preserve the source's wording for goals/benchmarks/accommodations verbatim where possible. If a field is genuinely absent in the source, use an empty string, empty array, or empty object as appropriate — never invent content.`;

function buildUserPrompt(pdfText: string): string {
  return `Convert the following IEP PDF text into JSON matching this exact shape:

SCHEMA (shape, not values):
${SCHEMA_HINT}

Rules:
- Output ONLY the JSON object. No prose, no \`\`\`json fences.
- "id" = lowercase first name of the student (e.g. "jasmine").
- "annual_goals[].id" is a 1-indexed integer.
- "service_delivery[].goal" is an array of integer goal ids.
- If a subsection is missing in the source, return an empty string/array — do NOT fabricate.
- Quote source language for goals, benchmarks, and accommodation bullets where possible.

=== IEP PDF TEXT ===
${pdfText}
=== END ===`;
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  // Try to slice from first { to last }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  return t.trim();
}

export async function parseIepFromText(pdfText: string): Promise<{
  iep: Record<string, unknown>;
  raw: string;
  missing: string[];
}> {
  const client = getModelClient();
  const raw = await client.complete(SYSTEM, [
    { role: "user", content: buildUserPrompt(pdfText) },
  ]);
  const cleaned = stripFences(raw);
  let iep: Record<string, unknown>;
  try {
    iep = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `LLM returned non-JSON output. First 400 chars:\n${cleaned.slice(0, 400)}\n\nParse error: ${(e as Error).message}`,
    );
  }
  const missing = REQUIRED_TOP_LEVEL.filter((k) => !(k in iep));
  return { iep, raw, missing };
}

export async function parseIepFromPdf(pdfPath: string): Promise<{
  iep: Record<string, unknown>;
  missing: string[];
}> {
  const text = await extractPdfText(pdfPath);
  if (!text.trim()) {
    throw new Error(`No text extracted from PDF at ${pdfPath}`);
  }
  const { iep, missing } = await parseIepFromText(text);
  return { iep, missing };
}

function summarize(iep: Record<string, unknown>, missing: string[]): void {
  console.log("\n=== Parse summary ===");
  for (const k of REQUIRED_TOP_LEVEL) {
    const v = iep[k];
    let status = "EMPTY";
    if (v !== undefined && v !== null) {
      if (typeof v === "string") status = v.trim() ? "ok" : "EMPTY";
      else if (Array.isArray(v)) status = v.length ? `ok (${v.length})` : "EMPTY";
      else if (typeof v === "object") status = Object.keys(v).length ? "ok" : "EMPTY";
      else status = "ok";
    }
    console.log(`  ${k.padEnd(30)} ${status}`);
  }
  if (missing.length) {
    console.warn(`\nWARN: missing top-level fields: ${missing.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const argPath = process.argv[2];
  if (!argPath) {
    console.error("Usage: bun run parse-iep <pdf-path>");
    process.exit(1);
  }
  const pdfPath = resolve(argPath);
  console.log(`Reading PDF: ${pdfPath}`);
  const { iep, missing } = await parseIepFromPdf(pdfPath);

  const id = String((iep.id ?? "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, ""))
    || (() => {
      const name = (iep.student as { name?: string } | undefined)?.name ?? "";
      return name.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "unknown";
    })();
  iep.id = id;

  const here = dirname(fileURLToPath(import.meta.url));
  const studentsDir = join(here, "..", "data", "students");
  const primary = join(studentsDir, `${id}.json`);
  let outPath = primary;
  try {
    await readFile(primary);
    // exists — write to suffixed file to avoid clobbering hand-curated fixture
    outPath = join(studentsDir, `${id}_from_pdf.json`);
    iep.id = `${id}_from_pdf`;
  } catch {
    // not present, safe to use primary path
  }
  await writeFile(outPath, JSON.stringify(iep, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath}`);
  summarize(iep, missing);
}

// Run when invoked directly (works for both `tsx src/parse-iep.ts` and bun).
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
