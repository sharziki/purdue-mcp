import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs, stripHtml } from "../lib/http.js";
import { campusToday, prettyStamp, shiftDate } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// events.purdue.edu runs Localist; /api/2 is public and unauthenticated.
const LOCALIST = "https://events.purdue.edu/api/2";
// BoilerLink runs Anthology Engage; its discovery search API is public.
const ENGAGE = "https://purdue.campuslabs.com/engage/api/discovery";

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
      : `${prettyStamp(inst.start)}${inst.end ? ` – ${prettyStamp(inst.end).split(", ").pop()}` : ""}`
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
      const from = start ?? campusToday();
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

  server.registerTool(
    "search_student_orgs",
    {
      title: "Search Purdue student organizations",
      description:
        "Search BoilerLink's directory of ~1,200 registered student organizations by name or keyword. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        query: z.string().optional().describe("Keyword, e.g. 'robotics', 'a cappella', 'finance'."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, limit }): Promise<ToolResult> => {
      const url = `${ENGAGE}/search/organizations${qs({
        query,
        top: limit ?? 20,
        "orderBy[0]": "UpperName asc",
      })}`;
      const data = await getJSON<{
        "@odata.count": number;
        value: {
          Id: string;
          Name: string;
          ShortName: string | null;
          WebsiteKey: string;
          Summary?: string | null;
          Description?: string | null;
          CategoryNames?: string[];
        }[];
      }>(url, { ttlMs: 30 * 60_000 });

      const orgs = data.value ?? [];
      if (!orgs.length) return text(`No student organizations match "${query ?? ""}".`);
      const body = orgs
        .map((o) => {
          const cats = o.CategoryNames?.length ? `\n  categories: ${o.CategoryNames.join(", ")}` : "";
          const blurb = stripHtml(o.Summary || o.Description, 240);
          return `${o.Name.trim()}${o.ShortName ? ` (${o.ShortName})` : ""}${cats}${blurb ? `\n  ${blurb}` : ""}\n  https://purdue.campuslabs.com/engage/organization/${o.WebsiteKey}`;
        })
        .join("\n\n");
      return text(`${orgs.length} of ${data["@odata.count"]} matching org(s)\n\n${body}`);
    },
  );

  server.registerTool(
    "search_club_events",
    {
      title: "Search student-org events on BoilerLink",
      description:
        "Upcoming student organization events (club meetings, socials, callouts) with time, room, and host org. Distinct from the official university calendar. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        query: z.string().optional().describe("Keyword, e.g. 'callout', 'free food', 'hackathon'."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, limit }): Promise<ToolResult> => {
      const url = `${ENGAGE}/event/search${qs({
        query,
        take: limit ?? 20,
        endsAfter: new Date().toISOString(),
        orderByField: "endsOn",
        orderByDirection: "ascending",
        status: "Approved",
      })}`;
      const data = await getJSON<{
        "@odata.count": number;
        value: {
          id: string;
          name: string;
          description: string | null;
          location: string | null;
          startsOn: string;
          endsOn: string;
          organizationName: string;
          theme: string | null;
        }[];
      }>(url, { ttlMs: 5 * 60_000 });

      const events = data.value ?? [];
      if (!events.length) return text(`No upcoming club events match "${query ?? ""}".`);
      const body = events
        .map((e) => {
          const desc = stripHtml(e.description, 240);
          return (
            `${e.name} — ${e.organizationName}\n` +
            `  ${prettyStamp(e.startsOn)} – ${prettyStamp(e.endsOn).split(", ").pop()} · ${e.location || "location TBA"}` +
            `${e.theme ? ` · ${e.theme}` : ""}` +
            `${desc ? `\n  ${desc}` : ""}\n` +
            `  https://purdue.campuslabs.com/engage/event/${e.id}`
          );
        })
        .join("\n\n");
      return text(`${events.length} of ${data["@odata.count"]} upcoming club event(s)\n\n${body}`);
    },
  );
}
