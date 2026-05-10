import type { VercelRequest, VercelResponse } from "@vercel/node";
import { students } from "../src/data.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  const list = Object.values(students).map((s) => ({
    id: s.id,
    name: s.student.name,
    grade: s.student.grade,
    disability: (s.disability as { category?: string })?.category ?? "",
  }));
  res.status(200).json(list);
}
