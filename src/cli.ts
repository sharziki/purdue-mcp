#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

async function main() {
  const [command, name, rawArguments] = process.argv.slice(2);
  if (!(["list", "schema", "call"].includes(command) &&
      (command === "list" ? !name : Boolean(name)) &&
      (command !== "call" || !rawArguments || rawArguments.startsWith("{")))) {
    throw new Error("usage: purdue-data list | schema TOOL | call TOOL '{\"key\":\"value\"}'");
  }

  const server = createServer();
  const client = new Client({ name: "purdue-data", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    if (command === "list") {
      process.stdout.write(JSON.stringify(tools) + "\n");
      return;
    }
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`unknown Purdue tool: ${name}`);
    if (command === "schema") {
      process.stdout.write(JSON.stringify(tool) + "\n");
      return;
    }
    const args: unknown = rawArguments ? JSON.parse(rawArguments) : {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("tool arguments must be a JSON object");
    }
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.isError) process.exitCode = 1;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
