# purdue-mcp

One MCP server for **all public, real-time Purdue University data** — dining menus, the course catalog, campus events, student orgs, buildings, and weather. Point any MCP client (Claude Code, Claude Desktop, Cursor, …) at it and ask "what's for dinner at Wiley" or "who teaches CS 18000 this fall".

Everything it reads is public and unauthenticated. It never touches a student account, grades, schedules, bursar records, or anything behind a Purdue login.

> Unofficial and community-run. Not affiliated with, endorsed by, or operated by Purdue University.

## Install

```bash
npm install -g purdue-mcp
```

Or run straight from the repo:

```bash
git clone https://github.com/sharziki/purdue-mcp && cd purdue-mcp
npm install && npm run build
```

## Connect it

**Claude Code**

```bash
claude mcp add purdue -- npx -y purdue-mcp
```

**Claude Desktop / Cursor** — add to your MCP config:

```json
{
  "mcpServers": {
    "purdue": {
      "command": "npx",
      "args": ["-y", "purdue-mcp"]
    }
  }
}
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
| NOAA / NWS | `api.weather.gov` | Public federal API |

Responses are cached in-process with short TTLs (30s–24h depending on how fast the data moves) to stay a polite client. Nothing is persisted to disk.

## Not yet covered

These are real student needs where a public, stable endpoint has not been confirmed. PRs very welcome:

- **CoRec / RecWell live occupancy** — the facility-usage widget is rendered client-side; the underlying feed has not been pinned down.
- **Laundry machine availability** — LaundryView's API is open, but Purdue's room keys are unknown.
- **CityBus real-time vehicle positions** — no public GTFS-realtime or JSON feed located; only the MyRide app.
- **Parking garage availability**, **library hours and study-room availability**, **athletics schedules**.

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
