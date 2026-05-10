import type { VercelRequest, VercelResponse } from "@vercel/node";
import { IEP_SECTION_NAMES } from "../src/data.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json(IEP_SECTION_NAMES);
}
