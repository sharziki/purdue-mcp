# purdue-mcp

One MCP server for **all public, real-time Purdue University data** — dining menus, live gym occupancy, the course catalog, bus times, campus events, student orgs, library hours, athletics, news, and weather. Point any MCP client (Claude Code, Claude Desktop, Cursor, …) at it and ask "what's for dinner at Wiley", "how busy is the CoRec", or "when's the next bus from the PMU".

**24 tools across 10 public sources.**

Everything it reads is public and unauthenticated. It never touches a student account, grades, schedules, bursar records, or anything behind a Purdue login.

> Unofficial and community-run. Not affiliated with, endorsed by, or operated by Purdue University.

## Install

**Claude Code**

```bash
claude mcp add purdue -s user -- npx -y purdue-mcp@latest
```

**Codex CLI**

```bash
codex mcp add purdue -- npx -y purdue-mcp@latest
```

**Cursor / Claude Desktop / Windsurf** — merge into the client's MCP config:

```json
{
  "mcpServers": {
    "purdue": {
      "command": "npx",
      "args": ["-y", "purdue-mcp@latest"]
    }
  }
}
```

The `@latest` tag re-resolves the newest version on every launch, so it stays
current on its own. Needs Node 20+. No API key, no account, no auth.

Config paths, VS Code, offline/global install, and troubleshooting are in
[install.md](install.md).

### Let an agent install it

Paste this into any coding agent:

> Install the `purdue-mcp` MCP server for me — public real-time Purdue University
> data (dining menus, live gym occupancy, courses, bus times, events, athletics,
> library hours, weather). On npm as `purdue-mcp`, needs Node 20+, no API key.
> Detect my MCP client and register it with `npx -y purdue-mcp@latest` as the
> command, using the `@latest` tag so it stays current. Then verify it connects
> and tell me which tools it exposes.
> Full instructions: https://raw.githubusercontent.com/sharziki/purdue-mcp/main/install.md

### Or run from source

```bash
git clone https://github.com/sharziki/purdue-mcp && cd purdue-mcp
npm install && npm run build
```

## Tools

### Dining — Purdue HFS dining API

| Tool | What it answers |
| --- | --- |
| `dining_locations` | Every dining court / Quick Bites / On-the-GO!, open right now or next meal time |
| `dining_menu` | Full menu for a location and date, by meal and station, with vegan/vegetarian/allergen filters |
| `dining_find_item` | "Who's serving chicken tenders today?" — searches every dining court at once |
| `dining_item_nutrition` | Full nutrition panel for any menu item |
| `dining_line_length` | Crowdsourced live line-length reports (populated around peak meal hours) |

### Academics — Purdue.io course catalog

| Tool | What it answers |
| --- | --- |
| `list_terms` | Term codes and date ranges, newest first |
| `list_subjects` | Every subject code (CS, MA, ENGR, …) |
| `search_courses` | Courses by subject, number, or title keyword — with descriptions and credit hours |
| `course_sections` | CRNs, section types, meeting days/times, rooms, and instructors for a term |
| `find_building` | Resolve a building code, e.g. `LWSN` → Lawson Computer Science Bldg |

### Campus life

| Tool | What it answers |
| --- | --- |
| `search_events` | Official university calendar — lectures, athletics, career fairs, deadlines |
| `search_student_orgs` | ~1,200 registered student organizations on BoilerLink |
| `search_club_events` | Upcoming club events: callouts, socials, meetings |

### Facilities

| Tool | What it answers |
| --- | --- |
| `recwell_occupancy` | Live headcount and % capacity for all 37 counted RecWell spaces — "how busy is the CoRec right now" |
| `library_hours` | Today's hours and open/closed status for every library, or the full week |

### Athletics

| Tool | What it answers |
| --- | --- |
| `athletics_sports` | Every varsity team and its current season schedule |
| `athletics_schedule` | Full season for one team — opponents, rankings, home/away, venue, results |
| `athletics_upcoming` | Next Boilermaker games across all sports, soonest first |

### Getting around

| Tool | What it answers |
| --- | --- |
| `bus_routes` | Every CityBus route serving campus and Greater Lafayette |
| `bus_stops` | Find stops by name, or the stops nearest a lat/lon |
| `bus_next_departures` | Next scheduled departures from a stop, with minutes-until |

### News and deadlines

| Tool | What it answers |
| --- | --- |
| `purdue_news` | Official newsroom articles, searchable |
| `academic_calendar` | First day of classes, breaks, finals week, add/drop deadlines, exam scheduling |

### Environment

| Tool | What it answers |
| --- | --- |
| `campus_weather` | Current conditions, forecast, and active NWS alerts for West Lafayette |

Dates default to **today in the campus timezone** (`America/Indiana/Indianapolis`), so the server gives the right answer no matter where it runs.

## Data sources

| Source | Endpoint | Notes |
| --- | --- | --- |
| Purdue Dining (HFS) | `api.hfs.purdue.edu/menus/v2` | Official, public, unauthenticated |
| Purdue.io | `api.purdue.io/odata` | Community-run open-source catalog mirror ([Purdue-io/PurdueApi](https://github.com/Purdue-io/PurdueApi)) |
| Purdue Events | `events.purdue.edu/api/2` | Localist public API |
| BoilerLink | `purdue.campuslabs.com/engage/api/discovery` | Anthology Engage public discovery API |
| Purdue RecWell | `goboardapi.azurewebsites.net` (Connect2) | Live occupancy counters; account key is the one Purdue's own public widget ships |
| Purdue Libraries | `calendar.lib.purdue.edu` | Springshare LibCal public hours endpoints |
| Purdue Athletics | `purduesports.com/website-api` | Official athletics site's public JSON API |
| Purdue Newsroom / Registrar | `purdue.edu/{newsroom,registrar}/wp-json` | WordPress REST API |
| CityBus | `bus.gocitybus.com` GTFS | Static schedule feed; **no public real-time feed exists** |
| NOAA / NWS | `api.weather.gov` | Public federal API |

Responses are cached in-process with short TTLs (30s–24h depending on how fast the data moves) to stay a polite client. Nothing is persisted to disk.

## Ruled out (investigated, no public source)

- **Laundry machine availability** — Purdue moved residence-hall laundry to CSCPay Mobile, which has no public web status page. The old `washalertweb` host the community app scraped no longer resolves.
- **Real-time bus positions** — CityBus publishes GTFS static only. No GTFS-Realtime feed is listed on Transitland or the Mobility Database, and MyRide's backend is not public. `bus_next_departures` returns timetable times.
- **Parking garage availability** — Purdue Parking publishes no live space counts.
- **Seat availability / waitlists** — lives behind the myPurdue login. Out of scope by design.

## Adding a source

Each source is one file in `src/sources/` exporting a `registerX(server)` that calls `server.registerTool(...)`. Register it in `src/index.ts`. Use `getJSON()` from `src/lib/http.ts` so you inherit the timeout, User-Agent, and cache.

Rules of the road:

1. **Public data only.** Nothing that needs a Purdue login, and nothing about a specific individual.
2. **Verify the endpoint is live** before shipping it — `npm run smoke` hits every real upstream and is the test suite.
3. **Be a polite client.** Sensible cache TTL, no tight polling.

```bash
npm run build
npm run smoke   # live end-to-end check of all tools
```

## License

MIT
