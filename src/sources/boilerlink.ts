import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs, stripHtml } from "../lib/http.js";
import {
  campusIso,
  campusToday,
  parseCampusDate,
  prettyDate,
  shiftDate,
  stampRange,
} from "../lib/time.js";
import { buildIndex, searchIndex, type TextIndex } from "../lib/textsearch.js";
import { text, type ToolResult } from "../lib/result.js";

// BoilerLink is Purdue's Anthology Engage instance. boilerlink.purdue.edu is
// the vanity host students see and serves the same public discovery API as
// purdue.campuslabs.com/engage - no auth, no session cookie.
const SITE = "https://boilerlink.purdue.edu";
const API = `${SITE}/api/discovery`;

const ORG_TTL = 6 * 60 * 60_000;
const EVENT_TTL = 10 * 60_000;
const DETAIL_TTL = 60 * 60_000;

type OrgHit = {
  Id: string;
  Name: string;
  ShortName: string | null;
  WebsiteKey: string;
  Summary?: string | null;
  Description?: string | null;
  CategoryIds?: string[];
  CategoryNames?: string[];
  Status?: string;
};

type OrgSearch = { "@odata.count": number; value: OrgHit[] };

type EventHit = {
  id: string;
  organizationId: number;
  organizationName: string;
  name: string;
  description: string | null;
  location: string | null;
  startsOn: string;
  endsOn: string;
  theme: string | null;
  categoryNames?: string[];
  benefitNames?: string[];
  rsvpTotal?: number;
};

type EventSearch = { "@odata.count": number; value: EventHit[] };

type OrgDetail = {
  id: number;
  name: string;
  shortName: string | null;
  websiteKey: string;
  email: string | null;
  description: string | null;
  summary: string | null;
  status: string;
  showJoin: boolean;
  startDate: string | null;
  socialMedia: Record<string, string | null> | null;
  organizationType?: { name: string } | null;
  contactInfo?: { phoneNumber: string | null }[];
};

type Category = { id: number; name: string };
type CategoryPage = { totalItems: number; items: Category[] };

const orgUrl = (key: string) => `${SITE}/organization/${key}`;
const eventUrl = (id: string | number) => `${SITE}/event/${id}`;

/** Event themes are a fixed Engage enum; the facet only ever returns these. */
const THEMES = [
  "Arts",
  "Athletics",
  "CommunityService",
  "Cultural",
  "Fundraising",
  "GroupBusiness",
  "Social",
  "Spirituality",
  "ThoughtfulLearning",
] as const;

// ---------------------------------------------------------------------------
// Local corpora
//
// BoilerLink's own search is plain keyword OR: "robotcs" returns nothing and
// "rock climbing" ranks Rock Band next to the climbing clubs. Both corpora are
// small enough to hold locally (1,206 orgs in 13 requests, ~1,500 upcoming
// events in 4), so every keyword query is answered from a local BM25 index
// instead. The upstream is still the only source of the data.
// ---------------------------------------------------------------------------

type Corpus<T> = { docs: T[]; index: TextIndex<T> };

function memo<T>(ttlMs: number, load: () => Promise<Corpus<T>>) {
  let at = 0;
  let pending: Promise<Corpus<T>> | null = null;
  return () => {
    if (!pending || Date.now() - at > ttlMs) {
      at = Date.now();
      pending = load().catch((e) => {
        pending = null;
        throw e;
      });
    }
    return pending;
  };
}

async function crawl<T>(
  url: (skip: number, page: number) => string,
  pick: (body: any) => { total: number; rows: T[] },
  pageSize: number,
  maxPages: number,
  ttlMs: number,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await getJSON<any>(url(page * pageSize, page), { ttlMs, timeoutMs: 30_000 });
    const { total, rows: batch } = pick(body);
    rows.push(...batch);
    if (!batch.length || rows.length >= total) break;
  }
  return rows;
}

const orgFields = (o: OrgHit): [string | null | undefined, number][] => [
  [o.Name, 8],
  [o.ShortName, 6],
  [(o.CategoryNames ?? []).join(" "), 4],
  [o.Summary, 2],
  [stripHtml(o.Description, 4000), 1],
];

const eventFields = (e: EventHit): [string | null | undefined, number][] => [
  [e.name, 8],
  [e.organizationName, 5],
  [[e.theme, ...(e.categoryNames ?? []), ...(e.benefitNames ?? [])].join(" "), 3],
  [e.location, 2],
  [stripHtml(e.description, 4000), 1],
];

const orgIndex = (docs: OrgHit[]) =>
  buildIndex(docs.map((o) => ({ value: o, fields: orgFields(o) })));

const eventIndex = (docs: EventHit[]) =>
  buildIndex(docs.map((e) => ({ value: e, fields: eventFields(e) })));

const orgCorpus = memo<OrgHit>(ORG_TTL, async () => {
  const docs = await crawl<OrgHit>(
    (skip) =>
      `${API}/search/organizations${qs({ top: 100, skip, "orderBy[0]": "UpperName asc" })}`,
    (b: OrgSearch) => ({ total: b["@odata.count"], rows: b.value ?? [] }),
    100,
    20,
    ORG_TTL,
  );
  return { docs, index: orgIndex(docs) };
});

const eventCorpus = memo<EventHit>(EVENT_TTL, async () => {
  const from = new Date().toISOString();
  const docs = await crawl<EventHit>(
    (skip) =>
      `${API}/event/search${qs({
        take: 500,
        skip,
        endsAfter: from,
        status: "Approved",
        orderByField: "startsOn",
        orderByDirection: "ascending",
      })}`,
    (b: EventSearch) => ({ total: b["@odata.count"], rows: b.value ?? [] }),
    500,
    10,
    EVENT_TTL,
  );
  return { docs, index: eventIndex(docs) };
});

// ---------------------------------------------------------------------------

const categories = (path: string) =>
  getJSON<CategoryPage>(`${API}/${path}?take=100`, { ttlMs: 12 * 60 * 60_000 });

/** Match a user-typed category name against the live list. */
async function matchCategory(path: string, name: string): Promise<string | null> {
  const { items } = await categories(path);
  const want = name.trim().toLowerCase();
  const hit =
    items.find((c) => c.name.trim().toLowerCase() === want) ??
    items.find((c) => c.name.toLowerCase().includes(want));
  return hit?.name.trim() ?? null;
}

/** Resolve "cs club", "boilerblockchain", or a BoilerLink URL to one org. */
async function findOrg(input: string): Promise<OrgHit | null> {
  const raw = input.trim();
  const key = raw.replace(/^.*\/organization\//, "").replace(/[/?#].*$/, "");

  // The search index does not tokenize WebsiteKey, so a key only ever resolves
  // through the by-key endpoint. A miss there is a 404, not an empty result.
  if (/^[A-Za-z0-9._-]+$/.test(key)) {
    try {
      const d = await getJSON<OrgDetail>(`${API}/organization/bykey/${encodeURIComponent(key)}`, {
        ttlMs: DETAIL_TTL,
      });
      const { docs } = await orgCorpus();
      return (
        docs.find((o) => o.WebsiteKey === d.websiteKey) ?? {
          Id: String(d.id),
          Name: d.name,
          ShortName: d.shortName,
          WebsiteKey: d.websiteKey,
        }
      );
    } catch {
      // Not a website key - fall through to a name search.
    }
  }

  const { docs, index } = await orgCorpus();
  const want = raw.toLowerCase();
  const exact =
    docs.find((o) => o.Name.trim().toLowerCase() === want) ??
    docs.find((o) => o.ShortName?.trim().toLowerCase() === want);
  return exact ?? searchIndex(index, raw, 1)[0]?.value ?? null;
}

/** Website and socials live only on the detail endpoint, never in the index. */
function links(d: OrgDetail): string[] {
  const out = Object.entries(d.socialMedia ?? {})
    .filter(([k, v]) => v && k !== "TwitterUserName" && !/^Google(Plus|Calendar)/.test(k))
    .map(([k, v]) => `${k.replace(/Url$/, "").replace("ExternalWebsite", "Website")}: ${v}`);
  if (d.socialMedia?.TwitterUserName) out.push(`Twitter: @${d.socialMedia.TwitterUserName}`);
  if (d.email) out.unshift(`Email: ${d.email}`);
  const phone = d.contactInfo?.find((c) => c.phoneNumber)?.phoneNumber;
  if (phone) out.push(`Phone: ${phone}`);
  return out;
}

const detail = (key: string) =>
  getJSON<OrgDetail>(`${API}/organization/bykey/${encodeURIComponent(key)}`, { ttlMs: DETAIL_TTL });

function formatOrg(o: OrgHit, contact?: string[]): string {
  const cats = o.CategoryNames?.length
    ? `\n  categories: ${o.CategoryNames.map((c) => c.trim()).join(", ")}`
    : "";
  const blurb = stripHtml(o.Summary || o.Description, 240);
  const name = `${o.Name.trim()}${o.ShortName && o.ShortName.trim() !== o.Name.trim() ? ` (${o.ShortName.trim()})` : ""}`;
  return (
    `${name}${cats}${blurb ? `\n  ${blurb}` : ""}\n  ${orgUrl(o.WebsiteKey)}` +
    (contact?.length ? `\n  ${contact.join("\n  ")}` : "")
  );
}

function formatEvent(e: EventHit): string {
  const tags = [
    ...(e.theme ? [e.theme] : []),
    ...(e.categoryNames ?? []),
    ...(e.benefitNames ?? []),
  ];
  const rsvp = e.rsvpTotal ? ` · ${e.rsvpTotal} RSVP` : "";
  const desc = stripHtml(e.description, 240);
  return (
    `${e.name.trim()} — ${e.organizationName.trim()}\n` +
    `  ${stampRange(e.startsOn, e.endsOn)} · ${e.location?.trim() || "location TBA"}${rsvp}` +
    `${tags.length ? `\n  ${tags.join(" · ")}` : ""}` +
    `${desc ? `\n  ${desc}` : ""}\n  ${eventUrl(e.id)}`
  );
}

export function registerBoilerLink(server: McpServer) {
  server.registerTool(
    "search_student_orgs",
    {
      title: "Search Purdue student organizations",
      description:
        "Find student organizations by what someone is actually into — 'clubs for someone into quant trading', 'anime', 'rock climbing'. Searches every word of all ~1,200 orgs' names, missions and full descriptions, tolerates typos, and understands campus synonyms, so it finds clubs that never use the word you typed. Set include_links to also return each club's email, website, Instagram and other socials — do that whenever someone asks how to reach or follow a club. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("What they're into, e.g. 'robotics', 'a cappella', 'quant finance'."),
        category: z
          .string()
          .optional()
          .describe("Org category name, e.g. 'Club Sports'. See boilerlink_categories."),
        include_links: z
          .boolean()
          .optional()
          .describe("Fetch email, website and socials for each result (first 10). Default false."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, category, include_links, limit }): Promise<ToolResult> => {
      const n = limit ?? 20;
      const { docs, index } = await orgCorpus();

      let pool = docs;
      let catLabel = "";
      if (category) {
        const name = await matchCategory("organization/category", category);
        if (!name)
          return text(
            `No BoilerLink org category matches "${category}". Call boilerlink_categories for the list.`,
          );
        catLabel = name;
        pool = pool.filter((o) => o.CategoryNames?.some((c) => c.trim() === name));
      }

      let results: OrgHit[];
      if (query) {
        // A category filter shrinks the corpus, so the index has to be rebuilt
        // over the survivors - BM25 scores are relative to the collection.
        results = searchIndex(category ? orgIndex(pool) : index, query, n).map((r) => r.value);
      } else {
        results = pool.slice(0, n);
      }

      const what = [query && `"${query}"`, catLabel && `category ${catLabel}`]
        .filter(Boolean)
        .join(" + ");
      if (!results.length) return text(`No student organizations match ${what || "that search"}.`);

      let contacts: (string[] | undefined)[] = [];
      if (include_links) {
        contacts = await Promise.all(
          results.map(async (o, i) => {
            if (i >= 10) return undefined;
            try {
              return links(await detail(o.WebsiteKey));
            } catch {
              return undefined;
            }
          }),
        );
      }

      return text(
        `${results.length} of ${pool.length} org(s)${what ? ` — ${what}` : ""}\n\n` +
          results.map((o, i) => formatOrg(o, contacts[i])).join("\n\n") +
          (include_links && results.length > 10
            ? "\n\n(links fetched for the first 10 results only)"
            : ""),
      );
    },
  );

  server.registerTool(
    "student_org_profile",
    {
      title: "One student organization in full",
      description:
        "Everything BoilerLink publishes about one student org: mission, contact email and phone, website and every social account (Instagram, LinkedIn, YouTube, Twitter, …), categories, active status, when it joined BoilerLink, whether it is accepting members, and its next events. Use this for 'what's their Instagram', 'how do I contact them', 'when do they meet'. Accepts an org name, a BoilerLink website key, or a BoilerLink URL. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        org: z
          .string()
          .describe("Org name, website key, or boilerlink.purdue.edu/organization/... URL."),
        events: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe("Upcoming events to list. Default 5."),
      },
    },
    async ({ org, events }): Promise<ToolResult> => {
      const hit = await findOrg(org);
      if (!hit) return text(`No BoilerLink organization matches "${org}".`);
      const d = await detail(hit.WebsiteKey);

      const n = events ?? 5;
      let upcoming = "";
      if (n > 0) {
        const { docs } = await eventCorpus();
        const now = Date.now();
        const mine = docs
          .filter((e) => e.organizationId === d.id && new Date(e.endsOn).getTime() > now)
          .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
        upcoming = mine.length
          ? `\n\nUpcoming events (${Math.min(n, mine.length)} of ${mine.length})\n\n${mine
              .slice(0, n)
              .map(formatEvent)
              .join("\n\n")}`
          : "\n\nNo upcoming events posted on BoilerLink. Plenty of active clubs run on Instagram instead — check the links above.";
      }

      const contact = links(d);
      const lines = [
        `${d.name.trim()}${d.shortName && d.shortName.trim() !== d.name.trim() ? ` (${d.shortName.trim()})` : ""}`,
        `  status: ${d.status}${d.showJoin ? " · accepting members" : " · not accepting members on BoilerLink"}`,
        hit.CategoryNames?.length
          ? `  categories: ${hit.CategoryNames.map((c) => c.trim()).join(", ")}`
          : "",
        d.organizationType?.name ? `  type: ${d.organizationType.name}` : "",
        d.startDate && !d.startDate.startsWith("1969")
          ? `  on BoilerLink since: ${prettyDate(d.startDate)}`
          : "",
        `  ${orgUrl(d.websiteKey)}`,
        contact.length ? `\nContact and links\n  ${contact.join("\n  ")}` : "",
        stripHtml(d.summary, 400) ? `\n${stripHtml(d.summary, 400)}` : "",
        stripHtml(d.description, 1200) ? `\n${stripHtml(d.description, 1200)}` : "",
      ].filter(Boolean);

      return text(lines.join("\n") + upcoming);
    },
  );

  server.registerTool(
    "search_club_events",
    {
      title: "Search student-org events on BoilerLink",
      description:
        "Upcoming student organization events — callouts, general meetings, socials, tryouts, philanthropy — with time, room, host org and RSVP count. Searches the full text of every upcoming event and tolerates typos, so 'something chill this weekend' or 'free pizza' works. Filter by host org, theme, category, perks (free food, free stuff), and date window. Distinct from the official university calendar (search_events). Upcoming events only. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        query: z.string().optional().describe("What they want, e.g. 'callout', 'hackathon', 'free pizza'."),
        org: z.string().optional().describe("Only events from this org (name, key, or URL)."),
        theme: z
          .enum(THEMES)
          .optional()
          .describe("Engage theme, e.g. 'Social', 'ThoughtfulLearning'."),
        category: z
          .string()
          .optional()
          .describe("Event category name, e.g. 'Callout', 'Meeting'. See boilerlink_categories."),
        perk: z
          .enum(["free food", "free stuff"])
          .optional()
          .describe("Only events offering this."),
        start: z.string().optional().describe("YYYY-MM-DD start of window. Defaults to now."),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Window length in days from start, e.g. 1 for today, 3 for the weekend."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, org, theme, category, perk, start, days, limit }): Promise<ToolResult> => {
      const n = limit ?? 20;
      const { docs } = await eventCorpus();

      let orgLabel = "";
      let orgId: number | undefined;
      if (org) {
        const hit = await findOrg(org);
        if (!hit) return text(`No BoilerLink organization matches "${org}".`);
        orgId = Number(hit.Id);
        orgLabel = hit.Name.trim();
      }

      let catLabel = "";
      if (category) {
        const name = await matchCategory("category", category);
        if (!name)
          return text(
            `No BoilerLink event category matches "${category}". Call boilerlink_categories for the list.`,
          );
        catLabel = name;
      }

      const day = start ? parseCampusDate(start) : campusToday();
      if (!day)
        return text(`"${start}" is not a date I can read. Use YYYY-MM-DD, e.g. ${campusToday()}.`);
      const from = start ? campusIso(day) : new Date().toISOString();
      const until = days ? campusIso(shiftDate(day, days)) : undefined;
      const perkName = perk === "free stuff" ? "Free Stuff" : perk ? "Free Food" : undefined;
      const now = new Date().toISOString();

      const pool = docs.filter((e) => {
        // The index is rebuilt every 10 minutes; never show an event that has
        // already ended because the crawl is a few minutes stale.
        if (e.endsOn <= now) return false;
        if (e.endsOn < from) return false;
        if (until && e.startsOn > until) return false;
        if (orgId !== undefined && e.organizationId !== orgId) return false;
        if (theme && e.theme !== theme) return false;
        if (catLabel && !e.categoryNames?.some((c) => c.trim() === catLabel)) return false;
        if (perkName && !e.benefitNames?.some((b) => b.trim() === perkName)) return false;
        return true;
      });

      let results: EventHit[];
      if (query) {
        results = searchIndex(eventIndex(pool), query, n).map((r) => r.value);
      } else {
        results = [...pool].sort((a, b) => a.startsOn.localeCompare(b.startsOn)).slice(0, n);
      }

      const what = [
        query && `"${query}"`,
        orgLabel && `host ${orgLabel}`,
        theme && `theme ${theme}`,
        catLabel && `category ${catLabel}`,
        perkName && perkName.toLowerCase(),
        until && `through ${shiftDate(start ?? campusToday(), days!)}`,
      ]
        .filter(Boolean)
        .join(" · ");
      if (!results.length) return text(`No upcoming club events match ${what || "that search"}.`);
      return text(
        `${results.length} of ${pool.length} upcoming club event(s)${what ? ` — ${what}` : ""}\n\n` +
          results.map(formatEvent).join("\n\n"),
      );
    },
  );

  server.registerTool(
    "club_event_details",
    {
      title: "One BoilerLink event in full",
      description:
        "Full detail for one student-org event: complete description, street address and map coordinates, categories and perks (free food, free stuff), RSVP count and spots left, and the host organization. Takes the event id or a BoilerLink event URL from search_club_events. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        event: z.string().describe("Event id, or a boilerlink.purdue.edu/event/... URL."),
      },
    },
    async ({ event }): Promise<ToolResult> => {
      const id = (event.match(/(\d{4,})/g) ?? []).pop();
      if (!id) return text(`"${event}" does not contain a BoilerLink event id.`);

      type EventDetail = {
        id: number;
        name: string;
        description: string | null;
        startsOn: string;
        endsOn: string;
        theme: string | null;
        organizationId: number;
        address: {
          name: string | null;
          address: string | null;
          latitude: number | null;
          longitude: number | null;
          onlineLocation: string | null;
          instructions: string | null;
        } | null;
        categories: Category[];
        benefits: { name: string }[];
        rsvpSettings: {
          totalRsvps: number | null;
          spotsAvailable: number | null;
          isInviteOnly: boolean;
          shouldAllowGuests: boolean;
        } | null;
        state?: { status: string } | null;
      };
      const d = await getJSON<EventDetail>(`${API}/event/${id}`, { ttlMs: EVENT_TTL });

      // The detail payload carries an org id but not its name.
      let host = "";
      try {
        const { docs } = await orgCorpus();
        host = docs.find((o) => Number(o.Id) === d.organizationId)?.Name.trim() ?? "";
      } catch {
        // A named host is a nicety, not the answer.
      }

      const where = [d.address?.name?.trim(), d.address?.address?.trim()]
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .join(" · ");
      const tags = [
        d.theme,
        ...(d.categories ?? []).map((c) => c.name),
        ...(d.benefits ?? []).map((b) => b.name),
      ].filter(Boolean);
      const rsvp = d.rsvpSettings;
      const lines = [
        `${d.name.trim()}${host ? ` — ${host}` : ""}`,
        `  ${stampRange(d.startsOn, d.endsOn)}`,
        where ? `  ${where}` : "",
        d.address?.latitude && d.address?.longitude
          ? `  map: ${d.address.latitude}, ${d.address.longitude}`
          : "",
        d.address?.onlineLocation ? `  online: ${d.address.onlineLocation}` : "",
        d.address?.instructions ? `  instructions: ${stripHtml(d.address.instructions, 200)}` : "",
        tags.length ? `  ${tags.join(" · ")}` : "",
        rsvp
          ? `  RSVPs: ${rsvp.totalRsvps ?? 0}${rsvp.spotsAvailable !== null ? ` · ${rsvp.spotsAvailable} spot(s) left` : ""}${rsvp.isInviteOnly ? " · invite only" : ""}${rsvp.shouldAllowGuests ? " · guests allowed" : ""}`
          : "",
        d.state?.status && d.state.status !== "Approved" ? `  status: ${d.state.status}` : "",
        `  ${eventUrl(d.id)}`,
        stripHtml(d.description, 2000) ? `\n${stripHtml(d.description, 2000)}` : "",
      ].filter(Boolean);

      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "boilerlink_categories",
    {
      title: "BoilerLink filter vocabulary",
      description:
        "The exact category and theme names accepted by search_student_orgs and search_club_events: ~31 organization categories, 14 event categories, and the fixed event themes. Call this before guessing a category name. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const [orgs, events] = await Promise.all([
        categories("organization/category"),
        categories("category"),
      ]);
      const names = (p: CategoryPage) =>
        p.items
          .map((c) => c.name.trim())
          .sort((a, b) => a.localeCompare(b))
          .join(", ");
      return text(
        [
          `Organization categories (${orgs.totalItems}) — search_student_orgs(category)`,
          `  ${names(orgs)}`,
          "",
          `Event categories (${events.totalItems}) — search_club_events(category)`,
          `  ${names(events)}`,
          "",
          `Event themes (${THEMES.length}) — search_club_events(theme)`,
          `  ${THEMES.join(", ")}`,
        ].join("\n"),
      );
    },
  );
}
