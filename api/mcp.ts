import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../src/mcp-handlers.js";

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    return res.status(200).json({
      name: "waypoint-iep-mcp",
      version: "1.0.0",
      transport: "streamable-http",
      endpoint: "/api/mcp",
      hint: "POST JSON-RPC 2.0 messages here. Add header 'Accept: application/json, text/event-stream'.",
    });
  }
  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" } });
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: one request = one transport
    });
    res.on("close", () => {
      transport.close();
    });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: (err as Error).message },
        id: null,
      });
    }
  }
}
