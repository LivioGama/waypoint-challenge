// Citation verifier for Waypoint teacher packets.
//
// Run: bun run verify <packet.md> [studentId] [lessonId]
//
// Extracts every quoted phrase from the packet and checks that each one
// appears in either the flattened IEP JSON or the lesson text. Also
// validates "Paragraph N" / "MCQ #N" style structural citations against the
// lesson text.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getStudent, getLesson } from "./data.js";

export type CitationHit = {
  phrase: string;
  line: number;
  kind: "quote" | "paragraph" | "mcq";
  matched: boolean;
  source?: "iep" | "lesson" | "structural";
  reason?: string;
};

export type VerificationReport = {
  packet: string;
  student_id: string;
  lesson_id: string;
  total: number;
  matched: number;
  unmatched: number;
  match_rate: number;
  by_kind: Record<string, { total: number; matched: number }>;
  unmatched_list: Array<{ phrase: string; line: number; kind: string; reason?: string }>;
  hits: CitationHit[];
};

// ---- Normalization ----

const SMART_QUOTE_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  " ": " ",
};

function normalize(s: string): string {
  let out = s;
  for (const [from, to] of Object.entries(SMART_QUOTE_MAP)) {
    out = out.split(from).join(to);
  }
  // Collapse all whitespace.
  out = out.replace(/\s+/g, " ").trim().toLowerCase();
  return out;
}

function flattenJsonValues(obj: unknown, out: string[] = []): string[] {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === "string") {
    out.push(obj);
  } else if (typeof obj === "number" || typeof obj === "boolean") {
    out.push(String(obj));
  } else if (Array.isArray(obj)) {
    for (const v of obj) flattenJsonValues(v, out);
  } else if (typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      flattenJsonValues(v, out);
    }
  }
  return out;
}

// ---- Extraction ----

// Match content inside straight or curly quotes. Non-greedy, allows newlines.
const QUOTE_RE = /(?:["“”])([^"“”\n]{2,400}?)(?:["“”])|(?:[‘'])([^‘’'\n]{3,400}?)(?:[’'])/g;

const PARA_RE = /\bParagraph(?:s)?\s+(\d+)(?:\s*[-–—to]+\s*(\d+))?/gi;
const MCQ_RE = /\b(?:MCQ|Multiple[- ]choice|Question|Item|Independent\s+Practice)\s*#?(\d+)/gi;

type Extracted = {
  quotes: Array<{ phrase: string; line: number }>;
  paragraphs: Array<{ phrase: string; line: number; from: number; to: number }>;
  mcqs: Array<{ phrase: string; line: number; n: number }>;
};

function extract(packet: string): Extracted {
  const quotes: Extracted["quotes"] = [];
  const paragraphs: Extracted["paragraphs"] = [];
  const mcqs: Extracted["mcqs"] = [];
  const lines = packet.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    QUOTE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QUOTE_RE.exec(line))) {
      const phrase = (m[1] ?? m[2] ?? "").trim();
      if (!phrase) continue;
      // Skip pure tag artifacts and very short fragments.
      if (/^\[\[(NEW|SAME|CHANGED)\]\]/.test(phrase)) continue;
      if (phrase.length < 3) continue;
      quotes.push({ phrase, line: ln });
    }

    PARA_RE.lastIndex = 0;
    while ((m = PARA_RE.exec(line))) {
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : from;
      paragraphs.push({ phrase: m[0], line: ln, from, to });
    }

    MCQ_RE.lastIndex = 0;
    while ((m = MCQ_RE.exec(line))) {
      mcqs.push({ phrase: m[0], line: ln, n: Number(m[1]) });
    }
  }
  return { quotes, paragraphs, mcqs };
}

// ---- Lesson structure ----

function lessonParagraphCount(lessonText: string): number {
  // Numbered paragraphs are "[N]" markers in this corpus.
  const matches = lessonText.match(/^\s*\[(\d+)\]/gm) ?? [];
  let max = 0;
  for (const s of matches) {
    const n = Number(s.replace(/[^\d]/g, ""));
    if (n > max) max = n;
  }
  return max;
}

function lessonMcqCount(lessonText: string): number {
  // Independent Practice MCQs are numbered "1.\t" / "1.​" at line start.
  const matches = lessonText.match(/^\s*(\d+)[.​‌‍﻿ \s]/gm) ?? [];
  // Heuristic — last numbered question in the MCQ block (4 in this lesson).
  // Filter to numbers that appear under the "Independent Practice" header.
  const idx = lessonText.indexOf("Independent Practice");
  if (idx < 0) return 0;
  const after = lessonText.slice(idx);
  const nums: number[] = [];
  const re = /^\s*(\d+)\.\s/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(after))) {
    nums.push(Number(m[1]));
    if (nums.length > 50) break;
  }
  // Take the largest sequential count starting at 1.
  let count = 0;
  for (let i = 1; i <= 20; i++) {
    if (nums.includes(i)) count = i;
    else break;
  }
  return count || (matches.length ? Number(matches[matches.length - 1].trim().replace(/\D/g, "")) : 0);
}

// ---- Matching ----

function buildHaystack(text: string): string {
  return normalize(text);
}

function fuzzyContains(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  if (!n) return false;
  if (haystack.includes(n)) return true;
  // Fallback: try without trailing punctuation.
  const stripped = n.replace(/[.,;:!?'"]+$/g, "").replace(/^[.,;:!?'"]+/g, "");
  if (stripped !== n && haystack.includes(stripped)) return true;
  return false;
}

export function verifyPacket(opts: {
  packetText: string;
  packetPath: string;
  studentId: string;
  lessonId: string;
}): VerificationReport {
  const { packetText, packetPath, studentId, lessonId } = opts;
  const iep = getStudent(studentId);
  const lesson = getLesson(lessonId);

  const iepHaystack = buildHaystack(flattenJsonValues(iep).join(" \n "));
  const lessonHaystack = buildHaystack(lesson.text);

  const { quotes, paragraphs, mcqs } = extract(packetText);
  const hits: CitationHit[] = [];

  for (const q of quotes) {
    const inIep = fuzzyContains(iepHaystack, q.phrase);
    const inLesson = !inIep && fuzzyContains(lessonHaystack, q.phrase);
    hits.push({
      phrase: q.phrase,
      line: q.line,
      kind: "quote",
      matched: inIep || inLesson,
      source: inIep ? "iep" : inLesson ? "lesson" : undefined,
      reason: inIep || inLesson ? undefined : "not found in IEP or lesson text",
    });
  }

  const maxPara = lessonParagraphCount(lesson.text);
  for (const p of paragraphs) {
    const ok = p.from >= 1 && p.to <= maxPara && p.from <= p.to;
    hits.push({
      phrase: p.phrase,
      line: p.line,
      kind: "paragraph",
      matched: ok,
      source: "structural",
      reason: ok ? undefined : `paragraph ${p.from}-${p.to} out of range (lesson has 1..${maxPara})`,
    });
  }

  const maxMcq = lessonMcqCount(lesson.text);
  for (const m of mcqs) {
    // Only treat plausible MCQ refs (1..maxMcq). Skip "Independent Practice 5"
    // when no MCQ count was found (defensive).
    if (maxMcq === 0) {
      hits.push({ phrase: m.phrase, line: m.line, kind: "mcq", matched: true, source: "structural" });
      continue;
    }
    const ok = m.n >= 1 && m.n <= maxMcq;
    hits.push({
      phrase: m.phrase,
      line: m.line,
      kind: "mcq",
      matched: ok,
      source: "structural",
      reason: ok ? undefined : `MCQ #${m.n} out of range (lesson has 1..${maxMcq})`,
    });
  }

  const total = hits.length;
  const matched = hits.filter((h) => h.matched).length;
  const by_kind: Record<string, { total: number; matched: number }> = {};
  for (const h of hits) {
    const k = h.kind;
    by_kind[k] ??= { total: 0, matched: 0 };
    by_kind[k].total++;
    if (h.matched) by_kind[k].matched++;
  }

  return {
    packet: packetPath,
    student_id: studentId,
    lesson_id: lessonId,
    total,
    matched,
    unmatched: total - matched,
    match_rate: total === 0 ? 1 : matched / total,
    by_kind,
    unmatched_list: hits
      .filter((h) => !h.matched)
      .map((h) => ({ phrase: h.phrase, line: h.line, kind: h.kind, reason: h.reason })),
    hits,
  };
}

// ---- Inference helpers ----

const STUDENT_IDS = ["jasmine", "marcus", "elena", "devon"];
const LESSON_IDS = ["community-essay", "persuasive-essay"];

export function inferIdsFromPath(p: string): { studentId?: string; lessonId?: string } {
  const name = basename(p).toLowerCase();
  const studentId = STUDENT_IDS.find((s) => name.includes(s));
  const lessonId = LESSON_IDS.find((l) => name.includes(l));
  return { studentId, lessonId };
}

// ---- CLI ----

function isMain(): boolean {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  const here = dirname(fileURLToPath(import.meta.url));
  const thisFile = resolve(here, "verify-citations.ts");
  return resolve(process.argv[1]) === thisFile || process.argv[1].endsWith("verify-citations.ts");
}

function formatReport(r: VerificationReport): string {
  const pct = (r.match_rate * 100).toFixed(1);
  const lines: string[] = [];
  lines.push(`Citation Verification Report`);
  lines.push(`============================`);
  lines.push(`Packet:     ${r.packet}`);
  lines.push(`Student:    ${r.student_id}`);
  lines.push(`Lesson:     ${r.lesson_id}`);
  lines.push(`Total:      ${r.total}`);
  lines.push(`Matched:    ${r.matched} (${pct}%)`);
  lines.push(`Unmatched:  ${r.unmatched}`);
  lines.push(``);
  lines.push(`By kind:`);
  for (const [k, v] of Object.entries(r.by_kind)) {
    const p = v.total === 0 ? "n/a" : ((v.matched / v.total) * 100).toFixed(1) + "%";
    lines.push(`  ${k.padEnd(10)} ${v.matched}/${v.total} (${p})`);
  }
  if (r.unmatched_list.length) {
    lines.push(``);
    lines.push(`Unmatched citations:`);
    for (const u of r.unmatched_list) {
      const phrase = u.phrase.length > 100 ? u.phrase.slice(0, 97) + "..." : u.phrase;
      lines.push(`  L${u.line} [${u.kind}] ${JSON.stringify(phrase)}${u.reason ? ` — ${u.reason}` : ""}`);
    }
  }
  return lines.join("\n");
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const packetPath = argv[0];
  if (!packetPath) {
    console.error("Usage: tsx src/verify-citations.ts <packet.md> [studentId] [lessonId]");
    process.exit(2);
  }
  const inferred = inferIdsFromPath(packetPath);
  const studentId = argv[1] ?? inferred.studentId;
  const lessonId = argv[2] ?? inferred.lessonId;
  if (!studentId || !lessonId) {
    console.error(
      `Could not infer student/lesson from "${packetPath}". Pass them explicitly: tsx src/verify-citations.ts <packet> <studentId> <lessonId>`,
    );
    process.exit(2);
  }
  const packetText = readFileSync(resolve(packetPath), "utf8");
  const report = verifyPacket({ packetText, packetPath, studentId, lessonId });
  console.log(formatReport(report));
  if (process.env.VERIFY_JSON === "1") {
    console.log("\n--- JSON ---");
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(report.unmatched === 0 ? 0 : 1);
}
