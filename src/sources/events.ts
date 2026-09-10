import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs, stripHtml } from "../lib/http.js";
import { campusToday, parseCampusDate, prettyStamp, shiftDate, stampRange } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// events.purdue.edu runs Localist; /api/2 is public and unauthenticated.
const LOCALIST = "https://events.purdue.edu/api/2";

type LocalistEvent = {
  id: number;
  title: string;
  description_text: string | null;
  location_name: string | null;
  room_number: string | null;
  address: string | null;
  free: boolean;
  ticket_cost: string | null;
  localist_url: string;
  stream_url: string | null;
  event_instances: { event_instance: { start: string; end: string | null; all_day: boolean } }[];
  filters?: Record<string, { name: string }[]>;
};

function formatLocalist(e: LocalistEvent): string {
  const inst = e.event_instances?.[0]?.event_instance;
  const when = inst
    ? inst.all_day
      ? `${prettyStamp(inst.start).replace(/, \d.*$/, "")} (all day)`
      : stampRange(inst.start, inst.end)
    : "time TBA";
  const where =
    [e.location_name, e.room_number].filter(Boolean).join(" ") || e.address || "location TBA";
  const tags = Object.values(e.filters ?? {})
    .flat()
    .map((f) => f.name)
    .slice(0, 5)
    .join(", ");
  const cost = e.free ? "free" : e.ticket_cost ? `cost: ${e.ticket_cost}` : "";
  const desc = stripHtml(e.description_text, 280);
  return [
    `${e.title}`,
    `  ${when} · ${where}${cost ? ` · ${cost}` : ""}`,
    tags ? `  tags: ${tags}` : "",
    desc ? `  ${desc}` : "",
    `  ${e.localist_url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerEvents(server: McpServer) {
  server.registerTool(
    "search_events",
    {
      title: "Search official Purdue campus events",
      description:
        "Official university event calendar (lectures, athletics, concerts, deadlines, career fairs) with times, locations, and links. Source: events.purdue.edu (Localist, live).",
      inputSchema: {
        query: z.string().optional().describe("Keyword search. Omit to browse upcoming events."),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Window in days from the start date. Default 7."),
        start: z.string().optional().describe("YYYY-MM-DD start of window. Defaults to today."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, days, start, limit }): Promise<ToolResult> => {
      const from = start ? parseCampusDate(start) : campusToday();
      if (!from)
        return text(`"${start}" is not a date I can read. Use YYYY-MM-DD, e.g. ${campusToday()}.`);
      const window = days ?? 7;
      const pp = limit ?? 20;
      const path = query ? "/events/search" : "/events";
      const url = `${LOCALIST}${path}${qs({
        search: query,
        start: from,
        end: shiftDate(from, window),
        pp,
      })}`;
      const data = await getJSON<{ events: { event: LocalistEvent }[] }>(url, { ttlMs: 5 * 60_000 });
      const events = (data.events ?? []).map((e) => e.event);
      if (!events.length)
        return text(
          `No Purdue events${query ? ` matching "${query}"` : ""} between ${from} and ${shiftDate(from, window)}.`,
        );
      return text(
        `${events.length} event(s), ${from} → ${shiftDate(from, window)}\n\n${events.map(formatLocalist).join("\n\n")}`,
      );
    },
  );
}
