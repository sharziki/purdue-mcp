import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAMPUS_TZ, campusNowLabel, campusToday, prettyTime } from "../lib/time.js";
import { parseCsv, unzip } from "../lib/zip.js";
import { text, type ToolResult } from "../lib/result.js";

// CityBus (Greater Lafayette) serves the Purdue campus. They publish GTFS static
// only — there is no public GTFS-Realtime feed, so these are scheduled times.
const FEED = "https://bus.gocitybus.com/GTFSRT/citybus-lafayette-in-us.zip";

type Feed = {
  loadedAt: number;
  stops: Record<string, string>[];
  routes: Record<string, string>[];
  trips: Record<string, string>[];
  stopTimes: Record<string, string>[];
  calendar: Record<string, string>[];
  calendarDates: Record<string, string>[];
  info: Record<string, string>[];
};

let cached: Feed | null = null;
let loading: Promise<Feed> | null = null;

async function feed(): Promise<Feed> {
  if (cached && Date.now() - cached.loadedAt < 12 * 60 * 60_000) return cached;
  if (loading) return loading;
  loading = (async () => {
    const res = await fetch(FEED, {
      headers: { "User-Agent": "purdue-mcp/0.2 (+https://github.com/sharziki/purdue-mcp)" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`CityBus GTFS feed returned ${res.status}`);
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    const get = (n: string) => parseCsv(files.get(n)?.toString("utf8") ?? "");
    cached = {
      loadedAt: Date.now(),
      stops: get("stops.txt"),
      routes: get("routes.txt"),
      trips: get("trips.txt"),
      stopTimes: get("stop_times.txt"),
      calendar: get("calendar.txt"),
      calendarDates: get("calendar_dates.txt"),
      info: get("feed_info.txt"),
    };
    loading = null;
    return cached;
  })();
  return loading;
}

/** GTFS service_ids running on a YYYY-MM-DD, honoring calendar_dates exceptions. */
function servicesOn(f: Feed, date: string): Set<string> {
  const ymd = date.replace(/-/g, "");
  const dow = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][new Date(`${date}T12:00:00Z`).getUTCDay()];

  const active = new Set<string>();
  for (const c of f.calendar) {
    if (c.start_date <= ymd && ymd <= c.end_date && c[dow] === "1") active.add(c.service_id);
  }
  for (const e of f.calendarDates) {
    if (e.date !== ymd) continue;
    if (e.exception_type === "1") active.add(e.service_id);
    if (e.exception_type === "2") active.delete(e.service_id);
  }
  return active;
}

/** Seconds since midnight on campus right now. GTFS times can exceed 24h. */
function nowSeconds(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return g("hour") * 3600 + g("minute") * 60 + g("second");
}

const toSeconds = (hms: string) => {
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

export function registerTransit(server: McpServer) {
  server.registerTool(
    "bus_routes",
    {
      title: "List CityBus routes",
      description:
        "Every CityBus route serving Purdue and Greater Lafayette. Source: CityBus GTFS feed (scheduled service; CityBus publishes no public real-time feed).",
      inputSchema: { query: z.string().optional().describe("Filter by route number or name.") },
    },
    async ({ query }): Promise<ToolResult> => {
      const f = await feed();
      let rs = f.routes;
      if (query) {
        const q = query.toLowerCase();
        rs = rs.filter(
          (r) =>
            r.route_short_name?.toLowerCase().includes(q) ||
            r.route_long_name?.toLowerCase().includes(q),
        );
      }
      if (!rs.length) return text(`No CityBus route matches "${query}".`);
      rs.sort((a, b) => a.route_short_name.localeCompare(b.route_short_name, undefined, { numeric: true }));
      const v = f.info[0];
      return text(
        `CityBus routes${v ? ` (feed ${v.feed_version}, valid ${v.feed_start_date}–${v.feed_end_date})` : ""}\n\n` +
          rs.map((r) => `${r.route_short_name} — ${r.route_long_name}`).join("\n"),
      );
    },
  );

  server.registerTool(
    "bus_stops",
    {
      title: "Find CityBus stops",
      description:
        "Search CityBus stops by name, or find the stops nearest a latitude/longitude on campus. Source: CityBus GTFS feed.",
      inputSchema: {
        query: z.string().optional().describe("Stop name keyword, e.g. 'Purdue Memorial Union', 'State St'."),
        lat: z.number().optional().describe("Latitude, to find nearby stops instead."),
        lon: z.number().optional().describe("Longitude."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 15."),
      },
    },
    async ({ query, lat, lon, limit }): Promise<ToolResult> => {
      const f = await feed();
      const cap = limit ?? 15;

      if (lat !== undefined && lon !== undefined) {
        const near = f.stops
          .map((s) => {
            const dLat = (Number(s.stop_lat) - lat) * 69;
            const dLon = (Number(s.stop_lon) - lon) * 53;
            return { s, mi: Math.sqrt(dLat * dLat + dLon * dLon) };
          })
          .sort((a, b) => a.mi - b.mi)
          .slice(0, cap);
        return text(
          `Stops nearest ${lat}, ${lon}\n\n` +
            near
              .map(({ s, mi }) => `${s.stop_name} (id ${s.stop_id}) — ${mi.toFixed(2)} mi`)
              .join("\n"),
        );
      }

      if (!query) return text("Give either a query, or both lat and lon.", true);
      const q = query.toLowerCase();
      const hits = f.stops.filter((s) => s.stop_name.toLowerCase().includes(q)).slice(0, cap);
      if (!hits.length) return text(`No CityBus stop matches "${query}".`);
      return text(
        hits.map((s) => `${s.stop_name} (id ${s.stop_id}) — ${s.stop_lat}, ${s.stop_lon}`).join("\n"),
      );
    },
  );

  server.registerTool(
    "bus_next_departures",
    {
      title: "Next scheduled buses from a stop",
      description:
        "Next scheduled CityBus departures from a stop today, by route and headsign. These are timetable times — CityBus publishes no public real-time feed, so buses may run early or late. Source: CityBus GTFS feed.",
      inputSchema: {
        stop: z.string().describe("Stop id, or part of a stop name, e.g. 'Purdue Memorial Union'."),
        date: z.string().optional().describe("YYYY-MM-DD. Defaults to today on campus."),
        limit: z.number().int().min(1).max(30).optional().describe("Default 10."),
      },
    },
    async ({ stop, date, limit }): Promise<ToolResult> => {
      const f = await feed();
      const day = date ?? campusToday();

      const byId = f.stops.find((s) => s.stop_id === stop);
      const matches = byId
        ? [byId]
        : f.stops.filter((s) => s.stop_name.toLowerCase().includes(stop.toLowerCase()));
      if (!matches.length) return text(`No CityBus stop matches "${stop}".`);
      if (matches.length > 8)
        return text(
          `"${stop}" matches ${matches.length} stops — narrow it down:\n` +
            matches.slice(0, 20).map((s) => `  ${s.stop_name} (id ${s.stop_id})`).join("\n"),
        );

      const ids = new Set(matches.map((s) => s.stop_id));
      const active = servicesOn(f, day);
      const tripInfo = new Map(
        f.trips
          .filter((t) => active.has(t.service_id))
          .map((t) => [t.trip_id, t] as const),
      );
      const routeName = new Map(f.routes.map((r) => [r.route_id, r.route_short_name] as const));
      const after = date && date !== campusToday() ? 0 : nowSeconds();

      const rows = f.stopTimes
        .filter((st) => ids.has(st.stop_id) && tripInfo.has(st.trip_id))
        .map((st) => ({ st, secs: toSeconds(st.departure_time), trip: tripInfo.get(st.trip_id)! }))
        .filter((r) => r.secs >= after)
        .sort((a, b) => a.secs - b.secs)
        .slice(0, limit ?? 10);

      if (!rows.length)
        return text(
          `No further scheduled departures from ${matches[0].stop_name} on ${day}${
            active.size ? "" : " (no CityBus service is scheduled for that date in the current feed)"
          }.`,
        );

      const header = `${matches.map((s) => s.stop_name).join(" / ")} — ${day} (${campusNowLabel()})`;
      return text(
        `${header}\n\n` +
          rows
            .map((r) => {
              const mins = Math.round((r.secs - after) / 60);
              const route = routeName.get(r.trip.route_id) ?? r.trip.route_id;
              const head = r.st.stop_headsign || r.trip.trip_headsign || "";
              return `${prettyTime(r.st.departure_time.slice(0, 8))}  Route ${route}${head ? ` ${head}` : ""}${
                after ? ` (in ${mins} min)` : ""
              }`;
            })
            .join("\n") +
          `\n\nScheduled times only — CityBus does not publish a public real-time feed.`,
      );
    },
  );
}
