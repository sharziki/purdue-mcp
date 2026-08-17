import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON } from "../lib/http.js";
import { campusNowLabel, prettyStamp } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Purdue RecWell's live occupancy counters (Connect2 / GoBoard). The account key
// is the one Purdue's own public facility-usage widget ships in its JS bundle.
const KEY = "aedeaf92-036d-4848-980b-7eb5526ea40c";
const URL = `https://goboardapi.azurewebsites.net/api/FacilityCount/GetCountsByAccount?AccountAPIKey=${KEY}`;

type Count = {
  LocationName: string;
  FacilityName: string;
  LastCount: number;
  TotalCapacity: number;
  IsClosed: boolean;
  LastUpdatedDateAndTime: string;
};

function pct(c: Count): number {
  return c.TotalCapacity > 0 ? Math.round((c.LastCount / c.TotalCapacity) * 100) : 0;
}

function bar(p: number): string {
  const filled = Math.min(10, Math.round(p / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function registerRecreation(server: McpServer) {
  server.registerTool(
    "recwell_occupancy",
    {
      title: "Live gym / CoRec occupancy",
      description:
        "Real-time headcount and percent-of-capacity for every counted Purdue RecWell space — CoRec fitness floors, tracks, courts, climbing walls, pools. Answers 'how busy is the gym right now'. Source: Purdue RecWell live facility counts (updates ~every 30s).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Filter by space name, e.g. 'fitness', 'climbing', 'track', 'gym'."),
        open_only: z.boolean().optional().describe("Hide closed spaces. Default true."),
        sort: z
          .enum(["busiest", "quietest", "name"])
          .optional()
          .describe("Sort order. Default 'busiest'."),
      },
    },
    async ({ query, open_only, sort }): Promise<ToolResult> => {
      const data = await getJSON<Count[]>(URL, { ttlMs: 30_000 });
      let rows = data ?? [];
      if (open_only !== false) rows = rows.filter((r) => !r.IsClosed);
      if (query) {
        const q = query.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.LocationName.toLowerCase().includes(q) || r.FacilityName?.toLowerCase().includes(q),
        );
      }
      if (!rows.length) return text(`No RecWell spaces match${query ? ` "${query}"` : ""}.`);

      const order = sort ?? "busiest";
      rows.sort((a, b) =>
        order === "name"
          ? a.LocationName.localeCompare(b.LocationName)
          : order === "quietest"
            ? pct(a) - pct(b)
            : pct(b) - pct(a),
      );

      const lines = rows.map((r) => {
        const p = pct(r);
        return `${bar(p)} ${String(p).padStart(3)}%  ${r.LocationName.trim()} — ${r.LastCount}/${r.TotalCapacity}${r.IsClosed ? " (CLOSED)" : ""}`;
      });
      const newest = rows
        .map((r) => r.LastUpdatedDateAndTime)
        .sort()
        .pop();
      return text(
        `Purdue RecWell live occupancy — ${campusNowLabel()}\n` +
          `(last counter update ${prettyStamp(newest ? `${newest}-04:00` : null)})\n\n${lines.join("\n")}`,
      );
    },
  );
}
