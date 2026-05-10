import {
  SYSTEM_PROMPT,
  contextBlock,
  smallContextBlock,
  draftInstructions,
  critiqueInstructions,
  reviseInstructions,
  judgeInstructions,
  type CandidateCitationStat,
} from "./prompts.js";
import { getModelClient, type ModelClient, type ToolSpec, type ToolHandler } from "./model.js";
import { iepSection, getLesson, IEP_SECTION_NAMES } from "./data.js";
import { verifyPacket } from "./verify-citations.js";

// Candidates whose citation match rate falls below this threshold are
// auto-rejected before the judge sees them (unless that would empty the pool).
const MIN_CITATION_RATE = 0.4;

// 4 parallel candidate drafts + 1 judge = 5 model calls.
// The deeper critique→revise chain is wired up via N_REFINE_ROUNDS for
// operators who want to spend more tokens for higher polish.
const N_CANDIDATES = 4;
const N_REFINE_ROUNDS = 0;

// When true, candidate drafts use tool-augmented generation: the model
// receives only a tiny context block + tool schemas and pulls the IEP
// sections / lesson excerpts it needs mid-draft. When false, the legacy
// path dumps the full IEP + full lesson into the prompt.
export const USE_TOOL_AUGMENTED = true;

const CANDIDATE_TOOLS: ToolSpec[] = [
  {
    name: "get_iep_section",
    description: `Fetch one structured section of the student's IEP. Available sections: ${IEP_SECTION_NAMES.join(", ")}. You can also fetch a specific annual goal by id with "goal.<n>" (e.g. "goal.3"). Returns JSON.`,
    input_schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: `Section name. One of ${IEP_SECTION_NAMES.join(", ")}, or "goal.<n>".`,
        },
      },
      required: ["section"],
      additionalProperties: false,
    },
  },
  {
    name: "get_lesson_excerpt",
    description: "Fetch a specific 1-indexed line range from the lesson text. Use to ground a modification in the exact lesson paragraph, MCQ, or activity step you are modifying.",
    input_schema: {
      type: "object",
      properties: {
        start_line: { type: "integer", minimum: 1, description: "First line (1-indexed, inclusive)." },
        end_line: { type: "integer", minimum: 1, description: "Last line (1-indexed, inclusive)." },
      },
      required: ["start_line", "end_line"],
      additionalProperties: false,
    },
  },
];

function makeToolHandler(studentId?: string, lessonId?: string): ToolHandler {
  return async (name, input) => {
    if (name === "get_iep_section") {
      const section = String(input.section ?? "");
      const data = iepSection(section, studentId);
      if (data === undefined) return `ERROR: unknown section "${section}". Try one of: ${IEP_SECTION_NAMES.join(", ")} or "goal.<n>".`;
      return JSON.stringify(data, null, 2);
    }
    if (name === "get_lesson_excerpt") {
      const lesson = getLesson(lessonId);
      const lines = lesson.text.split("\n");
      const start = Math.max(1, Number(input.start_line ?? 1));
      const end = Math.min(lines.length, Number(input.end_line ?? start));
      if (end < start) return `ERROR: end_line (${end}) < start_line (${start}). Lesson has ${lines.length} lines.`;
      const slice = lines.slice(start - 1, end);
      return slice.map((l, i) => `${start + i}: ${l}`).join("\n");
    }
    return `ERROR: unknown tool "${name}".`;
  };
}

export type ProgressEvent =
  | { kind: "draft"; candidate: number }
  | { kind: "critique"; candidate: number; round: number }
  | { kind: "revise"; candidate: number; round: number }
  | { kind: "verify"; candidate: number; rate: number; matched: number; total: number; rejected?: boolean }
  | { kind: "judge" }
  | { kind: "done"; winner: number; iterations: number };

export type CitationVerification = {
  matched: number;
  total: number;
  rate: number;
  rejected?: boolean;
};

export type GenerationResult = {
  packet: string;
  winnerIndex: number;
  candidates: string[];
  iterations: number;
  judgeReason: string;
  citationVerifications: CitationVerification[];
};

export type GenerationOptions = {
  studentId?: string;
  lessonId?: string;
  onProgress?: (e: ProgressEvent) => void;
  maxDurationMs?: number;
  // When set, overrides the top-level USE_TOOL_AUGMENTED constant for this
  // single call. Lets A/B harnesses run both modes back-to-back.
  useToolAugmented?: boolean;
};

const noop = () => {};

export async function generatePacket(
  client: ModelClient = getModelClient(),
  opts: GenerationOptions = {},
): Promise<GenerationResult> {
  const { studentId, lessonId, onProgress = noop, maxDurationMs, useToolAugmented } = opts;
  const toolAugmented = useToolAugmented ?? USE_TOOL_AUGMENTED;

  const generation = async () => {
    const ctx = toolAugmented
      ? smallContextBlock(studentId, lessonId)
      : contextBlock(studentId, lessonId);
    const draftPrompt = draftInstructions(studentId, lessonId);
    const critPrompt = critiqueInstructions(studentId, lessonId);
    let iterations = 0;

    const tasks = Array.from({ length: N_CANDIDATES }, (_, idx) =>
      runCandidate(client, ctx, draftPrompt, critPrompt, idx, N_REFINE_ROUNDS, onProgress, studentId, lessonId, toolAugmented).then(
        (r) => {
          iterations += r.iterations;
          return r.final;
        },
      ),
    );
    const candidates = await Promise.all(tasks);

    // Verify citations for each candidate before judging.
    const citationVerifications: CitationVerification[] = candidates.map((candidate, idx) => {
      if (!studentId || !lessonId) {
        // verifyPacket needs both ids; without them, treat as un-evaluated (rate=1).
        const stat: CitationVerification = { matched: 0, total: 0, rate: 1 };
        onProgress({ kind: "verify", candidate: idx, rate: stat.rate, matched: 0, total: 0 });
        return stat;
      }
      try {
        const report = verifyPacket({
          packetText: candidate,
          packetPath: `candidate-${idx}`,
          studentId,
          lessonId,
        });
        const rejected = report.total > 0 && report.match_rate < MIN_CITATION_RATE;
        const stat: CitationVerification = {
          matched: report.matched,
          total: report.total,
          rate: report.match_rate,
          ...(rejected ? { rejected: true } : {}),
        };
        onProgress({
          kind: "verify",
          candidate: idx,
          rate: stat.rate,
          matched: stat.matched,
          total: stat.total,
          ...(rejected ? { rejected: true } : {}),
        });
        return stat;
      } catch {
        const stat: CitationVerification = { matched: 0, total: 0, rate: 1 };
        onProgress({ kind: "verify", candidate: idx, rate: 1, matched: 0, total: 0 });
        return stat;
      }
    });

    // Build the judge pool, dropping auto-rejected candidates unless that
    // would empty the pool (in which case keep all and let the judge decide).
    const keepIdx = citationVerifications
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => !v.rejected)
      .map(({ i }) => i);
    const judgePoolIdx = keepIdx.length > 0 ? keepIdx : candidates.map((_, i) => i);
    const judgePool = judgePoolIdx.map((i) => candidates[i]);
    const judgeStats: CandidateCitationStat[] = judgePoolIdx.map((i) => ({
      matched: citationVerifications[i].matched,
      total: citationVerifications[i].total,
      rate: citationVerifications[i].rate,
    }));

    onProgress({ kind: "judge" });
    const { winner: poolWinner, why } = await judge(
      client,
      judgePool,
      studentId,
      lessonId,
      judgeStats,
    );
    const winner = judgePoolIdx[poolWinner] ?? 0;
    iterations += 1;

    onProgress({ kind: "done", winner, iterations });
    return {
      packet: candidates[winner],
      winnerIndex: winner,
      candidates,
      iterations,
      judgeReason: why,
      citationVerifications,
    };
  };

  if (!maxDurationMs) {
    return generation();
  }

  // Wrap with timeout
  const timeout = new Promise<GenerationResult>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Generation timeout: exceeded ${maxDurationMs}ms`));
    }, maxDurationMs);
  });

  return Promise.race([generation(), timeout]);
}

async function runCandidate(
  client: ModelClient,
  ctx: string,
  draftPrompt: string,
  critPrompt: string,
  idx: number,
  refineRounds: number,
  onProgress: (e: ProgressEvent) => void,
  studentId?: string,
  lessonId?: string,
  toolAugmented: boolean = USE_TOOL_AUGMENTED,
): Promise<{ final: string; iterations: number }> {
  let iterations = 0;

  onProgress({ kind: "draft", candidate: idx });
  const draftUserMsg = `${ctx}\n\n${draftPrompt}\n\n(You are candidate #${idx + 1} of ${N_CANDIDATES}. Bring a distinct angle: focus on what most teachers would miss.)`;
  let draft: string;
  if (toolAugmented) {
    const handler = makeToolHandler(studentId, lessonId);
    draft = await client.completeWithTools(
      SYSTEM_PROMPT,
      [{ role: "user", content: draftUserMsg }],
      CANDIDATE_TOOLS,
      handler,
    );
  } else {
    draft = await client.complete(SYSTEM_PROMPT, [{ role: "user", content: draftUserMsg }]);
  }
  iterations += 1;

  for (let round = 0; round < refineRounds; round++) {
    onProgress({ kind: "critique", candidate: idx, round });
    const critique = await client.complete(SYSTEM_PROMPT, [
      { role: "user", content: `${ctx}\n\nDRAFT TO CRITIQUE:\n\n${draft}\n\n${critPrompt}` },
    ]);
    iterations += 1;

    onProgress({ kind: "revise", candidate: idx, round });
    draft = await client.complete(SYSTEM_PROMPT, [
      {
        role: "user",
        content: `${ctx}\n\nPREVIOUS DRAFT:\n\n${draft}\n\n${reviseInstructions(critique)}`,
      },
    ]);
    iterations += 1;
  }

  return { final: draft, iterations };
}

async function judge(
  client: ModelClient,
  candidates: string[],
  studentId?: string,
  lessonId?: string,
  citationStats?: CandidateCitationStat[],
): Promise<{ winner: number; why: string }> {
  const labeled = candidates.map((c, i) => `=== CANDIDATE ${i} ===\n${c}`).join("\n\n");
  const raw = await client.complete(
    judgeInstructions(candidates.length, studentId, lessonId, citationStats),
    [{ role: "user", content: labeled }],
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { winner: 0, why: "judge returned no JSON" };
  try {
    const parsed = JSON.parse(match[0]);
    const w = Number(parsed.winner);
    return {
      winner: Number.isFinite(w) && w >= 0 && w < candidates.length ? w : 0,
      why: String(parsed.why ?? ""),
    };
  } catch {
    return { winner: 0, why: "judge JSON parse failed" };
  }
}
