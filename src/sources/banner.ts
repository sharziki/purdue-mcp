import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stripHtml } from "../lib/http.js";
import { campusNowLabel } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Purdue's Banner self-service class search is public — no login. It is the
// authoritative live source for seat counts, waitlists, prerequisites, and
// registration restrictions, which the Purdue.io catalog mirror does not carry.
const BASE = "https://selfservice.mypurdue.purdue.edu/prod";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type Entry = { at: number; body: string };
const cache = new Map<string, Entry>();

async function html(
  path: string,
  opts: { form?: string; ttlMs?: number } = {},
): Promise<string> {
  const key = `${path}|${opts.form ?? ""}`;
  const hit = cache.get(key);
  const ttl = opts.ttlMs ?? 5 * 60_000;
  if (hit && Date.now() - hit.at < ttl) return hit.body;

  const res = await fetch(`${BASE}/${path}`, {
    method: opts.form ? "POST" : "GET",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: opts.form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Banner returned ${res.status} for ${path}`);
  const body = await res.text();
  cache.set(key, { at: Date.now(), body });
  return body;
}

type Term = { code: string; name: string };

async function terms(): Promise<Term[]> {
  const page = await html("bwckschd.p_disp_dyn_sched", { ttlMs: 6 * 60 * 60_000 });
  const out: Term[] = [];
  for (const m of page.matchAll(/VALUE="(\d{6})"[^>]*>([^<]+)/g)) {
    out.push({ code: m[1], name: m[2].trim() });
  }
  return out;
}

/** Registerable terms come first in Banner's list; "(View only)" ones are past. */
async function resolveTerm(input?: string): Promise<Term | undefined> {
  const all = await terms();
  if (!input) return all.find((t) => !/view only/i.test(t.name)) ?? all[0];
  const q = input.trim().toLowerCase();
  return (
    all.find((t) => t.code === q) ??
    all.find((t) => t.name.toLowerCase().replace(/\s*\(view only\)/, "") === q) ??
    all.find((t) => t.name.toLowerCase().includes(q))
  );
}

const pad = (n: string) => (/^\d{1,5}$/.test(n) ? n.padEnd(5, "0") : n);

type Section = {
  crn: string;
  title: string;
  course: string;
  section: string;
  meetings: string[];
};

/** Meeting rows live on the listing page only — Banner's detail page omits them. */
function meetingsIn(chunk: string): string[] {
  const table = /Scheduled Meeting Times<\/caption>(.*?)<\/table>/is.exec(chunk)?.[1] ?? "";
  const out: string[] = [];
  for (const row of table.matchAll(/<tr>(.*?)<\/tr>/gis)) {
    const cells = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map((c) => stripHtml(c[1], 120));
    if (cells.filter(Boolean).length >= 3) out.push(cells.filter(Boolean).join(" · "));
  }
  return out;
}

/** Section headers look like: "Title - CRN - SUBJ NUM - SECTION". */
async function sections(term: string, subject: string, number?: string): Promise<Section[]> {
  const form = new URLSearchParams();
  form.append("term_in", term);
  // Banner requires a "dummy" seed for each multi-select before the real values.
  for (const k of [
    "sel_subj",
    "sel_day",
    "sel_schd",
    "sel_insm",
    "sel_camp",
    "sel_levl",
    "sel_sess",
    "sel_instr",
    "sel_ptrm",
    "sel_attr",
  ])
    form.append(k, "dummy");
  form.append("sel_subj", subject.toUpperCase());
  form.append("sel_crse", number ? pad(number) : "");
  form.append("sel_title", "");
  form.append("sel_schd", "%");
  form.append("sel_from_cred", "");
  form.append("sel_to_cred", "");
  form.append("sel_camp", "%");
  form.append("sel_ptrm", "%");
  form.append("sel_instr", "%");
  form.append("sel_attr", "%");
  for (const [k, v] of [
    ["begin_hh", "0"],
    ["begin_mi", "0"],
    ["begin_ap", "a"],
    ["end_hh", "0"],
    ["end_mi", "0"],
    ["end_ap", "a"],
  ])
    form.append(k, v);

  const page = await html("bwckschd.p_get_crse_unsec", { form: form.toString() });
  const out: Section[] = [];
  // Each section is a link to its own detail page. Anchoring on that href is
  // stable; the surrounding <th> class casing is not.
  const anchors = [
    ...page.matchAll(/<a href="[^"]*p_disp_detail_sched\?[^"]*crn_in=\d+"[^>]*>([^<]+)<\/a>/gi),
  ];
  anchors.forEach((m, i) => {
    const parts = stripHtml(m[1], 300).split(" - ");
    if (parts.length < 4) return;
    const section = parts.pop()!;
    const course = parts.pop()!;
    const crn = parts.pop()!;
    // Everything between this anchor and the next belongs to this section.
    const chunk = page.slice(m.index!, anchors[i + 1]?.index ?? page.length);
    out.push({
      crn: crn.trim(),
      course: course.trim(),
      section: section.trim(),
      title: parts.join(" - ").trim(),
      meetings: meetingsIn(chunk),
    });
  });
  return out;
}

type Detail = {
  crn: string;
  seats: { capacity: number; actual: number; remaining: number } | null;
  waitlist: { capacity: number; actual: number; remaining: number } | null;
  restrictions: string;
  prerequisites: string;
};

function block(page: string, label: string): string {
  const re = new RegExp(
    `<SPAN class="fieldlabeltext">${label}:?\\s*</SPAN>(.*?)(?=<SPAN class="fieldlabeltext">|</td>|</table>)`,
    "is",
  );
  return stripHtml(re.exec(page)?.[1] ?? "", 900);
}

function availRow(page: string, label: string) {
  const re = new RegExp(
    `<SPAN class="fieldlabeltext">${label}</SPAN></th>\\s*<td[^>]*>(\\d+)</td>\\s*<td[^>]*>(\\d+)</td>\\s*<td[^>]*>(-?\\d+)</td>`,
    "i",
  );
  const m = re.exec(page);
  return m ? { capacity: +m[1], actual: +m[2], remaining: +m[3] } : null;
}

async function detail(term: string, crn: string): Promise<Detail> {
  const page = await html(`bwckschd.p_disp_detail_sched?term_in=${term}&crn_in=${crn}`, {
    ttlMs: 3 * 60_000,
  });
  return {
    crn,
    seats: availRow(page, "Seats"),
    waitlist: availRow(page, "Waitlist Seats"),
    restrictions: block(page, "Restrictions"),
    prerequisites: block(page, "Prerequisites"),
  };
}

/** Bounded concurrency — Banner is a slow legacy app; don't hammer it. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx]);
        } catch {
          out[idx] = undefined as R;
        }
      }
    }),
  );
  return out;
}

export function registerBanner(server: McpServer) {
  server.registerTool(
    "course_availability",
    {
      title: "Live seat and waitlist counts for a course",
      description:
        "How many seats are actually open in each section of a course right now, with waitlist counts, CRNs, meeting times, and instructors. This is the authoritative registration data — use it over search_courses/course_sections when the question is 'can I get in'. Source: Purdue Banner self-service (public, live).",
      inputSchema: {
        subject: z.string().describe("Subject abbreviation, e.g. 'CS', 'MA', 'ENGL'."),
        number: z.string().describe("Course number, e.g. '18000' or '180'."),
        term: z
          .string()
          .optional()
          .describe("Term code ('202710') or name ('Fall 2026'). Defaults to the registerable term."),
        open_only: z.boolean().optional().describe("Only sections with seats remaining."),
        limit: z.number().int().min(1).max(60).optional().describe("Max sections to detail. Default 25."),
      },
    },
    async ({ subject, number, term, open_only, limit }): Promise<ToolResult> => {
      const t = await resolveTerm(term);
      if (!t) return text(`Unknown term "${term}". Call list_terms.`, true);

      const secs = await sections(t.code, subject, number);
      if (!secs.length)
        return text(`No ${subject.toUpperCase()} ${pad(number)} sections found in ${t.name}.`);

      const cap = limit ?? 25;
      const details = await mapLimit(secs.slice(0, cap), 4, (s) => detail(t.code, s.crn));

      const rows = secs.slice(0, cap).map((s, i) => ({ s, d: details[i] }));
      const shown = open_only ? rows.filter((r) => (r.d?.seats?.remaining ?? 0) > 0) : rows;
      if (!shown.length)
        return text(
          `Every ${subject.toUpperCase()} ${pad(number)} section in ${t.name} is full (${rows.length} checked).`,
        );

      const body = shown
        .map(({ s, d }) => {
          const seats = d?.seats
            ? `${d.seats.remaining} of ${d.seats.capacity} seats open (${d.seats.actual} enrolled)`
            : "seat data unavailable";
          const wl =
            d?.waitlist && d.waitlist.capacity > 0
              ? ` · waitlist ${d.waitlist.actual}/${d.waitlist.capacity}`
              : "";
          const meet = s.meetings.length ? `\n  ${s.meetings[0]}` : "";
          return `${s.course} ${s.section} — CRN ${s.crn}\n  ${seats}${wl}${meet}`;
        })
        .join("\n\n");

      const totalOpen = rows.reduce((n, r) => n + Math.max(0, r.d?.seats?.remaining ?? 0), 0);
      const scope =
        secs.length > cap
          ? `${shown.length} shown of ${rows.length} checked (${secs.length} sections exist — raise limit to check the rest)`
          : `${shown.length} shown of ${secs.length} section(s)`;
      return text(
        `${subject.toUpperCase()} ${pad(number)} — ${t.name} (${campusNowLabel()})\n` +
          `${scope} · ${totalOpen} seats open across the ${rows.length} checked\n\n${body}`,
      );
    },
  );

  server.registerTool(
    "section_details",
    {
      title: "Full registration detail for one CRN",
      description:
        "Everything Banner knows about one section: seats, waitlist, prerequisites, and major/level restrictions. Answers 'why can't I register for this'. Meeting times come from course_availability or course_sections. Source: Purdue Banner self-service (public, live).",
      inputSchema: {
        crn: z.string().describe("The 5-digit CRN, e.g. '13610'."),
        term: z.string().optional().describe("Term code or name. Defaults to the registerable term."),
      },
    },
    async ({ crn, term }): Promise<ToolResult> => {
      const t = await resolveTerm(term);
      if (!t) return text(`Unknown term "${term}".`, true);
      const d = await detail(t.code, crn);
      if (!d.seats && !d.restrictions && !d.prerequisites)
        return text(`No section found for CRN ${crn} in ${t.name}.`);

      const out = [`CRN ${crn} — ${t.name} (${campusNowLabel()})`];
      if (d.seats)
        out.push(
          `\nSeats: ${d.seats.remaining} open — ${d.seats.actual} enrolled of ${d.seats.capacity}`,
        );
      if (d.waitlist)
        out.push(
          `Waitlist: ${d.waitlist.remaining} open — ${d.waitlist.actual} of ${d.waitlist.capacity}`,
        );
      if (d.restrictions) out.push(`\nRestrictions:\n  ${d.restrictions}`);
      if (d.prerequisites) out.push(`\nPrerequisites:\n  ${d.prerequisites}`);
      return text(out.join("\n"));
    },
  );

  server.registerTool(
    "banner_terms",
    {
      title: "List Banner registration terms",
      description:
        "Terms available in Purdue's live registration system, newest first. Terms marked 'View only' are closed to registration. Source: Purdue Banner self-service.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const all = await terms();
      return text(all.map((t) => `${t.code} — ${t.name}`).join("\n"));
    },
  );
}
