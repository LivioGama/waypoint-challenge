#!/usr/bin/env node
// HTTP shim around the MCP server so a browser can use it.
// Spawns the real MCP server as a child process and forwards calls over stdio.
// Adds an SSE endpoint that streams real per-draft progress for the refinement loop.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "dotenv";
import { generatePacket } from "./refine.js";
import { getModelClient } from "./model.js";
import { addUploadedLesson } from "./data.js";
import { rateLimiter, getClientIp } from "./rate-limiter.js";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

// CORS configuration
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://waypoint-challenge.vercel.app,http://localhost:8787").split(",").map(o => o.trim());
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// In-memory storage of uploaded lessons (persists during session)
const uploadedLessonsMap = new Map<string, { id: string; title: string; subject: string; grade: string; duration_min: number; standards: string[]; text: string }>();

const mcp = spawn("bunx", ["tsx", join(__dirname, "server.ts")], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "inherit"],
});

let mcpInitialized = false;
let stdoutBuf = "";
const pending = new Map<number, (r: { id: number; result?: unknown; error?: { message: string } }) => void>();
let nextId = 0;

mcp.stdout?.on("data", (chunk: Buffer) => {
  stdoutBuf += chunk.toString();
  let nl: number;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.error("non-JSON from MCP stdout:", line.slice(0, 200));
    }
  }
});

mcp.on("exit", (code) => console.log(`MCP process exited with code ${code}`));

function rpcRequest(method: string, params: unknown = {}, timeoutMs = 600_000): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    mcp.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP timeout (${method})`));
      }
    }, timeoutMs);
  });
}

function rpcNotify(method: string, params: unknown = {}) {
  mcp.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await rpcRequest("tools/call", { name, arguments: args });
  if (r.error) throw new Error(r.error.message);
  return ((r.result as { content: { text: string }[] }).content[0]).text;
}

(async () => {
  await rpcRequest(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bridge", version: "1.0.0" },
    },
    10_000,
  );
  rpcNotify("notifications/initialized");
  mcpInitialized = true;
  console.log("MCP server initialized");
})().catch((e) => {
  console.error("Failed to initialize MCP:", e);
  process.exit(1);
});

const WEB_ROOT = join(__dirname, "..", "web");

const server = http.createServer(async (req, res) => {
  // CORS handling with restricted origins
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const url = new URL(req.url || "", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "ok", mcpInitialized }));
    }

    // Static
    if (url.pathname === "/" || url.pathname.startsWith("/web/")) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(5);
      const filePath = join(WEB_ROOT, rel);
      if (!filePath.startsWith(WEB_ROOT + "/") && filePath !== join(WEB_ROOT, "index.html")) {
        return res.writeHead(403).end("Forbidden");
      }
      try {
        const content = await readFile(filePath);
        const ext = filePath.split(".").pop();
        const ct =
          ext === "html" ? "text/html; charset=utf-8" :
          ext === "css"  ? "text/css; charset=utf-8" :
          ext === "js"   ? "application/javascript; charset=utf-8" :
          "text/plain; charset=utf-8";
        return res.writeHead(200, { "Content-Type": ct }).end(content);
      } catch {
        return res.writeHead(404).end("Not found");
      }
    }

    // ---- API: read-only lookups (forward to MCP) ----
    if (url.pathname === "/api/students") {
      return jsonOk(res, JSON.parse(await callTool("list_students")));
    }
    if (url.pathname === "/api/lessons") {
      const mcpLessons = JSON.parse(await callTool("list_lessons")) as Array<any>;
      const allLessons = [...mcpLessons];
      for (const lesson of uploadedLessonsMap.values()) {
        allLessons.push({
          id: lesson.id,
          title: lesson.title,
          subject: lesson.subject,
          grade: lesson.grade,
          duration_min: lesson.duration_min,
          standards: lesson.standards,
        });
      }
      return jsonOk(res, allLessons);
    }
    if (url.pathname === "/api/sections") {
      return jsonOk(res, (await callTool("list_iep_sections")).split("\n"));
    }
    if (url.pathname === "/api/section") {
      const section = url.searchParams.get("name");
      const studentId = url.searchParams.get("student_id") ?? undefined;
      if (!section) return jsonErr(res, 400, "Missing 'name' parameter");
      const text = await callTool("get_iep_section", { section, ...(studentId ? { student_id: studentId } : {}) });
      return res.writeHead(200, { "Content-Type": "application/json" }).end(text);
    }
    if (url.pathname === "/api/lesson") {
      const lessonId = url.searchParams.get("lesson_id") ?? undefined;
      // Check uploaded lessons first
      if (lessonId && uploadedLessonsMap.has(lessonId)) {
        return jsonOk(res, { text: uploadedLessonsMap.get(lessonId)!.text });
      }
      // Fall back to MCP server
      const text = await callTool("get_lesson", lessonId ? { lesson_id: lessonId } : {});
      return jsonOk(res, { text });
    }

    // ---- POST: upload lesson ----
    if (url.pathname === "/api/upload-lesson") {
      if (req.method !== "POST") {
        return jsonErr(res, 405, "Method not allowed");
      }
      try {
        const body = await getRequestBody(req);
        
        // Check file size
        if (body.length > MAX_FILE_SIZE_BYTES) {
          return jsonErr(res, 413, `File size exceeds ${MAX_FILE_SIZE_MB}MB limit`);
        }
        
        const boundary = req.headers["content-type"]?.split("boundary=")[1];
        if (!boundary) {
          return jsonErr(res, 400, "Missing multipart boundary");
        }
        const parts = parseMultipart(body, boundary);
        const jsonFile = parts.find(p => p.name === "jsonFile");
        const txtFile = parts.find(p => p.name === "txtFile");
        const txtPaste = parts.find(p => p.name === "txtPaste");
        const lessonName = parts.find(p => p.name === "lessonName");

        // TXT is required (either file or paste)
        if (!txtFile && !txtPaste) {
          return jsonErr(res, 400, "Missing lesson text (TXT file is required)");
        }

        type LessonMeta = {
          id: string;
          title: string;
          subject: string;
          grade: string | number;
          duration_min: number;
          standards: string[];
          description?: string;
        };
        let lessonMeta: LessonMeta;
        let lessonText: string;
        let baseName: string;

        // Get lesson text and base name from either paste or file
        if (txtPaste) {
          lessonText = txtPaste.content;
          baseName = lessonName?.content || "My Lesson";
        } else if (txtFile) {
          lessonText = txtFile.content;
          // Extract base name from filename (e.g., "ecology.txt" -> "ecology")
          const filename = txtFile.filename || "lesson";
          baseName = filename.replace(/\.(txt|md)$/i, "").replace(/[-_]/g, " ");
        } else {
          return jsonErr(res, 400, "Missing lesson text");
        }

        // If JSON provided, parse and validate it
        if (jsonFile) {
          try {
            lessonMeta = JSON.parse(jsonFile.content) as LessonMeta;
          } catch (e) {
            return jsonErr(res, 400, "JSON parse error: " + (e as Error).message);
          }

          // Validate required fields
          const required = ["id", "title", "subject", "grade", "duration_min", "standards"];
          for (const field of required) {
            if (!(field in lessonMeta)) {
              return jsonErr(res, 400, `Missing required field: ${field}`);
            }
          }

          // Validate types
          if (typeof lessonMeta.id !== "string") return jsonErr(res, 400, "id must be a string");
          if (typeof lessonMeta.title !== "string") return jsonErr(res, 400, "title must be a string");
          if (typeof lessonMeta.subject !== "string") return jsonErr(res, 400, "subject must be a string");
          if (typeof lessonMeta.grade !== "string" && typeof lessonMeta.grade !== "number") return jsonErr(res, 400, "grade must be a string or number");
          if (typeof lessonMeta.duration_min !== "number") return jsonErr(res, 400, "duration_min must be a number");
          if (!Array.isArray(lessonMeta.standards)) return jsonErr(res, 400, "standards must be an array");
        } else {
          // Auto-generate metadata from filename + defaults (JSON optional)
          let title = baseName;

          // Try to extract title from first line if it starts with # (markdown heading)
          const firstLine = lessonText.split("\n")[0].trim();
          if (firstLine.startsWith("#")) {
            title = firstLine.replace(/^#+\s*/, "").trim();
          }

          // Use filename as ID (without extension)
          const id = baseName.toLowerCase().replace(/\s+/g, "-");

          lessonMeta = {
            id: id,
            title: title.charAt(0).toUpperCase() + title.slice(1),
            subject: "Custom",
            grade: "7",
            duration_min: 45,
            standards: ["Custom"],
          };
        }

        // Add lesson to memory
        const lesson = {
          id: lessonMeta.id,
          title: lessonMeta.title,
          subject: lessonMeta.subject,
          grade: String(lessonMeta.grade),
          duration_min: lessonMeta.duration_min,
          standards: lessonMeta.standards,
          description: lessonMeta.description || "",
          text: lessonText,
        };

        addUploadedLesson(lesson);
        uploadedLessonsMap.set(lesson.id, lesson);
        return jsonOk(res, {
          success: true,
          lessonId: lesson.id,
          message: `Lesson "${lesson.title}" uploaded successfully`,
        });
      } catch (e) {
        return jsonErr(res, 400, (e as Error).message);
      }
    }

    // ---- SSE: real progress for the refinement loop ----
    if (url.pathname === "/api/generate/stream") {
      // Rate limiting
      const ip = getClientIp(req);
      const rateLimit = rateLimiter.check(ip);
      
      // Add rate limit headers
      res.setHeader("X-RateLimit-Limit-Hourly", String(rateLimiter["hourlyLimit"]));
      res.setHeader("X-RateLimit-Limit-Daily", String(rateLimiter["dailyLimit"]));
      res.setHeader("X-RateLimit-Remaining-Hourly", String(rateLimit.remainingHourly));
      res.setHeader("X-RateLimit-Remaining-Daily", String(rateLimit.remainingDaily));
      res.setHeader("X-RateLimit-Reset-Hourly", new Date(rateLimit.resetTimeHourly).toISOString());
      res.setHeader("X-RateLimit-Reset-Daily", new Date(rateLimit.resetTimeDaily).toISOString());

      if (!rateLimit.allowed) {
        const resetTime = Math.min(rateLimit.resetTimeHourly, rateLimit.resetTimeDaily);
        const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
        res.setHeader("Retry-After", String(retryAfter));
        return jsonErr(res, 429, `Rate limit exceeded. Try again in ${retryAfter} seconds.`);
      }

      try {
        getModelClient(); // throws if no key
      } catch (e) {
        return jsonErr(res, 500, (e as Error).message);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const studentId = url.searchParams.get("student_id") ?? undefined;
        const lessonId = url.searchParams.get("lesson_id") ?? undefined;
        const maxDurationMsParam = url.searchParams.get("maxDurationMs");
        const maxDurationMs = maxDurationMsParam ? Number(maxDurationMsParam) : undefined;
        
        // Validate parameters
        if (studentId && !/^[a-z0-9-]+$/.test(studentId)) {
          return jsonErr(res, 400, "Invalid student_id format");
        }
        if (lessonId && !/^[a-z0-9-]+$/.test(lessonId)) {
          return jsonErr(res, 400, "Invalid lesson_id format");
        }
        if (maxDurationMs && (maxDurationMs < 1000 || maxDurationMs > 300000)) {
          return jsonErr(res, 400, "maxDurationMs must be between 1000 and 300000ms");
        }
        
        const client = getModelClient();
        send("meta", { provider: client.provider, model: client.model });
        const result = await generatePacket(client, {
          studentId,
          lessonId,
          maxDurationMs,
          onProgress: (e) => send("progress", e),
        });
        send("done", {
          packet: result.packet,
          winnerIndex: result.winnerIndex,
          iterations: result.iterations,
          judgeReason: result.judgeReason,
          candidateCount: result.candidates.length,
          provider: client.provider,
          model: client.model,
        });
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    res.writeHead(404).end("Not found");
  } catch (err) {
    console.error("Request error:", err);
    jsonErr(res, 500, (err as Error).message);
  }
});

function jsonOk(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
function jsonErr(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
}

function getRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body: Buffer, boundary: string): Array<{ name: string; content: string; filename?: string }> {
  const parts: Array<{ name: string; content: string; filename?: string }> = [];
  const boundaryBytes = Buffer.from(`--${boundary}`);
  const endBoundaryBytes = Buffer.from(`--${boundary}--`);

  let pos = 0;
  while (pos < body.length) {
    const nextBoundary = body.indexOf(boundaryBytes, pos);
    if (nextBoundary === -1) break;

    pos = nextBoundary + boundaryBytes.length;
    // Skip CRLF after boundary
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    else if (body[pos] === 10) pos += 1;

    // Read headers until blank line
    let headerEnd = pos;
    while (headerEnd < body.length - 3) {
      if (
        body[headerEnd] === 13 &&
        body[headerEnd + 1] === 10 &&
        body[headerEnd + 2] === 13 &&
        body[headerEnd + 3] === 10
      ) {
        break;
      }
      headerEnd++;
    }

    const headerText = body.toString("utf8", pos, headerEnd);
    const nameMatch = headerText.match(/name="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : "";
    const filenameMatch = headerText.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : undefined;

    // Skip header and blank line
    let contentStart = headerEnd + 4;

    // Find next boundary
    const nextBoundaryPos = body.indexOf(boundaryBytes, contentStart);
    let contentEnd = nextBoundaryPos;
    if (contentEnd > contentStart && body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    } else if (contentEnd > contentStart && body[contentEnd - 1] === 10) {
      contentEnd -= 1;
    }

    const content = body.toString("utf8", contentStart, contentEnd);
    parts.push({ name, content, filename });

    if (nextBoundaryPos === -1) break;
    pos = nextBoundaryPos;
  }

  return parts;
}

server.listen(PORT, () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
});
