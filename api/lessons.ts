import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAllLessons } from "../src/data.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  const list = Object.values(getAllLessons()).map((l) => ({
    id: l.id,
    title: l.title,
    subject: l.subject,
    grade: l.grade,
    duration_min: l.duration_min,
    standards: l.standards,
  }));
  res.status(200).json(list);
}
