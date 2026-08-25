#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("purdue-mcp failed to start:", err);
  process.exit(1);
});
