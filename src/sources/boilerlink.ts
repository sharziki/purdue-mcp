import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs, stripHtml } from "../lib/http.js";
import { campusIso, campusToday, prettyDate, prettyStamp, shiftDate, stampRange } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// BoilerLink is Purdue's Anthology Engage instance. boilerlink.purdue.edu is
// the vanity host students see and serves the same public discovery API as
// purdue.campuslabs.com/engage — no auth, no session cookie.
const SITE = "https://boilerlink.purdue.edu";
const API = `${SITE}/api/discovery`;

const ORG_TTL = 30 * 60_000;
const EVENT_TTL = 5 * 60_000;

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
  latitude?: string | null;
  longitude?: string | null;
};

type EventSearch = { "@odata.count": number; value: EventHit[] };

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

const categories = (path: string) =>
  getJSON<CategoryPage>(`${API}/${path}?take=100`, { ttlMs: 12 * 60 * 60_000 });

/** Match a user-typed category name against the live list. Returns its id. */
async function categoryId(path: string, name: string): Promise<number | null> {
  const { items } = await categories(path);
  const want = name.trim().toLowerCase();
  const hit =
    items.find((c) => c.name.trim().toLowerCase() === want) ??
    items.find((c) => c.name.toLowerCase().includes(want));
  return hit?.id ?? null;
}

/** Resolve "cs club", "boilerblockchain", or a BoilerLink URL to one org. */
async function findOrg(input: string): Promise<OrgHit | null> {
  const raw = input.trim();
  const key = raw.replace(/^.*\/organization\//, "").replace(/[/?#].*$/, "");

  // The search index does not tokenize WebsiteKey, so a key only ever resolves
  // through the by-key endpoint. A miss there is a 404, not an empty result.
  if (/^[A-Za-z0-9._-]+$/.test(key)) {
    try {
      const d = await getJSON<{ id: number; name: string; websiteKey: string }>(
        `${API}/organization/bykey/${encodeURIComponent(key)}`,
        { ttlMs: ORG_TTL },
      );
      // Categories live in the search index only; look them up by exact name.
      const idx = await getJSON<OrgSearch>(
        `${API}/search/organizations${qs({ query: d.name, top: 25 })}`,
        { ttlMs: ORG_TTL },
      );
      const enriched = (idx.value ?? []).find((o) => o.WebsiteKey === d.websiteKey);
      return enriched ?? { Id: String(d.id), Name: d.name, ShortName: null, WebsiteKey: d.websiteKey };
    } catch {
      // Not a website key — fall through to a name search.
    }
  }

  const data = await getJSON<OrgSearch>(
    `${API}/search/organizations${qs({ query: raw, top: 25 })}`,
    { ttlMs: ORG_TTL },
  );
  const hits = data.value ?? [];
  const want = raw.toLowerCase();
  return (
    hits.find((o) => o.Name.trim().toLowerCase() === want) ??
    hits.find((o) => o.ShortName?.trim().toLowerCase() === want) ??
    hits[0] ??
    null
  );
}

function formatOrg(o: OrgHit): string {
  const cats = o.CategoryNames?.length ? `\n  categories: ${o.CategoryNames.map((c) => c.trim()).join(", ")}` : "";
  const blurb = stripHtml(o.Summary || o.Description, 240);
  return `${o.Name.trim()}${o.ShortName && o.ShortName.trim() !== o.Name.trim() ? ` (${o.ShortName.trim()})` : ""}${cats}${blurb ? `\n  ${blurb}` : ""}\n  ${orgUrl(o.WebsiteKey)}`;
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

async function eventSearch(params: Record<string, string | number | undefined>) {
  return getJSON<EventSearch>(`${API}/event/search${qs(params)}`, { ttlMs: EVENT_TTL });
}

export function registerBoilerLink(server: McpServer) {
  server.registerTool(
    "search_student_orgs",
    {
      title: "Search Purdue student organizations",
      description:
        "Search BoilerLink's directory of ~1,200 registered student organizations by keyword and/or category (Club Sports, Gaming, Finance, Religious and Spiritual, …). Use boilerlink_categories for the category list, student_org_profile for one org's contacts and links. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        query: z.string().optional().describe("Keyword, e.g. 'robotics', 'a cappella', 'finance'."),
        category: z
          .string()
          .optional()
          .describe("Org category name, e.g. 'Club Sports'. See boilerlink_categories."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, category, limit }): Promise<ToolResult> => {
      let filter: string | undefined;
      if (category) {
        const id = await categoryId("organization/category", category);
        if (!id)
          return text(
            `No BoilerLink org category matches "${category}". Call boilerlink_categories for the list.`,
          );
        filter = `CategoryIds/any(t:t eq '${id}')`;
      }
      const data = await getJSON<OrgSearch>(
        `${API}/search/organizations${qs({
          query,
          filter,
          top: limit ?? 20,
          "orderBy[0]": query ? undefined : "UpperName asc",
        })}`,
        { ttlMs: ORG_TTL },
      );
      const orgs = data.value ?? [];
      const what = [query && `"${query}"`, category && `category ${category}`]
        .filter(Boolean)
        .join(" + ");
      if (!orgs.length) return text(`No student organizations match ${what || "that search"}.`);
      return text(
        `${orgs.length} of ${data["@odata.count"]} matching org(s)${what ? ` — ${what}` : ""}\n\n` +
          orgs.map(formatOrg).join("\n\n"),
      );
    },
  );

  server.registerTool(
    "student_org_profile",
    {
      title: "One student organization in full",
      description:
        "Everything BoilerLink publishes about one student org: mission, contact email, website and social accounts, categories, active status, when it was founded, whether it is accepting new members, and its next events. Accepts an org name, a BoilerLink website key, or a BoilerLink URL. Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        org: z
          .string()
          .describe("Org name, website key, or boilerlink.purdue.edu/organization/... URL."),
        events: z.number().int().min(0).max(25).optional().describe("Upcoming events to list. Default 5."),
      },
    },
    async ({ org, events }): Promise<ToolResult> => {
      const hit = await findOrg(org);
      if (!hit) return text(`No BoilerLink organization matches "${org}".`);

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
        modifiedOn: string | null;
        socialMedia: Record<string, string | null> | null;
        organizationType?: { name: string } | null;
        contactInfo?: { phoneNumber: string | null; street1: string | null; city: string | null }[];
      };
      const d = await getJSON<OrgDetail>(`${API}/organization/bykey/${hit.WebsiteKey}`, {
        ttlMs: ORG_TTL,
      });

      const socials = Object.entries(d.socialMedia ?? {})
        .filter(([k, v]) => v && k !== "TwitterUserName" && !/^Google(Plus|Calendar)/.test(k))
        .map(([k, v]) => `${k.replace(/Url$/, "")}: ${v}`);
      if (d.socialMedia?.TwitterUserName) socials.push(`Twitter: @${d.socialMedia.TwitterUserName}`);
      const phone = d.contactInfo?.find((c) => c.phoneNumber)?.phoneNumber;

      const n = events ?? 5;
      let upcoming = "";
      if (n > 0) {
        const ev = await eventSearch({
          organizationId: d.id,
          take: n,
          endsAfter: new Date().toISOString(),
          orderByField: "startsOn",
          orderByDirection: "ascending",
          status: "Approved",
        });
        upcoming = (ev.value ?? []).length
          ? `\n\nUpcoming events (${ev.value.length} of ${ev["@odata.count"]})\n\n${ev.value.map(formatEvent).join("\n\n")}`
          : "\n\nNo upcoming events posted on BoilerLink.";
      }

      const lines = [
        `${d.name.trim()}${d.shortName && d.shortName.trim() !== d.name.trim() ? ` (${d.shortName.trim()})` : ""}`,
        `  status: ${d.status}${d.showJoin ? " · accepting members" : " · not accepting members on BoilerLink"}`,
        hit.CategoryNames?.length ? `  categories: ${hit.CategoryNames.map((c) => c.trim()).join(", ")}` : "",
        d.organizationType?.name ? `  type: ${d.organizationType.name}` : "",
        d.email ? `  email: ${d.email}` : "",
        phone ? `  phone: ${phone}` : "",
        d.startDate && !d.startDate.startsWith("1969")
          ? `  on BoilerLink since: ${prettyDate(d.startDate)}`
          : "",
        `  ${orgUrl(d.websiteKey)}`,
        socials.length ? `\nLinks\n  ${socials.join("\n  ")}` : "",
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
        "Upcoming student organization events — callouts, general meetings, socials, tryouts, philanthropy — with time, room, host org and RSVP count. Filter by keyword, host org, theme, category, or free food. Distinct from the official university calendar (search_events). Source: BoilerLink / Anthology Engage (live).",
      inputSchema: {
        query: z.string().optional().describe("Keyword, e.g. 'callout', 'hackathon', 'tryouts'."),
        org: z.string().optional().describe("Only events from this org (name, key, or URL)."),
        theme: z.enum(THEMES).optional().describe("Engage theme, e.g. 'Social', 'ThoughtfulLearning'."),
        category: z
          .string()
          .optional()
          .describe("Event category name, e.g. 'Callout', 'Meeting'. See boilerlink_categories."),
        free_food: z.boolean().optional().describe("Only events tagged with the Free Food benefit."),
        start: z.string().optional().describe("YYYY-MM-DD start of window. Defaults to now."),
        days: z.number().int().min(1).max(365).optional().describe("Window length in days from start."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
    },
    async ({ query, org, theme, category, free_food, start, days, limit }): Promise<ToolResult> => {
      let organizationId: number | undefined;
      let orgLabel = "";
      if (org) {
        const hit = await findOrg(org);
        if (!hit) return text(`No BoilerLink organization matches "${org}".`);
        organizationId = Number(hit.Id);
        orgLabel = hit.Name.trim();
      }

      let categoryIds: number | undefined;
      if (category) {
        const id = await categoryId("category", category);
        if (!id)
          return text(
            `No BoilerLink event category matches "${category}". Call boilerlink_categories for the list.`,
          );
        categoryIds = id;
      }

      const from = start ? campusIso(start) : new Date().toISOString();
      const until = days ? campusIso(shiftDate(start ?? campusToday(), days)) : undefined;

      const data = await eventSearch({
        query,
        organizationId,
        themes: theme,
        categoryIds,
        // The only benefit token this API filters on is FreeFood; "Free Stuff"
        // is reported in results but returns nothing as a filter value.
        benefitNames: free_food ? "FreeFood" : undefined,
        take: limit ?? 20,
        endsAfter: from,
        startsBefore: until,
        orderByField: "startsOn",
        orderByDirection: "ascending",
        status: "Approved",
      });

      const events = data.value ?? [];
      const what = [
        query && `"${query}"`,
        orgLabel && `host ${orgLabel}`,
        theme && `theme ${theme}`,
        category && `category ${category}`,
        free_food && "free food",
        until && `through ${shiftDate(start ?? campusToday(), days!)}`,
      ]
        .filter(Boolean)
        .join(" · ");
      if (!events.length) return text(`No upcoming club events match ${what || "that search"}.`);
      return text(
        `${events.length} of ${data["@odata.count"]} upcoming club event(s)${what ? ` — ${what}` : ""}\n\n` +
          events.map(formatEvent).join("\n\n"),
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
        imageUrl: string | null;
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

      // The detail payload carries an org id but not its name; the search index has both.
      let host = "";
      const idx = await eventSearch({ query: d.name, take: 10, endsAfter: "2000-01-01T00:00:00Z" });
      const match = (idx.value ?? []).find((e) => String(e.id) === String(d.id));
      if (match) host = match.organizationName.trim();

      const where = [d.address?.name?.trim(), d.address?.address?.trim()]
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .join(" · ");
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
        [
          d.theme,
          ...(d.categories ?? []).map((c) => c.name),
          ...(d.benefits ?? []).map((b) => b.name),
        ].filter(Boolean).length
          ? `  ${[d.theme, ...(d.categories ?? []).map((c) => c.name), ...(d.benefits ?? []).map((b) => b.name)].filter(Boolean).join(" · ")}`
          : "",
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
