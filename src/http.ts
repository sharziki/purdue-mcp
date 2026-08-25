#!/usr/bin/env node
/**
 * Streamable-HTTP front door for purdue-mcp.
 *
 * Stateless by design: a fresh server + transport per request. Callers here are
 * short-lived agent turns (Rex opens a session, makes a call or two, drops it),
 * so there is no session worth pooling and a dead pooled socket is a worse
 * failure than a fresh handshake. Stdlib `node:http` — no express.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8971);
const HOST = process.env.HOST ?? "127.0.0.1";
const PATH = process.env.MCP_PATH ?? "/mcp";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "purdue-mcp", version: "0.3.0" }));
    return;
  }

  if (url.pathname !== PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", expected: PATH }));
    return;
  }

  // Stateless: no session id, no reuse across requests.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    const body = req.method === "POST" ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("purdue-mcp http error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal server error" },
          id: null,
        }),
      );
    }
  }
}

createHttpServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("purdue-mcp unhandled:", err);
    if (!res.headersSent) res.writeHead(500).end();
  });
}).listen(PORT, HOST, () => {
  console.error(`purdue-mcp streamable-http listening on http://${HOST}:${PORT}${PATH}`);
});
