import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs } from "../lib/http.js";
import { prettyStamp } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// purduesports.com is a Nuxt app backed by a public JSON API.
const BASE = "https://purduesports.com/website-api";

type Sport = { id: number; name: string; schedule_id: number | null };
type Schedule = { id: number; name: string; sport_id: number; season_id: number };
type Event = {
  datetime: string;
  is_all_day: boolean;
  tba: boolean | null;
  tba_text: string | null;
  opponent_name: string | null;
  opponent_ranking: number | null;
  location: string | null;
  venue_type: string | null;
  neutral_event: boolean;
  is_conference: boolean;
  is_exhibition: boolean;
  status: string | null;
  result?: { status?: string; team_score?: number; opponent_score?: number } | null;
};

/** Paginated — the default page size drops the women's teams and wrestling. */
async function sports(): Promise<Sport[]> {
  const { data } = await getJSON<{ data: Sport[] }>(`${BASE}/sports?per_page=200`, {
    ttlMs: 24 * 60 * 60_000,
  });
  return data ?? [];
}

/** Every schedule, newest first. The index is paginated 100 at a time. */
async function schedules(): Promise<Schedule[]> {
  const all: Schedule[] = [];
  for (let page = 1; page <= 8; page++) {
    const res = await getJSON<{ data: Schedule[]; meta: { last_page: number } }>(
      `${BASE}/schedules${qs({ per_page: 100, page })}`,
      { ttlMs: 12 * 60 * 60_000 },
    );
    all.push(...(res.data ?? []));
    if (page >= (res.meta?.last_page ?? 1)) break;
  }
  return all;
}

/** Newest schedule for each sport — the one a student means by "the schedule". */
async function currentSchedules(): Promise<Schedule[]> {
  const [sp, sc] = await Promise.all([sports(), schedules()]);
  const byId = new Map(sc.map((s) => [s.id, s]));
  // /sports names the current schedule for most teams; trust that first.
  const current = new Map<number, Schedule>();
  for (const s of sp) if (s.schedule_id && byId.has(s.schedule_id)) current.set(s.id, byId.get(s.schedule_id)!);

  // For the teams it doesn't tag (several women's teams, volleyball, …), fall back
  // to the newest season by the year in the schedule name — ids are not ordered by
  // year for older sports. Skip discontinued teams whose newest season is stale.
  const year = (s: Schedule) => Number(/(\d{4})/.exec(s.name)?.[1] ?? 0);
  const thisYear = new Date().getUTCFullYear();
  const tagged = new Set(current.keys());
  for (const s of sc) {
    if (tagged.has(s.sport_id) || year(s) < thisYear - 1) continue;
    const held = current.get(s.sport_id);
    if (!held || year(s) > year(held) || (year(s) === year(held) && s.id > held.id))
      current.set(s.sport_id, s);
  }
  return [...current.values()];
}

async function eventsFor(scheduleId: number): Promise<Event[]> {
  const { data } = await getJSON<{ data: Event[] }>(
    `${BASE}/schedule-events?filter%5Bschedule_id%5D=${scheduleId}&per_page=200`,
    { ttlMs: 30 * 60_000 },
  );
  return data ?? [];
}

function fmt(e: Event, sportName?: string): string {
  const when = e.tba ? (e.tba_text ?? "TBA") : prettyStamp(e.datetime);
  const vs = e.neutral_event ? "vs" : e.venue_type === "away" ? "at" : "vs";
  const opp = `${e.opponent_ranking ? `#${e.opponent_ranking} ` : ""}${e.opponent_name ?? "TBA"}`;
  const tags = [
    e.is_conference ? "Big Ten" : "",
    e.is_exhibition ? "exhibition" : "",
    e.venue_type === "home" ? "HOME" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const score =
    e.result?.team_score !== undefined && e.result?.team_score !== null
      ? ` — ${e.result.status ?? ""} ${e.result.team_score}-${e.result.opponent_score}`
      : "";
  return (
    `${when}${sportName ? ` · ${sportName}` : ""}\n  ${vs} ${opp}${score}` +
    `${e.location ? `\n  ${e.location}` : ""}${tags ? `\n  [${tags}]` : ""}`
  );
}

export function registerAthletics(server: McpServer) {
  server.registerTool(
    "athletics_sports",
    {
      title: "List Purdue varsity sports",
      description:
        "Every Purdue varsity sport and its current schedule id. Source: purduesports.com (official athletics site API).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const cur = await currentSchedules();
      const sp = await sports();
      const names = new Map(sp.map((s) => [s.id, s.name]));
      const rows = cur
        .map((s) => `${names.get(s.sport_id) ?? `sport ${s.sport_id}`} — ${s.name} (schedule ${s.id})`)
        .sort();
      return text(rows.join("\n"));
    },
  );

  server.registerTool(
    "athletics_schedule",
    {
      title: "Purdue team schedule",
      description:
        "Full season schedule for one Purdue team — dates, opponents, home/away, venue, and final scores where played. Source: purduesports.com (official athletics site API).",
      inputSchema: {
        sport: z
          .string()
          .describe("Sport name, e.g. 'Football', 'Men's Basketball', 'Volleyball', 'Softball'."),
        upcoming_only: z.boolean().optional().describe("Hide games already played."),
      },
    },
    async ({ sport, upcoming_only }): Promise<ToolResult> => {
      const [sp, cur] = await Promise.all([sports(), currentSchedules()]);
      const q = sport.trim().toLowerCase();
      const match =
        sp.find((s) => s.name.toLowerCase() === q) ?? sp.find((s) => s.name.toLowerCase().includes(q));
      if (!match)
        return text(
          `Unknown sport "${sport}". Known: ${sp.map((s) => s.name).join(", ")}`,
          true,
        );
      const sched = cur.find((s) => s.sport_id === match.id);
      if (!sched) return text(`No current schedule published for ${match.name}.`);

      let ev = await eventsFor(sched.id);
      if (upcoming_only) {
        const now = Date.now();
        ev = ev.filter((e) => new Date(e.datetime).getTime() >= now);
      }
      ev.sort((a, b) => a.datetime.localeCompare(b.datetime));
      if (!ev.length) return text(`${sched.name} — no events${upcoming_only ? " upcoming" : ""}.`);
      return text(`${sched.name}\n\n${ev.map((e) => fmt(e)).join("\n\n")}`);
    },
  );

  server.registerTool(
    "athletics_upcoming",
    {
      title: "Next Purdue games across all sports",
      description:
        "The next Boilermaker games across every varsity sport, soonest first — what to go watch this week. Source: purduesports.com (official athletics site API).",
      inputSchema: {
        days: z.number().int().min(1).max(120).optional().describe("Window in days. Default 14."),
        home_only: z.boolean().optional().describe("Only home games."),
        limit: z.number().int().min(1).max(60).optional().describe("Default 20."),
      },
    },
    async ({ days, home_only, limit }): Promise<ToolResult> => {
      const [sp, cur] = await Promise.all([sports(), currentSchedules()]);
      const names = new Map(sp.map((s) => [s.id, s.name]));
      const now = Date.now();
      const until = now + (days ?? 14) * 86_400_000;

      const batches = await Promise.allSettled(
        cur.map(async (s) => ({ sport: names.get(s.sport_id) ?? s.name, events: await eventsFor(s.id) })),
      );

      const rows: { e: Event; sport: string }[] = [];
      for (const b of batches) {
        if (b.status !== "fulfilled") continue;
        for (const e of b.value.events) {
          const t = new Date(e.datetime).getTime();
          if (!(t >= now && t <= until)) continue;
          if (home_only && e.venue_type !== "home") continue;
          rows.push({ e, sport: b.value.sport });
        }
      }
      rows.sort((a, b) => a.e.datetime.localeCompare(b.e.datetime));
      if (!rows.length)
        return text(`No Purdue games in the next ${days ?? 14} days${home_only ? " at home" : ""}.`);
      return text(
        `Next ${Math.min(rows.length, limit ?? 20)} Purdue games\n\n` +
          rows
            .slice(0, limit ?? 20)
            .map((r) => fmt(r.e, r.sport))
            .join("\n\n"),
      );
    },
  );
}
