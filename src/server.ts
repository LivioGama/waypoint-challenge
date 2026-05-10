#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp-handlers.js";

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
