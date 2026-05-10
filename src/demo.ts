import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePacket, type ProgressEvent } from "./refine.js";
import { getModelClient } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "examples");
mkdirSync(outDir, { recursive: true });

const studentId = process.argv[2];
const lessonId = process.argv[3];

const client = getModelClient();
console.error(`Using ${client.provider}:${client.model}.`);

const log = (e: ProgressEvent) => {
  const ts = new Date().toISOString().slice(11, 19);
  if (e.kind === "draft") console.error(`[${ts}] draft  candidate=${e.candidate}`);
  else if (e.kind === "critique") console.error(`[${ts}] crit   candidate=${e.candidate} round=${e.round}`);
  else if (e.kind === "revise") console.error(`[${ts}] revise candidate=${e.candidate} round=${e.round}`);
  else if (e.kind === "judge") console.error(`[${ts}] judge`);
  else if (e.kind === "done") console.error(`[${ts}] done   winner=${e.winner} iterations=${e.iterations}`);
};

console.error("Running refinement loop. This will take roughly 20–30 seconds.");
const t0 = Date.now();
const result = await generatePacket(client, { studentId, lessonId, onProgress: log });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const slug = `${studentId ?? "default"}_${lessonId ?? "default"}`;
const winnerPath = resolve(outDir, `${slug}_PACKET.md`);
writeFileSync(
  winnerPath,
  `# Teacher Packet — ${slug}\n\n_Best of ${result.candidates.length} candidates after ${result.iterations} model calls via ${client.provider}:${client.model} (${seconds}s). Judge: ${result.judgeReason}_\n\n---\n\n${result.packet}\n`,
);
console.error(`\nWinner -> ${winnerPath}`);

result.candidates.forEach((c, i) => {
  writeFileSync(resolve(outDir, `${slug}_candidate_${i}.md`), c);
});
console.error(`Candidates -> ${outDir}/${slug}_candidate_{0..${result.candidates.length - 1}}.md`);
