import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePacket, type ProgressEvent } from "./refine.js";
import { getModelClient, type ModelClient } from "./model.js";
import { parentSummarySystem, parentSummaryUser } from "./prompts.js";

export type ParentSummaryOptions = {
  studentId?: string;
  lessonId?: string;
  language?: string;
  packet?: string; // optional — skip regeneration if provided
  onProgress?: (e: ProgressEvent) => void;
};

export type ParentSummaryResult = {
  letter: string;
  language: string;
  packet: string;
  generatedPacket: boolean;
};

export async function generateParentSummary(
  client: ModelClient = getModelClient(),
  opts: ParentSummaryOptions = {},
): Promise<ParentSummaryResult> {
  const language = (opts.language ?? "es").toLowerCase();
  let packet = opts.packet;
  let generatedPacket = false;

  if (!packet) {
    const result = await generatePacket(client, {
      studentId: opts.studentId,
      lessonId: opts.lessonId,
      onProgress: opts.onProgress,
    });
    packet = result.packet;
    generatedPacket = true;
  }

  const letter = await client.complete(parentSummarySystem(language), [
    { role: "user", content: parentSummaryUser(packet, language) },
  ]);

  return { letter, language, packet, generatedPacket };
}

// CLI entry point: bun run parent-summary <student_id> <lesson_id> [language]
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      process.argv[1]?.endsWith("parent-summary.ts") ||
      process.argv[1]?.endsWith("parent-summary.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "..", "examples");
  mkdirSync(outDir, { recursive: true });

  const studentId = process.argv[2];
  const lessonId = process.argv[3];
  const language = (process.argv[4] ?? "es").toLowerCase();

  if (!studentId || !lessonId) {
    console.error(
      "Usage: bun run parent-summary <student_id> <lesson_id> [language=es]",
    );
    process.exit(1);
  }

  const client = getModelClient();
  console.error(`Using ${client.provider}:${client.model}. Language: ${language}.`);

  const log = (e: ProgressEvent) => {
    const ts = new Date().toISOString().slice(11, 19);
    if (e.kind === "draft") console.error(`[${ts}] draft  candidate=${e.candidate}`);
    else if (e.kind === "critique") console.error(`[${ts}] crit   candidate=${e.candidate} round=${e.round}`);
    else if (e.kind === "revise") console.error(`[${ts}] revise candidate=${e.candidate} round=${e.round}`);
    else if (e.kind === "judge") console.error(`[${ts}] judge`);
    else if (e.kind === "done") console.error(`[${ts}] done   winner=${e.winner} iterations=${e.iterations}`);
  };

  console.error("Generating teacher packet, then distilling into a parent letter…");
  const t0 = Date.now();
  const { letter } = await generateParentSummary(client, {
    studentId,
    lessonId,
    language,
    onProgress: log,
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);

  const outPath = resolve(
    outDir,
    `${studentId}_${lessonId}_PARENT_${language}.md`,
  );
  writeFileSync(outPath, letter.endsWith("\n") ? letter : `${letter}\n`);
  console.error(`\nParent letter (${language}) -> ${outPath} [${seconds}s]`);
}
