import type { VercelRequest, VercelResponse } from "@vercel/node";
import { iepSection } from "../src/data.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  const name = (req.query.name as string) || "";
  const studentId = (req.query.student_id as string) || undefined;
  if (!name) return res.status(400).json({ error: "Missing 'name' parameter" });
  try {
    const data = iepSection(name, studentId);
    if (data === undefined) return res.status(404).json({ error: `unknown section: ${name}` });
    res.status(200).json(data);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
