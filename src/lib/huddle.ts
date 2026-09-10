import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared between the `huddle_events` tool and the `purdue-mcp-huddle` refresher:
 * where the corpus lives, and the one shape both agree on.
 */

export const SITE = "https://www.gethuddle.social";
export const EVENTS_PAGE = `${SITE}/events/purdue`;
export const eventsApi = (college: string) =>
  `/api/firestore/events?college=${encodeURIComponent(college)}`;

/** Where the refresher writes and the tool looks first. */
export const DEFAULT_CACHE = join(homedir(), ".cache", "purdue-mcp", "huddle-purdue.json");

/** Last resort when nobody has run the refresher: a copy refreshed by hand. */
export const PUBLIC_MIRROR =
  "https://raw.githubusercontent.com/sharziki/purdue-mcp/data/huddle-purdue.json";

export type HuddleEvent = {
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

export type Mirror = {
  source: string;
  college: string;
  fetchedAt: string;
  count: number;
  events: HuddleEvent[];
};

/** Firestore's own JSON, as the API returns it. */
export type RawEvent = Record<string, any>;

/** eventEndDate arrives as a raw Firestore timestamp on about 1% of rows. */
function iso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "object" && typeof (v as any).seconds === "number") {
    return new Date((v as any).seconds * 1000).toISOString();
  }
  return null;
}

/** Keep only what the tool renders — the raw corpus is 40% dead weight. */
function trim(e: RawEvent): HuddleEvent | null {
  const start = iso(e.eventDate);
  const id = e.eventID || e.id;
  const title = String(e.eventTitle ?? "").trim();
  if (!id || !title || !start) return null;

  const out: HuddleEvent = {
    id,
    title,
    start,
    org: String(e.orgHosting ?? "").trim(),
    end: iso(e.eventEndDate) ?? undefined,
    location: String(e.eventLocation ?? "").trim(),
    address: String(e.eventAddress ?? "").trim(),
    description: String(e.eventDescription ?? "").trim(),
    tags: Array.isArray(e.tags) ? e.tags.filter(Boolean) : [],
    flyer: e.flyer_image || "",
    link: e.notable_link_url || "",
    linkName: e.notable_link_name || "",
    rsvp: !!e.rsvpRequired,
    rsvpCount: e.rsvpCount ?? (Array.isArray(e.rsvpList) ? e.rsvpList.length : 0),
    likes: e.likeCount ?? 0,
    views: e.viewCount ?? 0,
  };
  // 0/0 is Firestore's "nobody set a place", not the Gulf of Guinea.
  if (e.latitude && e.longitude) {
    out.lat = e.latitude;
    out.lng = e.longitude;
  }
  for (const k of Object.keys(out) as (keyof HuddleEvent)[]) {
    const v = out[k];
    if (v === "" || v === null || v === undefined || v === 0 || v === false) delete out[k];
    else if (Array.isArray(v) && !v.length) delete out[k];
  }
  return out;
}

export function toMirror(raw: RawEvent[], college: string): Mirror {
  const events = raw
    .map(trim)
    .filter((e): e is HuddleEvent => e !== null)
    .sort((a, b) => a.start.localeCompare(b.start));
  return {
    source: EVENTS_PAGE,
    college,
    fetchedAt: new Date().toISOString(),
    count: events.length,
    events,
  };
}
