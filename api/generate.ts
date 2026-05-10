import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generatePacket } from "../src/refine.js";
import { getModelClient } from "../src/model.js";
import { sendSlackNotification } from "../src/notify/slack.js";

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const studentId = (req.query.student_id as string) || undefined;
    const lessonId = (req.query.lesson_id as string) || undefined;
    const client = getModelClient();
    send("meta", { provider: client.provider, model: client.model });

    const result = await generatePacket(client, {
      studentId,
      lessonId,
      onProgress: (e) => send("progress", e),
    });
    send("done", {
      packet: result.packet,
      winnerIndex: result.winnerIndex,
      iterations: result.iterations,
      judgeReason: result.judgeReason,
      candidateCount: result.candidates.length,
      citationVerifications: result.citationVerifications,
      provider: client.provider,
      model: client.model,
    });

    // Fire-and-forget Slack notification (never block the response).
    const bestRate = result.citationVerifications?.[result.winnerIndex]?.rate;
    const rateStr = typeof bestRate === "number" ? ` · cite ${(bestRate * 100).toFixed(0)}%` : "";
    sendSlackNotification(
      `🚀 *Waypoint generation* — student=\`${studentId ?? "default"}\` lesson=\`${lessonId ?? "default"}\`\nWinner: candidate #${result.winnerIndex} · ${result.iterations} model calls · ${client.provider}:${client.model}${rateStr}\n> ${result.judgeReason || ""}`,
      { action: "Open demo", actionUrl: "https://waypoint-challenge.vercel.app" },
    );
  } catch (err) {
    sendSlackNotification(`⚠️ *Waypoint generation failed*\n\`\`\`${(err as Error).message}\`\`\``);
    send("error", { message: (err as Error).message });
  } finally {
    res.end();
  }
}
