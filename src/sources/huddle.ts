import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON } from "../lib/http.js";
import { campusIso, campusToday, prettyStamp, shiftDate, stampRange } from "../lib/time.js";
import { buildIndex, searchIndex } from "../lib/textsearch.js";
import { text, type ToolResult } from "../lib/result.js";

// Huddle (gethuddle.social) is the student-run events app — flyers posted by
// clubs themselves, so it catches callouts, free-food nights and tryouts that
// never make it onto the university calendar or BoilerLink.
//
// The site sits behind Vercel's bot challenge: an ordinary fetch of
// /api/firestore/events gets 429 with `x-vercel-mitigated: challenge` from any
// client, any IP, any headers. So the corpus is mirrored by
// scripts/huddle-mirror.mjs — a headless browser that pulls it twice an hour —
// and this tool reads that static JSON. Point PURDUE_MCP_HUDDLE_MIRROR at your
// own copy to self-host it.
const SITE = "https://www.gethuddle.social";
const EVENTS_PAGE = `${SITE}/events/purdue`;
const MIRROR =
  process.env.PURDUE_MCP_HUDDLE_MIRROR ||
  "https://raw.githubusercontent.com/sharziki/purdue-mcp/data/huddle-purdue.json";

const TTL = 10 * 60_000;

/** How old the mirror gets before results carry a warning. */
const STALE_MS = 6 * 60 * 60_000;

type HuddleEvent = {
  id: string;
  title: string;
  org?: string;
  start: string;
  end?: string;
  location?: string;
  address?: string;
  description?: string;
  tags?: string[];
  flyer?: string;
  link?: string;
  linkName?: string;
  rsvp?: boolean;
  rsvpCount?: number;
  likes?: number;
  views?: number;
  lat?: number;
  lng?: number;
};

type Mirror = {
  source: string;
  college: string;
  fetchedAt: string;
  count: number;
  events: HuddleEvent[];
};

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

let at = 0;
let pending: Promise<Mirror> | null = null;

function corpus(): Promise<Mirror> {
  if (!pending || Date.now() - at > TTL) {
    at = Date.now();
    pending = getJSON<Mirror>(MIRROR, { ttlMs: TTL, timeoutMs: 30_000 })
      .then((mirror) => ({
        ...mirror,
        events: (mirror.events ?? []).filter((e) => e?.id && e?.title && e?.start),
      }))
      .catch((e) => {
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

/** A campus-midnight start is Huddle's "I didn't pick a time", not 12 AM. */
function when(e: HuddleEvent): string {
  const stamp = stampRange(e.start, e.end);
  return e.end || !/, 12:00 AM$/.test(stamp)
    ? stamp
    : `${stamp.replace(/, 12:00 AM$/, "")} (time TBA)`;
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

function freshness(mirror: Mirror): string {
  const age = Date.now() - new Date(mirror.fetchedAt).getTime();
  if (!Number.isFinite(age)) return "";
  const hours = age / 3_600_000;
  const label =
    hours < 1 ? `${Math.max(1, Math.round(age / 60_000))} min ago` : `${hours.toFixed(1)}h ago`;
  return age > STALE_MS
    ? `\n\nMirror last refreshed ${label} — Huddle may have newer flyers. ${EVENTS_PAGE}`
    : `\n\nSource: Huddle (${EVENTS_PAGE}), mirrored ${label}.`;
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
          .describe("Search past events instead of upcoming ones. Default false."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, tag, org, days, start, past, limit }): Promise<ToolResult> => {
      const n = limit ?? 20;
      const mirror = await corpus();

      const from = start ?? campusToday();
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

      if (org) {
        const want = org.trim().toLowerCase();
        const matches = pool.filter((e) => (e.org ?? "").toLowerCase().includes(want));
        if (!matches.length) {
          const near = [...new Set(mirror.events.map((e) => e.org).filter(Boolean))]
            .filter((o) => o!.toLowerCase().includes(want))
            .slice(0, 5);
          return text(
            `No Huddle events from an org matching "${org}" in that window.` +
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
        org && `org ${org}`,
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
            freshness(mirror),
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

      return text(`${head}:\n\n${ordered.map(format).join("\n\n")}${freshness(mirror)}`);
    },
  );
}
