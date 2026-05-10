import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getLesson } from "../src/data.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  const lessonId = (req.query.lesson_id as string) || undefined;
  try {
    const l = getLesson(lessonId);
    res.status(200).json({ text: l.text });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
}
