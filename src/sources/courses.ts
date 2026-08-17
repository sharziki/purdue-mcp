import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON, qs } from "../lib/http.js";
import { campusToday, prettyTime } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Purdue.io — community-run open-source mirror of the Purdue course catalog.
// Note: this OData endpoint rejects $top, so results are capped client-side.
const BASE = "https://api.purdue.io/odata";

const odata = (s: string) => s.replace(/'/g, "''");

type Term = { Id: string; Code: string; Name: string; StartDate: string | null; EndDate: string | null };
type Subject = { Id: string; Name: string; Abbreviation: string };
type Course = {
  Id: string;
  Number: string;
  Title: string;
  CreditHours: number;
  Description: string | null;
  Subject?: Subject;
};
type Meeting = {
  Type: string;
  DaysOfWeek: string | null;
  StartTime: string | null;
  Duration: string | null;
  StartDate: string | null;
  EndDate: string | null;
  Room?: { Number: string; Building?: { Name: string; ShortCode: string } } | null;
  Instructors?: { Name: string; Email: string | null }[];
};
type Section = { Crn: string; Type: string; Meetings?: Meeting[] };
type Class = { Term?: Term; Course?: Course; Sections?: Section[] };

async function terms(): Promise<Term[]> {
  const { value } = await getJSON<{ value: Term[] }>(`${BASE}/Terms`, { ttlMs: 6 * 60 * 60_000 });
  // The catalog carries a "999999 / The End of Time" sentinel row for
  // undated classes; it is never a real term a student can register for.
  return value.filter((t) => /^\d{6}$/.test(t.Code) && t.Code !== "999999")
    .sort((a, b) => b.Code.localeCompare(a.Code));
}

/**
 * Accepts a term code ("202710"), a name ("Fall 2026"), or nothing.
 * With no input, prefer the term that contains today, then the next one to
 * start, then the most recent — so "CS 180 sections" means this semester.
 */
async function resolveTerm(input?: string): Promise<Term | undefined> {
  const all = await terms();
  if (input) {
    const q = input.trim().toLowerCase();
    return (
      all.find((t) => t.Code === q) ??
      all.find((t) => t.Name.toLowerCase() === q) ??
      all.find((t) => t.Name.toLowerCase().includes(q))
    );
  }
  const today = campusToday();
  const dated = all.filter((t) => t.StartDate && t.EndDate);
  return (
    dated.find((t) => t.StartDate! <= today && today <= t.EndDate!) ??
    [...dated].reverse().find((t) => t.StartDate! > today) ??
    all[0]
  );
}

/** "PT50M" / "PT1H20M" -> minutes */
function durationMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

function meetingLine(mt: Meeting): string {
  const days = mt.DaysOfWeek ?? "TBA";
  const start = mt.StartTime ? prettyTime(mt.StartTime.slice(0, 8)) : "TBA";
  const mins = durationMinutes(mt.Duration);
  const where = mt.Room?.Building
    ? `${mt.Room.Building.ShortCode} ${mt.Room.Number}`
    : "location TBA";
  const who = mt.Instructors?.length
    ? mt.Instructors.map((i) => i.Name).join(", ")
    : "instructor TBA";
  return `    ${mt.Type}: ${days} ${start}${mins ? ` (${mins} min)` : ""} · ${where} · ${who}`;
}

export function registerCourses(server: McpServer) {
  server.registerTool(
    "list_terms",
    {
      title: "List Purdue academic terms",
      description:
        "Every term in the Purdue course catalog, newest first, with codes and date ranges. Use the code with the other course tools. Source: Purdue.io (community catalog mirror).",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit }): Promise<ToolResult> => {
      const all = (await terms()).slice(0, limit ?? 12);
      return text(
        all
          .map(
            (t) =>
              `${t.Code} — ${t.Name}${t.StartDate ? ` (${t.StartDate} → ${t.EndDate ?? "?"})` : ""}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "list_subjects",
    {
      title: "List course subjects",
      description:
        "All course subject codes at Purdue (CS, MA, ENGR, …), optionally filtered by name. Source: Purdue.io.",
      inputSchema: { query: z.string().optional().describe("Filter by name or abbreviation.") },
    },
    async ({ query }): Promise<ToolResult> => {
      const { value } = await getJSON<{ value: Subject[] }>(`${BASE}/Subjects`, {
        ttlMs: 6 * 60 * 60_000,
      });
      let subs = value;
      if (query) {
        const q = query.toLowerCase();
        subs = subs.filter(
          (s) => s.Name.toLowerCase().includes(q) || s.Abbreviation.toLowerCase().includes(q),
        );
      }
      subs.sort((a, b) => a.Abbreviation.localeCompare(b.Abbreviation));
      if (!subs.length) return text(`No subject matches "${query}".`);
      return text(subs.map((s) => `${s.Abbreviation} — ${s.Name}`).join("\n"));
    },
  );

  server.registerTool(
    "search_courses",
    {
      title: "Search the Purdue course catalog",
      description:
        "Find courses by subject code, course number, and/or title keyword — returns titles, credit hours, and descriptions. Source: Purdue.io.",
      inputSchema: {
        subject: z.string().optional().describe("Subject abbreviation, e.g. 'CS', 'MA', 'ENGR'."),
        number: z
          .string()
          .optional()
          .describe("Course number, e.g. '18000' or '180' (short forms are zero-padded)."),
        title_contains: z.string().optional().describe("Keyword in the course title."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
      },
    },
    async ({ subject, number, title_contains, limit }): Promise<ToolResult> => {
      if (!subject && !number && !title_contains)
        return text("Give at least one of: subject, number, title_contains.", true);

      const filters: string[] = [];
      if (subject) filters.push(`Subject/Abbreviation eq '${odata(subject.toUpperCase())}'`);
      if (number) {
        const n = /^\d{1,5}$/.test(number) ? number.padEnd(5, "0") : number;
        filters.push(`Number eq '${odata(n)}'`);
      }
      if (title_contains)
        filters.push(`contains(tolower(Title), '${odata(title_contains.toLowerCase())}')`);

      const url = `${BASE}/Courses${qs({
        $filter: filters.join(" and "),
        $expand: "Subject",
        $orderby: "Number asc",
      })}`;
      const { value } = await getJSON<{ value: Course[] }>(url, { ttlMs: 30 * 60_000 });
      if (!value.length) return text("No courses match.");

      const cap = limit ?? 25;
      const body = value
        .slice(0, cap)
        .map((c) => {
          const code = `${c.Subject?.Abbreviation ?? "?"} ${c.Number}`;
          const desc = c.Description ? `\n  ${c.Description.slice(0, 400)}` : "";
          return `${code} — ${c.Title} (${c.CreditHours} cr)${desc}`;
        })
        .join("\n\n");
      const more = value.length > cap ? `\n\n…${value.length - cap} more matches.` : "";
      return text(body + more);
    },
  );

  server.registerTool(
    "course_sections",
    {
      title: "Get sections and meeting times for a course",
      description:
        "CRNs, section types, meeting days/times, rooms, and instructors for a course in a given term. Source: Purdue.io.",
      inputSchema: {
        subject: z.string().describe("Subject abbreviation, e.g. 'CS'."),
        number: z.string().describe("Course number, e.g. '18000' or '180'."),
        term: z
          .string()
          .optional()
          .describe("Term code ('202710') or name ('Fall 2026'). Defaults to the newest term."),
      },
    },
    async ({ subject, number, term }): Promise<ToolResult> => {
      const t = await resolveTerm(term);
      if (!t) return text(`Unknown term "${term}". Call list_terms.`, true);
      const n = /^\d{1,5}$/.test(number) ? number.padEnd(5, "0") : number;

      const url = `${BASE}/Classes${qs({
        $filter: `Course/Subject/Abbreviation eq '${odata(subject.toUpperCase())}' and Course/Number eq '${odata(n)}' and Term/Code eq '${odata(t.Code)}'`,
        $expand:
          "Term,Course($expand=Subject),Sections($expand=Meetings($expand=Room($expand=Building),Instructors))",
      })}`;
      const { value } = await getJSON<{ value: Class[] }>(url, { ttlMs: 15 * 60_000 });
      if (!value.length)
        return text(
          `No ${subject.toUpperCase()} ${n} classes found for ${t.Name} (${t.Code}). The catalog mirror may not have synced this term yet — call list_terms to see what is available.`,
        );

      const out: string[] = [];
      for (const cls of value) {
        const c = cls.Course;
        out.push(
          `${c?.Subject?.Abbreviation ?? subject.toUpperCase()} ${c?.Number ?? n} — ${c?.Title ?? ""} (${c?.CreditHours ?? "?"} cr) · ${t.Name}`,
        );
        for (const s of cls.Sections ?? []) {
          out.push(`  CRN ${s.Crn} · ${s.Type}`);
          for (const mt of s.Meetings ?? []) out.push(meetingLine(mt));
        }
      }
      return text(out.join("\n"));
    },
  );

  server.registerTool(
    "find_building",
    {
      title: "Look up a campus building",
      description:
        "Resolve a Purdue building short code or name (e.g. 'LWSN' -> Lawson Computer Science Building). Source: Purdue.io.",
      inputSchema: {
        query: z.string().optional().describe("Short code or partial name. Omit to list all."),
      },
    },
    async ({ query }): Promise<ToolResult> => {
      const { value } = await getJSON<{ value: { Name: string; ShortCode: string }[] }>(
        `${BASE}/Buildings`,
        { ttlMs: 24 * 60 * 60_000 },
      );
      let list = value;
      if (query) {
        const q = query.toLowerCase();
        list = list.filter(
          (b) => b.ShortCode?.toLowerCase().includes(q) || b.Name?.toLowerCase().includes(q),
        );
      }
      list.sort((a, b) => (a.ShortCode ?? "").localeCompare(b.ShortCode ?? ""));
      if (!list.length) return text(`No building matches "${query}".`);
      return text(list.map((b) => `${b.ShortCode ?? "—"} — ${b.Name}`).join("\n"));
    },
  );
}
