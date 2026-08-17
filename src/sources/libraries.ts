import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, stripHtml } from "../lib/http.js";
import { campusNowLabel, campusToday } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Purdue Libraries run Springshare LibCal; the hours widget endpoints are public.
const BASE = "https://calendar.lib.purdue.edu";

type Loc = {
  lid: number;
  name: string;
  category: string;
  desc: string | null;
  url: string | null;
  times: { status: string; text?: string; currently_open?: boolean; hours?: { from: string; to: string }[] };
  weeks?: Record<string, { date: string; times: any }>[];
};

function hoursText(t: Loc["times"]): string {
  if (!t) return "unknown";
  if (t.status === "closed") return "closed";
  if (t.status === "24hours") return "open 24 hours";
  if (t.hours?.length) return t.hours.map((h) => `${h.from}–${h.to}`).join(", ");
  return stripHtml(t.text, 120) || t.status;
}

export function registerLibraries(server: McpServer) {
  server.registerTool(
    "library_hours",
    {
      title: "Purdue library hours",
      description:
        "Today's hours and open/closed status for every Purdue library and study space (WALC, Hicks, HSSE, Parrish, Archives, …), or a full week's grid. Source: Purdue Libraries LibCal (live).",
      inputSchema: {
        query: z.string().optional().describe("Filter by library name, e.g. 'WALC', 'Hicks'."),
        week: z.boolean().optional().describe("Return the whole week instead of just today."),
        open_now: z.boolean().optional().describe("Only libraries currently open."),
      },
    },
    async ({ query, week, open_now }): Promise<ToolResult> => {
      const url = week
        ? `${BASE}/widget/hours/grid?iid=1&lid=0&format=json`
        : `${BASE}/api_hours_today.php?iid=1&lid=0&format=json`;
      const data = await getJSON<{ locations: Loc[] }>(url, { ttlMs: 15 * 60_000 });

      let locs = data.locations ?? [];
      if (query) {
        const q = query.toLowerCase();
        locs = locs.filter((l) => l.name.toLowerCase().includes(q));
      }
      if (open_now) locs = locs.filter((l) => l.times?.currently_open);
      if (!locs.length) return text(`No library matches${query ? ` "${query}"` : ""}.`);

      if (week) {
        const out = locs.map((l) => {
          const days = Object.values(l.weeks?.[0] ?? {})
            .map((d: any) => `    ${d.date}: ${hoursText(d.times)}`)
            .join("\n");
          return `${l.name}\n${days}`;
        });
        return text(`Purdue library hours — week of ${campusToday()}\n\n${out.join("\n\n")}`);
      }

      const out = locs.map((l) => {
        const open = l.times?.currently_open ? "OPEN NOW" : "closed now";
        return `${l.name} — ${open}\n  today: ${hoursText(l.times)}${l.url ? `\n  ${l.url}` : ""}`;
      });
      return text(`Purdue library hours — ${campusNowLabel()}\n\n${out.join("\n\n")}`);
    },
  );
}
