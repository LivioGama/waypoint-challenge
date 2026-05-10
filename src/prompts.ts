import { getStudent, getLesson, IEP_SECTION_NAMES, type IEP, type Lesson } from "./data.js";

const IEP_SECTION_NAMES_LIST = IEP_SECTION_NAMES.join(", ");

// Plain-language framing — write to a teacher, not a compliance auditor.
// Layman-style explanations bind the model to teacher-readable output.
export const SYSTEM_PROMPT = `You are a special-education co-teacher helping a brand-new general-education teacher run tomorrow's lesson for ONE specific student with an IEP.

Write the way you'd explain things to a friend who just started teaching. Plain language. No jargon unless you immediately define it. When you cite the IEP, name the goal (e.g. "Goal 3 — ELA comprehension") and quote the exact accommodation or benchmark you're leaning on. When you cite the lesson, name the part (e.g. "Paragraph 2 bulleted list", "Independent Practice MCQ #3").

Every modification you suggest must answer:
1. WHAT the teacher does differently (concrete action, not a strategy name).
2. WHY this matches THIS student (cite IEP goal/benchmark/accommodation/present-level).
3. HOW it shows up in tomorrow's lesson (cite specific lesson part).
4. WHEN — exact moment in the lesson sequence.

Frame everything around Universal Design for Learning (multiple means of representation, action/expression, engagement) AND Gradual Release (I do → We do → You do). But never name those frameworks to the teacher — bake them into the actions.

Hard rules:
- No generic strategies ("provide scaffolding", "give extra time" without naming the exact thing being scaffolded).
- No more than 10 minutes of teacher prep beyond the cheat-sheet checklist.
- Do not pull the student out of whole-group when the IEP places them in inclusion and they prefer whole group.
- No round-robin reading.
- No watering down the standard. The student is working toward grade-level mastery; provide access supports, not lower expectations.`;

function summarizeStudent(iep: IEP): string {
  const subjectLevels = Object.entries(iep.present_levels)
    .filter(([k]) => k !== "academics_general")
    .map(([k, v]) => {
      const level = (v as { current_performance?: string })?.current_performance ?? "";
      return `- ${k}: ${level.split(".")[0]}.`;
    })
    .join("\n");
  return `STUDENT: ${iep.student.name}, Grade ${iep.student.grade}.
DISABILITY: ${(iep.disability as { category: string }).category}. ${(iep.disability as { summary: string }).summary}
PRESENT LEVELS:
${subjectLevels}
GOALS: ${iep.annual_goals.map((g) => `Goal ${g.id} — ${g.area}`).join(", ")}.`;
}

export function smallContextBlock(studentId?: string, lessonId?: string): string {
  const iep = getStudent(studentId);
  const lesson = getLesson(lessonId);
  const goalList = iep.annual_goals
    .map((g) => `goal.${g.id} (${g.area})`)
    .join(", ");
  const lessonLines = lesson.text.split("\n").length;
  return [
    `=== QUICK CONTEXT (call tools for full detail) ===`,
    `STUDENT: ${iep.student.name}, Grade ${iep.student.grade} (id: ${iep.id})`,
    `LESSON: "${lesson.title}" — ${lesson.subject}, Grade ${lesson.grade}, ${lesson.duration_min} min (id: ${lesson.id})`,
    `STANDARDS: ${lesson.standards.join("; ")}`,
    `AVAILABLE IEP SECTIONS: ${IEP_SECTION_NAMES_LIST}, plus ${goalList}`,
    `LESSON TEXT: ${lessonLines} lines available via get_lesson_excerpt(start_line, end_line). Lines are 1-indexed.`,
    "",
    `You have two tools:`,
    `  - get_iep_section(section): fetch one IEP section by name (e.g. "accommodations", "present_levels.ela", "goal.3").`,
    `  - get_lesson_excerpt(start_line, end_line): fetch a specific range of lesson lines.`,
    "",
    `IMPORTANT: Call these tools to ground each modification. Do not guess. Pull the exact accommodation, benchmark, or lesson paragraph you cite. You may call tools multiple times, in any order. Show your work — fetch what you need, then write the packet.`,
  ].join("\n");
}

export function contextBlock(studentId?: string, lessonId?: string): string {
  const iep = getStudent(studentId);
  const lesson = getLesson(lessonId);
  return [
    `=== STUDENT ===`,
    summarizeStudent(iep),
    "",
    `=== IEP (structured) ===`,
    JSON.stringify(iep),
    "",
    `=== LESSON ===`,
    `Title: ${lesson.title}`,
    `Subject: ${lesson.subject} · Grade: ${lesson.grade} · Duration: ${lesson.duration_min} min`,
    `Standards: ${lesson.standards.join("; ")}`,
    "",
    lesson.text,
  ].join("\n");
}

function studentLabel(iep: IEP): string {
  return `${iep.student.name.split(" ")[0]} (Grade ${iep.student.grade})`;
}

export function draftInstructions(studentId?: string, lessonId?: string): string {
  const iep = getStudent(studentId);
  const lesson = getLesson(lessonId);
  const label = studentLabel(iep);
  return `Produce a 3-part teacher packet for ${label} on the lesson "${lesson.title}".

# PART A — Teacher Cheat Sheet (1 page, scannable)
- "Before the bell" — 3-bullet prep checklist (each item ≤ 60 s of prep)
- "Watch for" — 2-3 early-warning signs of disengagement specific to today's text and to this student's profile
- "If they disengage" — exact 2-step recovery script using a strategy already named in the IEP
- "Praise specifically" — 3 sentence-stem examples tied to today's lesson and this student's strengths

# PART B — Modified Lesson Plan (the full lesson sequence, block by block)
For every block of the original lesson provide:
- The original step (one line)
- The modified step for ${label} (concrete action)
- IEP citation — quote the exact goal / accommodation / benchmark / present-level you're leaning on
- Exact materials swap or scaffold (sentence stems, graphic organizer, modified question)

# PART C — Modified Student Materials
Rewrite every item the student actually touches:
- Multiple-choice or short-answer questions — keep the questions, keep the standards, keep the answers; reduce vocabulary load and add a 1-sentence "what this question is really asking" line beneath each
- Any open-response prompt — keep the prompt, add a sentence-stem scaffold + checklist mapped to a specific goal benchmark
- A graphic organizer for the lesson's main skill (cite the standard)

End the packet with a small index table mapping each modification to (IEP element, lesson part). Standards preserved must be listed by code at the bottom.

Output clean Markdown. No preamble. Start with "# Tomorrow's Lesson — ${label}".

CRITICAL — VISIBLE-CHANGE MARKERS (the teacher needs to scan and see at a glance what's different from the original lesson):
- Wrap every step that is NEW (added just for ${label}) in \`[[NEW]] ... [[/NEW]]\`. Example: \`[[NEW]]Hand the modified question sheet at the start of Independent Practice.[[/NEW]]\`
- Wrap every step that is CHANGED from the original (different action, materials, timing, or wording) in \`[[CHANGED]] ... [[/CHANGED]]\`.
- Wrap every step KEPT exactly as for the rest of the class in \`[[SAME]] ... [[/SAME]]\`.
- Tag entire modified questions and modified prompts. Tag every "what this is really asking" gloss as [[NEW]].
- Use the tags inline in sentences too — not just at the start of bullets. The frontend color-codes them: green = NEW, yellow = CHANGED, gray = SAME.`;
}

export function critiqueInstructions(studentId?: string, lessonId?: string): string {
  const iep = getStudent(studentId);
  const lesson = getLesson(lessonId);
  const standards = lesson.standards.join("; ") || "the lesson's named standards";
  return `You are a veteran special-education coach reviewing a colleague's draft. Be sharp and specific. Do NOT rewrite — just critique.

Score 1-10 on each dimension and explain in one sentence each:
- GROUNDING: Does each modification cite a specific IEP element AND a specific lesson part?
- ACTIONABILITY: Could the teacher walk into class tomorrow and do this without further thinking?
- FIDELITY: Does it preserve the grade-level standard (${standards}) instead of watering down?
- STUDENT-FIT: Does it match ${iep.student.name}'s specific profile rather than generic "${(iep.disability as { category: string }).category} student"?
- PROSE: Plain teacher-to-teacher language? Or jargon-heavy?

Then list the TOP 5 concrete fixes — each fix names the section, the problem, and the exact change. Be ruthless about generic advice — flag it.

End with "OVERALL: X/50".`;
}

export function reviseInstructions(critique: string): string {
  return `Apply this critique to your previous draft. Output the revised packet in the SAME format. Keep what worked, fix what was flagged. Do not lose Part A/B/C structure.

CRITIQUE:
${critique}`;
}

export type CandidateCitationStat = { matched: number; total: number; rate: number };

const LANGUAGE_NAMES: Record<string, string> = {
  es: "Spanish",
  en: "English",
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

export function parentSummarySystem(language: string): string {
  const lang = languageName(language);
  return `You are a special-education teacher writing a short, warm one-page note home to a parent in ${lang}. The family is bilingual; many parents prefer to read about their child's school day in their home language.

Write the entire letter in ${lang}. Plain, friendly, conversational language — no education jargon, no acronyms (no "IEP", no "UDL", no standard codes). If you must use a school-specific term, briefly explain it in everyday words.

Tone: a caring teacher talking to a parent, not a compliance document. Short paragraphs. No bullet-point overload. No markdown headings heavier than a single \`#\` title. Never name the disability or quote clinical language from the IEP. Focus on what we are doing FOR the child, not what is "wrong."`;
}

export function parentSummaryUser(packet: string, language: string): string {
  const lang = languageName(language);
  return `Below is the internal teacher packet for tomorrow's lesson, with the modifications we are making for this specific child. Distill it into a one-page letter to the parent, written entirely in ${lang}.

Frame the letter as: "Here is how we are supporting your child tomorrow." Include, in this order:

1. A one-sentence warm opener.
2. What tomorrow's lesson is about (in plain words — what the child will be learning, not the standard code).
3. What we are doing differently for their child specifically (2–4 sentences, concrete, no jargon).
4. ONE concrete thing they can practice at home tonight — a single short, doable suggestion (5–10 minutes), described step-by-step in family-friendly language.
5. A friendly invitation to reach out with questions or observations from home.
6. Sign as "Your child's teacher." (translated to ${lang}).

Keep the whole letter to roughly one page (around 250–350 words). Output clean Markdown — a single \`# \` title in ${lang} at the top, then prose paragraphs. No tables. No [[NEW]]/[[CHANGED]]/[[SAME]] tags. No code-block fences.

=== TEACHER PACKET (internal — do NOT copy verbatim, distill it) ===
${packet}`;
}

export function judgeInstructions(
  n: number,
  studentId?: string,
  lessonId?: string,
  citationStats?: CandidateCitationStat[],
): string {
  const iep = getStudent(studentId);
  const lesson = getLesson(lessonId);
  const standards = lesson.standards.join("; ") || "the lesson's named standards";

  const statsBlock = citationStats && citationStats.length
    ? `\n\nCITATION VERIFICATION (each candidate's quoted phrases / paragraph refs / MCQ refs were checked against the actual IEP and lesson text):\n${citationStats
        .map(
          (s, i) =>
            `  Candidate ${i}: ${s.matched}/${s.total} citations verified (${(s.rate * 100).toFixed(1)}%)`,
        )
        .join("\n")}\n\nCandidates with verifiable citations should be PREFERRED. Candidates with hallucinated citations (low match rate) should be PENALIZED — UNLESS the unverified text is clearly teacher script, sentence stems, or model-language for the student (which legitimately are not source quotes from the IEP/lesson and should not count against the candidate). Treat raw quotes attributed to the IEP or lesson that don't match as a serious red flag.`
    : "";

  const ratesArrayHint = citationStats && citationStats.length
    ? `, "citation_rates": [${citationStats.map((s) => s.rate.toFixed(3)).join(", ")}]`
    : `, "citation_rates": []`;

  return `You will see ${n} candidate teacher packets for the same student + lesson. Pick the SINGLE best one. Criteria, in order:

1. Every modification cites a specific IEP element AND a specific lesson part — and those citations are FAITHFUL (see citation verification below).
2. A new gen-ed teacher could execute it tomorrow without further prep beyond the cheat-sheet checklist.
3. Preserves ${standards}.
4. Matches ${iep.student.name}'s specific profile, not generic.
5. Reads like a friend giving advice, not a compliance document.${statsBlock}

Respond with ONLY a JSON object: {"winner": <0-indexed candidate number>, "why": "<one sentence>"${ratesArrayHint}}`;
}
