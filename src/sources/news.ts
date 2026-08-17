import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs, stripHtml } from "../lib/http.js";
import { prettyStamp } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Purdue's Newsroom and Registrar sites run WordPress with the REST API open.
const WP = (site: string) => `https://www.purdue.edu/${site}/wp-json/wp/v2`;

type Post = {
  date: string;
  link: string;
  title: { rendered: string };
  excerpt?: { rendered: string };
  content?: { rendered: string };
};

export function registerNews(server: McpServer) {
  server.registerTool(
    "purdue_news",
    {
      title: "Purdue University news",
      description:
        "Official Purdue newsroom articles — research announcements, university decisions, campus news — searchable by keyword. Source: purdue.edu/newsroom (WordPress REST API, live).",
      inputSchema: {
        query: z.string().optional().describe("Keyword search. Omit for the latest headlines."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
        full_text: z.boolean().optional().describe("Include full article body, not just the excerpt."),
      },
    },
    async ({ query, limit, full_text }): Promise<ToolResult> => {
      const posts = await getJSON<Post[]>(
        `${WP("newsroom")}/posts${qs({ search: query, per_page: limit ?? 10, orderby: query ? "relevance" : "date" })}`,
        { ttlMs: 10 * 60_000 },
      );
      if (!posts.length) return text(`No Purdue news${query ? ` matching "${query}"` : ""}.`);
      return text(
        posts
          .map((p) => {
            const body = full_text
              ? stripHtml(p.content?.rendered, 4000)
              : stripHtml(p.excerpt?.rendered, 400);
            return `${stripHtml(p.title.rendered, 200)}\n  ${prettyStamp(p.date)}\n  ${body}\n  ${p.link}`;
          })
          .join("\n\n"),
      );
    },
  );

  server.registerTool(
    "academic_calendar",
    {
      title: "Purdue academic calendar and registrar info",
      description:
        "The official academic calendar — first day of classes, breaks, finals week, commencement — plus any registrar page (add/drop deadlines, exam scheduling, grade policies) by keyword. Source: purdue.edu/registrar (WordPress REST API, live).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Omit for the official academic calendar itself. Otherwise a keyword, e.g. 'add drop', 'final exams', 'projected calendar'.",
          ),
        limit: z.number().int().min(1).max(10).optional().describe("Default 3."),
      },
    },
    async ({ query, limit }): Promise<ToolResult> => {
      // The calendar page's slug is "academic", but so is a scheduling page —
      // the calendar is the one under /calendars/.
      if (!query) {
        const cands = await getJSON<Post[]>(`${WP("registrar")}/pages?slug=academic&per_page=5`, {
          ttlMs: 60 * 60_000,
        });
        const cal = cands.find((p) => p.link.includes("/calendars/"));
        if (cal)
          return text(
            `${stripHtml(cal.title.rendered, 200)}\n  ${cal.link}\n\n${stripHtml(cal.content?.rendered, 8000)}`,
          );
      }

      const pages = await getJSON<Post[]>(
        `${WP("registrar")}/pages${qs({ search: query, per_page: limit ?? 3 })}`,
        { ttlMs: 60 * 60_000 },
      );
      if (!pages.length) return text(`No registrar page matching "${query}".`);
      // Calendar pages answer most questions here; float them to the top.
      pages.sort((a, b) => Number(b.link.includes("/calendars/")) - Number(a.link.includes("/calendars/")));
      return text(
        pages
          .map(
            (p) =>
              `${stripHtml(p.title.rendered, 200)}\n  ${p.link}\n\n${stripHtml(p.content?.rendered, 5000)}`,
          )
          .join("\n\n---\n\n"),
      );
    },
  );
}
