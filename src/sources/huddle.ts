import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON } from "../lib/http.js";
import {
  DEFAULT_CACHE,
  EVENTS_PAGE,
  PUBLIC_MIRROR,
  type HuddleEvent,
  type Mirror,
} from "../lib/huddle.js";
import {
  CAMPUS_TZ,
  campusIso,
  campusToday,
  parseCampusDate,
  prettyStamp,
  shiftDate,
  stampRange,
} from "../lib/time.js";
import { buildIndex, searchIndex } from "../lib/textsearch.js";
import { text, type ToolResult } from "../lib/result.js";

// Huddle (gethuddle.social) is the student-run events app — flyers posted by
// clubs themselves, so it catches callouts, free-food nights and tryouts that
// never make it onto the university calendar or BoilerLink.
//
// The site sits behind Vercel's bot challenge: an ordinary fetch of
// /api/firestore/events gets 429 with `x-vercel-mitigated: challenge` whatever
// the headers, and the challenge refuses datacenter IPs outright — so nobody
// can host this centrally and stay fresh. Instead `purdue-mcp-huddle` pulls the
// corpus through the browser on YOUR machine, on YOUR connection, and this tool
// reads whatever it wrote. A stale shared copy is the fallback for anyone who
// has not run it.
const TTL = 10 * 60_000;

/** How old the mirror gets before results carry a warning. */
const STALE_MS = 6 * 60 * 60_000;

/**
 * The tags the app puts in front of people posting a flyer. A handful of older
 * one-off tags (Music, Health, Politics…) also survive in the archive, so the
 * filter matches against whatever the mirror actually contains and only falls
 * back to this list for the error message.
 */
const TAGS = [
  "Clubs",
  "Education",
  "Free Food",
  "Culture",
  "Games",
  "Free Entry",
  "Project",
  "Sports",
  "Party",
] as const;

const fields = (e: HuddleEvent): [string | null | undefined, number][] => [
  [e.title, 8],
  [e.org, 5],
  [(e.tags ?? []).join(" "), 3],
  [[e.location, e.address].filter(Boolean).join(" "), 2],
  [e.description, 1],
];

/**
 * Windows are compared as strings, which is only safe if every stamp is in the
 * same shape — "…22:00:00+00:00" and "…22:00:00.000Z" are the same instant and
 * sort differently. Canonicalising here means a change in Huddle's date format
 * can't quietly move events out of the window a student asked about.
 */
function normalize(e: HuddleEvent): HuddleEvent | null {
  const start = new Date(e.start);
  if (Number.isNaN(start.getTime())) return null;
  const end = e.end ? new Date(e.end) : null;
  return {
    ...e,
    start: start.toISOString(),
    ...(end && !Number.isNaN(end.getTime()) ? { end: end.toISOString() } : { end: undefined }),
  };
}

type Loaded = { mirror: Mirror; source: "local" | "shared" };

let at = 0;
let pending: Promise<Loaded> | null = null;

const clean = (m: Mirror): Mirror => ({
  ...m,
  events: (m.events ?? [])
    .filter((e) => e?.id && e?.title && e?.start)
    .map(normalize)
    .filter((e): e is HuddleEvent => e !== null),
});

/**
 * Whatever the person running this server refreshed themselves, then the
 * shared copy. PURDUE_MCP_HUDDLE_MIRROR overrides both and takes a path or a
 * URL, so a household or a club can point every install at one file.
 */
async function load(): Promise<Loaded> {
  const override = process.env.PURDUE_MCP_HUDDLE_MIRROR;
  if (override) {
    const mirror = /^https?:\/\//.test(override)
      ? await getJSON<Mirror>(override, { ttlMs: TTL, timeoutMs: 30_000 })
      : (JSON.parse(await readFile(override, "utf8")) as Mirror);
    return { mirror: clean(mirror), source: "local" };
  }

  try {
    const mirror = JSON.parse(await readFile(DEFAULT_CACHE, "utf8")) as Mirror;
    return { mirror: clean(mirror), source: "local" };
  } catch {
    // Nobody has run purdue-mcp-huddle here yet.
  }

  const mirror = await getJSON<Mirror>(PUBLIC_MIRROR, { ttlMs: TTL, timeoutMs: 30_000 });
  return { mirror: clean(mirror), source: "shared" };
}

function corpus(): Promise<Loaded> {
  if (!pending || Date.now() - at > TTL) {
    at = Date.now();
    pending = load().catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}

/**
 * Built per call over whatever survived the filters, never over the whole
 * archive: BM25 scores are relative to the collection, and 2,600 short flyers
 * index in a few milliseconds.
 */
const indexOf = (docs: HuddleEvent[]) =>
  buildIndex(docs.map((e) => ({ value: e, fields: fields(e) })));

function matchTag(input: string, events: HuddleEvent[]): string | null {
  const want = input.trim().toLowerCase();
  const live = [...new Set(events.flatMap((e) => e.tags ?? []))];
  const known = [...new Set([...TAGS, ...live])];
  return (
    known.find((t) => t.toLowerCase() === want) ??
    known.find((t) => t.toLowerCase().includes(want)) ??
    null
  );
}

const campusYear = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: CAMPUS_TZ, year: "numeric" }).format(d);

/**
 * Two things the shared stamp gets wrong for this corpus: it omits the year,
 * which is ambiguous the moment an archive search leaves the current one, and
 * a campus-midnight start is Huddle's "I didn't pick a time", not 12 AM.
 */
function when(e: HuddleEvent): string {
  const year = campusYear(new Date(e.start));
  const stamp = stampRange(e.start, e.end);
  const dated =
    year === campusYear(new Date())
      ? stamp
      : stamp.replace(/^(\w{3}, \w{3} \d{1,2})/, `$1, ${year}`);
  return e.end || !/, 12:00 AM$/.test(dated)
    ? dated
    : `${dated.replace(/, 12:00 AM$/, "")} (time TBA)`;
}

function format(e: HuddleEvent): string {
  const where = e.location?.trim() || e.address?.trim() || "location TBA";
  const extras = [
    e.rsvp ? "RSVP required" : "",
    e.rsvpCount ? `${e.rsvpCount} RSVP` : "",
  ].filter(Boolean);
  const desc = (e.description ?? "").replace(/\s+/g, " ").trim();
  return [
    `${e.title.trim()}${e.org ? ` — ${e.org.trim()}` : ""}`,
    `  ${when(e)} · ${where}${extras.length ? ` · ${extras.join(" · ")}` : ""}`,
    e.tags?.length ? `  ${e.tags.join(" · ")}` : "",
    desc ? `  ${desc.length > 240 ? `${desc.slice(0, 240)}…` : desc}` : "",
    e.link ? `  ${e.linkName ? `${e.linkName}: ` : ""}${e.link}` : "",
    e.flyer ? `  flyer: ${e.flyer}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const REFRESH = "Run `npx purdue-mcp-huddle` to pull a current copy through this machine's browser.";

function freshness({ mirror, source }: Loaded): string {
  const age = Date.now() - new Date(mirror.fetchedAt).getTime();
  const shared = source === "shared" ? " shared copy" : "";
  if (!Number.isFinite(age)) return "";
  if (age < 0) return `\n\nSource: Huddle${shared} (${EVENTS_PAGE}), pulled ${mirror.fetchedAt}.`;
  const hours = age / 3_600_000;
  const label =
    hours < 1 ? `${Math.max(1, Math.round(age / 60_000))} min ago` : `${hours.toFixed(1)}h ago`;
  if (age <= STALE_MS) return `\n\nSource: Huddle${shared} (${EVENTS_PAGE}), pulled ${label}.`;
  return (
    `\n\nThis${shared || " copy"} was pulled ${label} — Huddle may have newer flyers.\n${REFRESH}`
  );
}

export function registerHuddle(server: McpServer) {
  server.registerTool(
    "huddle_events",
    {
      title: "Search student-posted Purdue events (Huddle)",
      description:
        "Student-run event board where Purdue clubs post their own flyers — callouts, free-food nights, tryouts, socials, info sessions — much of which never reaches the official calendar or BoilerLink. Searches titles, hosting orgs, tags, locations and descriptions with typo tolerance, so 'free food tonight', 'bodybuilding callout' or 'dance tryouts' all work. Filter by tag for the classics: " +
        TAGS.join(", ") +
        ". Defaults to the next 14 days; set past=true to search the archive (~2,600 events back to 2023). Source: gethuddle.social, mirrored twice an hour.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Keywords, e.g. 'free food', 'robotics callout'. Omit to browse by date."),
        tag: z.string().optional().describe(`One of: ${TAGS.join(", ")}.`),
        org: z.string().optional().describe("Hosting club name, e.g. 'Purdue Pickleball Club'."),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Window in days from the start date. Default 14."),
        start: z.string().optional().describe("YYYY-MM-DD start of window. Defaults to today."),
        past: z
          .boolean()
          .optional()
          .describe(
            "Search the whole archive, newest first, instead of upcoming events. " +
              "`days` is ignored; `start` becomes the cutoff. Default false.",
          ),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, tag, org, days, start, past, limit }): Promise<ToolResult> => {
      const n = limit ?? 20;
      const loaded = await corpus();
      const mirror = loaded.mirror;

      const from = start ? parseCampusDate(start) : campusToday();
      if (!from)
        return text(
          `"${start}" is not a date I can read. Use YYYY-MM-DD, e.g. ${campusToday()}.`,
        );
      const window = days ?? 14;
      const lo = campusIso(from);
      const hi = campusIso(shiftDate(from, window));

      // The date window is itself a filter, so every query searches an index
      // built over the survivors — BM25 scores are relative to the collection,
      // and a hit from last February is not an answer to "what's on this week".
      let pool = past
        ? mirror.events.filter((e) => e.start < lo).reverse()
        : mirror.events.filter((e) => e.start >= lo && e.start < hi);

      let tagLabel = "";
      if (tag) {
        const name = matchTag(tag, mirror.events);
        if (!name) return text(`No Huddle tag matches "${tag}". Tags are: ${TAGS.join(", ")}.`);
        tagLabel = name;
        pool = pool.filter((e) => e.tags?.includes(name));
      }

      const wantOrg = org?.trim() ?? "";
      if (wantOrg) {
        const want = wantOrg.toLowerCase();
        const matches = pool.filter((e) => (e.org ?? "").toLowerCase().includes(want));
        if (!matches.length) {
          const near = [...new Set(mirror.events.map((e) => e.org).filter(Boolean))]
            .filter((o) => o!.toLowerCase().includes(want))
            .slice(0, 5);
          return text(
            `No Huddle events from an org matching "${wantOrg}" in that window.` +
              (near.length ? ` Orgs with that name have posted before: ${near.join(", ")}.` : ""),
          );
        }
        pool = matches;
      }

      const results = query
        ? searchIndex(indexOf(pool), query, n).map((r) => r.value)
        : pool.slice(0, n);

      const what = [
        query && `"${query}"`,
        tagLabel && `tag ${tagLabel}`,
        wantOrg && `org ${wantOrg}`,
      ]
        .filter(Boolean)
        .join(" + ");

      if (!results.length) {
        const span = past
          ? `before ${prettyStamp(lo).replace(/, \d.*$/, "")}`
          : `${from} + ${window} days`;
        return text(
          `No Huddle events match ${what || "that search"} in ${span}.` +
            (past ? "" : " Try a longer window, or past=true for the archive.") +
            freshness(loaded),
        );
      }

      // A keyword search reads better in date order than in score order once
      // the top hits are already chosen.
      const ordered = query
        ? [...results].sort((a, b) => (past ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start)))
        : results;

      const head = past
        ? `${ordered.length} past Huddle event${ordered.length === 1 ? "" : "s"}${what ? ` for ${what}` : ""}`
        : `${ordered.length} Huddle event${ordered.length === 1 ? "" : "s"}${what ? ` for ${what}` : ""} in the next ${window} day${window === 1 ? "" : "s"}`;

      return text(`${head}:\n\n${ordered.map(format).join("\n\n")}${freshness(loaded)}`);
    },
  );
}
