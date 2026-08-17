import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stripHtml } from "../lib/http.js";
import { prettyStamp } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Unofficial student-voice sources: the campus subreddit and the independent
// student newspaper. Both publish public feeds.
const REDDIT = "https://www.reddit.com/r/Purdue";
const EXPONENT = "https://www.purdueexponent.org/search/";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Entry = { at: number; body: string };
const cache = new Map<string, Entry>();

async function feed(url: string, ttlMs = 5 * 60_000): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, */*" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const body = await res.text();
  cache.set(url, { at: Date.now(), body });
  return body;
}

const tag = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return stripHtml((m?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, ""), 400);
};

const attr = (xml: string, name: string, a: string): string =>
  new RegExp(`<${name}[^>]*${a}="([^"]+)"`, "i").exec(xml)?.[1] ?? "";

export function registerCommunity(server: McpServer) {
  server.registerTool(
    "reddit_purdue",
    {
      title: "What Purdue students are talking about",
      description:
        "Current posts from r/Purdue — the unofficial student pulse: housing and sublease chatter, campus gripes, events, advice threads, what is actually happening this week. Unofficial and unmoderated by the university; treat as opinion, not fact. Source: reddit.com/r/Purdue public feed.",
      inputSchema: {
        sort: z
          .enum(["hot", "new", "top", "rising"])
          .optional()
          .describe("Feed to read. Default 'hot'."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 15."),
      },
    },
    async ({ sort, limit }): Promise<ToolResult> => {
      const xml = await feed(`${REDDIT}/${sort ?? "hot"}/.rss?limit=${limit ?? 15}`);
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, limit ?? 15);
      if (!entries.length) return text("No r/Purdue posts returned.");
      return text(
        `r/Purdue — ${sort ?? "hot"}\n\n` +
          entries
            .map((e) => {
              const x = e[1];
              const author = tag(x, "name");
              const body = tag(x, "content").slice(0, 260);
              return `${tag(x, "title")}\n  ${author} · ${prettyStamp(tag(x, "updated"))}\n  ${attr(x, "link", "href")}${body ? `\n  ${body}` : ""}`;
            })
            .join("\n\n"),
      );
    },
  );

  server.registerTool(
    "purdue_exponent",
    {
      title: "Purdue Exponent student newspaper",
      description:
        "Articles from the Purdue Exponent, the independent student newspaper — campus reporting, student government, local news, sports coverage. Editorially independent of the university. Source: purdueexponent.org public feed.",
      inputSchema: {
        section: z
          .enum(["news", "sports", "features", "opinions"])
          .optional()
          .describe("Section to read. Default 'news'."),
        limit: z.number().int().min(1).max(30).optional().describe("Default 10."),
      },
    },
    async ({ section, limit }): Promise<ToolResult> => {
      const n = limit ?? 10;
      const url = `${EXPONENT}?f=rss&t=article&l=${n}&s=start_time&sd=desc&c=${section ?? "news"}`;
      const xml = await feed(url);
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n);
      if (!items.length) return text(`No Exponent articles in "${section ?? "news"}".`);
      return text(
        `Purdue Exponent — ${section ?? "news"}\n\n` +
          items
            .map((i) => {
              const x = i[1];
              const desc = tag(x, "description").slice(0, 280);
              return `${tag(x, "title")}\n  ${prettyStamp(tag(x, "pubDate"))}\n  ${tag(x, "link")}${desc ? `\n  ${desc}` : ""}`;
            })
            .join("\n\n"),
      );
    },
  );
}
