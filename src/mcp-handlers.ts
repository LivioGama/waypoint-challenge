import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  students,
  getStudent,
  getLesson,
  iepSection,
  IEP_SECTION_NAMES,
  getAllLessons,
} from "./data.js";
import { generatePacket } from "./refine.js";
import { generateParentSummary } from "./parent-summary.js";
import { getModelClient } from "./model.js";
import { verifyPacket, inferIdsFromPath } from "./verify-citations.js";
import { readFileSync } from "node:fs";
import { parseIepFromText } from "./parse-iep.js";

export function buildServer(): Server {
  const server = new Server(
    { name: "waypoint-iep-mcp", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {} } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const out: Array<{ uri: string; name: string; mimeType: string }> = [];
    for (const [id, s] of Object.entries(students)) {
      out.push({
        uri: `iep://${id}/structured`,
        name: `${s.student.name} — IEP (structured JSON)`,
        mimeType: "application/json",
      });
    }
    const allLessons = getAllLessons();
    for (const [id, l] of Object.entries(allLessons)) {
      out.push({
        uri: `lesson://${id}/full-text`,
        name: `Lesson — ${l.title} (Grade ${l.grade} ${l.subject})`,
        mimeType: "text/plain",
      });
      out.push({
        uri: `lesson://${id}/meta`,
        name: `Lesson metadata — ${l.title}`,
        mimeType: "application/json",
      });
    }
    return { resources: out };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const iepMatch = uri.match(/^iep:\/\/([^/]+)\/structured$/);
    if (iepMatch) {
      const s = getStudent(iepMatch[1]);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(s, null, 2) }] };
    }
    const lessonText = uri.match(/^lesson:\/\/([^/]+)\/full-text$/);
    if (lessonText) {
      const l = getLesson(lessonText[1]);
      return { contents: [{ uri, mimeType: "text/plain", text: l.text }] };
    }
    const lessonMeta = uri.match(/^lesson:\/\/([^/]+)\/meta$/);
    if (lessonMeta) {
      const { text: _omit, ...meta } = getLesson(lessonMeta[1]);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(meta, null, 2) }] };
    }
    throw new Error(`unknown resource: ${uri}`);
  });

  const tools = [
    { name: "list_students", description: "List students whose IEPs are loaded.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "list_lessons", description: "List lessons available for adaptation.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "list_iep_sections", description: "List IEP section names.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    {
      name: "get_iep_section",
      description: "Fetch one structured section of an IEP (e.g. 'goal.3', 'present_levels.ela', 'accommodations').",
      inputSchema: {
        type: "object",
        properties: {
          section: { type: "string", description: `One of: ${IEP_SECTION_NAMES.join(", ")}, or "goal.<n>".` },
          student_id: { type: "string" },
        },
        required: ["section"],
        additionalProperties: false,
      },
    },
    {
      name: "get_lesson",
      description: "Get full text of a lesson plus metadata.",
      inputSchema: { type: "object", properties: { lesson_id: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "verify_citations",
      description:
        "Verify every quoted phrase and structural reference (Paragraph N / MCQ #N) in a teacher packet against the source IEP JSON and lesson text. Returns a structured match report.",
      inputSchema: {
        type: "object",
        properties: {
          packet: {
            type: "string",
            description: "Either the packet markdown text OR a path to the packet file.",
          },
          student_id: { type: "string" },
          lesson_id: { type: "string" },
        },
        required: ["packet"],
        additionalProperties: false,
      },
    },
    {
      name: "parse_iep_pdf",
      description: "Extract text from a base64-encoded IEP PDF and coerce it into the canonical structured-IEP JSON shape. Returns the parsed JSON without writing to disk. Requires API key in server env.",
      inputSchema: {
        type: "object",
        properties: {
          pdf_base64: { type: "string", description: "Base64-encoded PDF bytes." },
        },
        required: ["pdf_base64"],
        additionalProperties: false,
      },
    },
    {
      name: "generate_parent_summary",
      description: "Distill the teacher packet for one student × one lesson into a one-page parent-facing letter (default Spanish). Plain language, no jargon. Pass an existing `packet` to skip regeneration. Requires API key in server env.",
      inputSchema: {
        type: "object",
        properties: {
          student_id: { type: "string" },
          lesson_id: { type: "string" },
          language: { type: "string", description: "BCP-47-ish language code. Defaults to 'es' (Spanish). 'en' supported.", default: "es" },
          packet: { type: "string", description: "Optional pre-generated teacher packet markdown. If omitted, the refinement loop runs first." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "generate_modifications",
      description: "Run refinement loop and produce best teacher packet for one student × one lesson. Requires API key in server env.",
      inputSchema: {
        type: "object",
        properties: {
          student_id: { type: "string" },
          lesson_id: { type: "string" },
          return_candidates: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  const GenerateInput = z.object({
    student_id: z.string().optional(),
    lesson_id: z.string().optional(),
    return_candidates: z.boolean().optional(),
  });

  const ParentSummaryInput = z.object({
    student_id: z.string().optional(),
    lesson_id: z.string().optional(),
    language: z.string().optional(),
    packet: z.string().optional(),
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === "list_students") {
      const list = Object.values(students).map((s) => ({
        id: s.id,
        name: s.student.name,
        grade: s.student.grade,
        disability: (s.disability as { category: string }).category,
      }));
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }
    if (name === "list_lessons") {
      const list = Object.values(getAllLessons()).map((l) => ({
        id: l.id,
        title: l.title,
        subject: l.subject,
        grade: l.grade,
        duration_min: l.duration_min,
        standards: l.standards,
      }));
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }
    if (name === "list_iep_sections") {
      return { content: [{ type: "text", text: IEP_SECTION_NAMES.join("\n") }] };
    }
    if (name === "get_iep_section") {
      const section = String(a.section ?? "");
      const data = iepSection(section, a.student_id as string | undefined);
      if (data === undefined) throw new Error(`unknown section: ${section}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (name === "get_lesson") {
      const lesson = getLesson(a.lesson_id as string | undefined);
      return { content: [{ type: "text", text: lesson.text }] };
    }
    if (name === "verify_citations") {
      const rawPacket = String(a.packet ?? "");
      if (!rawPacket) throw new Error("verify_citations requires `packet`");
      // Heuristic: treat as a path when it has no newline and ends with .md / exists.
      let packetText = rawPacket;
      let packetPath = "<inline>";
      if (!rawPacket.includes("\n") && rawPacket.length < 1024) {
        try {
          packetText = readFileSync(rawPacket, "utf8");
          packetPath = rawPacket;
        } catch {
          // fall through — treat the string as inline packet text
        }
      }
      const inferred = inferIdsFromPath(packetPath);
      const studentId = (a.student_id as string | undefined) ?? inferred.studentId;
      const lessonId = (a.lesson_id as string | undefined) ?? inferred.lessonId;
      if (!studentId || !lessonId) {
        throw new Error("verify_citations: provide student_id and lesson_id (could not infer from packet path)");
      }
      const report = verifyPacket({ packetText, packetPath, studentId, lessonId });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
    if (name === "parse_iep_pdf") {
      const b64 = String(a.pdf_base64 ?? "");
      if (!b64) throw new Error("pdf_base64 is required");
      const buf = Buffer.from(b64, "base64");
      const mod = await import("pdf-parse");
      const PDFParse = (mod as { PDFParse: new (opts: { data: Buffer }) => { getText: () => Promise<{ text?: string; pages?: Array<{ text?: string }> }> } }).PDFParse;
      const parser = new PDFParse({ data: buf });
      const result = await parser.getText();
      const text = result?.text ?? (Array.isArray(result?.pages) ? result.pages.map((p) => p.text ?? "").join("\n\n") : "");
      if (!text.trim()) throw new Error("No text extracted from PDF");
      const { iep, missing } = await parseIepFromText(text);
      return {
        content: [
          { type: "text", text: JSON.stringify({ iep, missing }, null, 2) },
        ],
      };
    }
    if (name === "generate_parent_summary") {
      const parsed = ParentSummaryInput.parse(args ?? {});
      const client = getModelClient();
      const result = await generateParentSummary(client, {
        studentId: parsed.student_id,
        lessonId: parsed.lesson_id,
        language: parsed.language,
        packet: parsed.packet,
      });
      const header = `# Parent Summary (${result.language}${result.generatedPacket ? ", regenerated packet" : ", supplied packet"}, via ${client.provider}:${client.model})\n\n---\n\n`;
      return { content: [{ type: "text", text: `${header}${result.letter}` }] };
    }
    if (name === "generate_modifications") {
      const parsed = GenerateInput.parse(args ?? {});
      const client = getModelClient();
      const result = await generatePacket(client, {
        studentId: parsed.student_id,
        lessonId: parsed.lesson_id,
      });
      const summary = `# Teacher Packet (best of ${result.candidates.length} candidates, ${result.iterations} model calls via ${client.provider}:${client.model})\n\n_Judge picked candidate #${result.winnerIndex}: ${result.judgeReason}_\n\n---\n\n${result.packet}`;
      if (parsed.return_candidates) {
        return {
          content: [
            { type: "text", text: summary },
            {
              type: "text",
              text: `\n\n=== ALL CANDIDATES ===\n\n${result.candidates.map((c, i) => `--- Candidate ${i} ---\n${c}`).join("\n\n")}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: summary }] };
    }
    throw new Error(`unknown tool: ${name}`);
  });

  return server;
}
