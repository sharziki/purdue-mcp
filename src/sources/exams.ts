import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text, type ToolResult } from "../lib/result.js";

/**
 * Evening and final exam schedules, from the Registrar's published PDFs.
 *
 * Purdue exposes no exam API. The Registrar publishes UniTime-generated PDFs at
 * stable "current_*" URLs that are replaced in place each term, so the address
 * never changes even though the contents do. Those PDFs are the authoritative
 * source students are told to use, which makes them worth parsing despite the
 * format.
 *
 * Evening exams are the ones that matter for mid-semester planning: Purdue
 * schedules them at night, outside normal class meetings, and a course carrying
 * them is flagged "Evening Exams Required" in the catalog. Finals are the
 * separate end-of-term block.
 */

const BASE = "https://www.purdue.edu/registrar/pdf/exam";
const CAMPUSES = { PWL: "West Lafayette", PIN: "Indianapolis" } as const;
type Campus = keyof typeof CAMPUSES;

export type Exam = {
  subject: string;
  course: string;
  section: string;
  enrolled: number | null;
  day: string;
  date: string;
  start: string;
  end: string;
  rooms: string[];
};

const pdfCache = new Map<string, { at: number; lines: string[] }>();
const TTL_MS = 6 * 60 * 60_000;

/**
 * Extract text from a PDF without a parser dependency.
 *
 * These files are a single generated report: FlateDecode streams containing
 * ordinary text-showing operators, no font subsetting tricks and no embedded
 * images. That keeps extraction to inflate-then-read-the-parenthesized-strings,
 * which avoids adding a multi-megabyte PDF library for one report.
 */
async function pdfLines(campus: Campus, kind: "evening" | "final"): Promise<string[]> {
  const key = `${campus}:${kind}`;
  const hit = pdfCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.lines;

  const url = `${BASE}/current_${kind}_exam_schedule_${campus}.pdf`;
  const res = await fetch(url, {
    headers: { "User-Agent": "purdue-mcp (+https://github.com/sharziki/purdue-mcp)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`registrar returned ${res.status} for ${url}`);

  const raw = new Uint8Array(await res.arrayBuffer());
  const { inflateSync } = await import("node:zlib");
  const buf = Buffer.from(raw);
  const KEYWORD = Buffer.from("stream");
  const END = Buffer.from("endstream");
  const chunks: string[] = [];

  let cursor = 0;
  while (cursor < buf.length) {
    const kw = buf.indexOf(KEYWORD, cursor);
    if (kw === -1) break;
    // "endstream" also contains "stream"; treating it as an opening keyword
    // restarts the scan mid-object and silently loses most of the document.
    if (kw >= 3 && buf.subarray(kw - 3, kw).toString("latin1") === "end") {
      cursor = kw + KEYWORD.length;
      continue;
    }
    let start = kw + KEYWORD.length;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf(END, start);
    if (end === -1) break;
    try {
      // Inflate the raw bytes; decoding to a string first corrupts them.
      chunks.push(inflateSync(buf.subarray(start, end)).toString("latin1"));
    } catch {
      // Not every stream is deflated text (metadata, fonts); skipping is expected.
    }
    cursor = end + END.length;
  }

  // Each text-showing operator in this report is exactly one printed line, so
  // the strings are the rows. Joining them and re-splitting on a subject code
  // would merge a course with the continuation lines that follow it.
  const shown = chunks.join("\n").match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
  const lines = shown
    .map((s) => s.slice(1, -1).replace(/\\([()\\])/g, "$1"))
    .map((s) => s.replace(/\s+$/, ""))
    .filter((s) => s.trim().length > 0);

  pdfCache.set(key, { at: Date.now(), lines });
  return lines;
}

/**
 * One scheduled sitting, located by its date-and-time column.
 *
 * Anchoring on the timestamp rather than on fixed offsets is what makes this
 * robust: the report indents rows inconsistently relative to its own header,
 * and a course may carry a section label, a meeting-times column, a bracketed
 * designator, or none of them. Everything before the timestamp is identity,
 * everything after is location.
 */
const DATE_TIME =
  /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{2}\/\d{2})\s+(\d{1,2}:\d{2}[ap])\s*-\s*(\d{1,2}:\d{2}[ap])/;

export type Sitting = {
  subject: string | null;
  course: string | null;
  section: string | null;
  enrolled: number | null;
  day: string;
  date: string;
  start: string;
  end: string;
};

export function parseSitting(line: string): Sitting | null {
  const m = DATE_TIME.exec(line);
  if (!m) return null;

  const head = line.slice(0, m.index);
  // Enrollment is the last number before the timestamp.
  const enrolled = /(\d+)\s*$/.exec(head);
  const identity = enrolled ? head.slice(0, enrolled.index) : head;

  const subject = /^([A-Z]{2,5})\s/.exec(identity)?.[1] ?? null;
  const course = /(?:^|\s)(\d{5}[A-Z]*)(?:\s|$)/.exec(identity)?.[1] ?? null;
  // A section label follows the course number: "BLK  A", "[Dist]", "001".
  const section = course
    ? (identity.split(course)[1] ?? "").trim().split(/\s{2,}/)[0]?.trim() || null
    : null;

  return {
    subject,
    course,
    section,
    enrolled: enrolled ? Number(enrolled[1]) : null,
    day: m[1],
    date: m[2],
    start: m[3],
    end: m[4],
  };
}

/**
 * Read the room out of a line.
 *
 * The report is fixed-width: Room, then Cap, then ExCap. Because a building
 * name may be one or two words and may or may not carry a room number, the
 * columns cannot be recovered by guessing at tokens — "Hiler Thtr 329" is a
 * two-word building whose 329 is a capacity, while "WTHR 200" is a building
 * and a room. Dropping the two trailing integer columns is unambiguous.
 */
export function parseRoom(segment: string): string | null {
  const room = segment
    .replace(/\s+\d{1,5}\s+\d{1,5}\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
  // A room needs a building; a lone number is a stray capacity column.
  return /[A-Za-z]/.test(room) ? room : null;
}

// Where the Room column begins. Taken from the report's own header rather than
// hard-coded, so a layout change is detected instead of silently mis-sliced.
const DEFAULT_ROOM_COLUMN = 102;

function roomColumn(lines: string[]): number {
  const header = lines.find((l) => /Subject\s+Course\s+Section/.test(l));
  const index = header?.indexOf("Room") ?? -1;
  return index > 0 ? index : DEFAULT_ROOM_COLUMN;
}

// The report paginates, repeating its header and printing a footer. Neither is
// a room, and both sit in the same columns as the continuation lines.
const PAGE_FURNITURE = /^\s*(Page\s+\d+|UniTime|Subject\s+Course|-{5,}|={5,}|\(.*Continued\)|(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{2}\/\d{2},)/i;

/**
 * Attribute every timestamped row to the course that owns it.
 *
 * Separated from fetching so the rule can be tested directly: the report prints
 * a subject once per block and a course number once per course, so both are
 * carried forward across rows that omit them. Losing track of either files one
 * course's exam under another — the worst failure this tool can produce,
 * because a wrong date still looks like an answer.
 */
export function attributeExams(lines: string[], column = roomColumn(lines)): Exam[] {
  const exams: Exam[] = [];
  let subject: string | null = null;
  let course: string | null = null;
  let section: string | null = null;

  for (const line of lines) {
    if (PAGE_FURNITURE.test(line)) continue;

    const sitting = parseSitting(line);
    if (sitting) {
      if (sitting.subject) subject = sitting.subject;
      if (sitting.course) {
        course = sitting.course;
        section = sitting.section;
      }
      // A timestamped row before any course has been named cannot be attributed.
      if (!subject || !course) continue;

      const room = parseRoom(line.slice(column));
      exams.push({
        subject,
        course,
        section: section ?? "",
        enrolled: sitting.enrolled,
        day: sitting.day,
        date: sitting.date,
        start: sitting.start,
        end: sitting.end,
        rooms: room ? [room] : [],
      });
      continue;
    }

    // An additional room for the sitting already described: every identifying
    // column is blank.
    if (line.slice(0, column).trim() === "" && exams.length) {
      const room = parseRoom(line.slice(column));
      const last = exams[exams.length - 1];
      if (room && !last.rooms.includes(room)) last.rooms.push(room);
    }
  }
  return exams;
}

async function allExams(campus: Campus, kind: "evening" | "final"): Promise<Exam[]> {
  const lines = await pdfLines(campus, kind);
  return attributeExams(lines);
}

/** The PDF prints MM/DD without a year; infer the one that keeps it near today. */
function toISO(date: string, reference = new Date()): string {
  const [month, day] = date.split("/").map(Number);
  const year = reference.getFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => new Date(y, month - 1, day));
  const best = candidates.reduce((a, b) =>
    Math.abs(b.getTime() - reference.getTime()) < Math.abs(a.getTime() - reference.getTime()) ? b : a,
  );
  return `${best.getFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysUntil(iso: string, reference = new Date()): number {
  const target = new Date(`${iso}T00:00:00`);
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function describe(exam: Exam): string {
  const iso = toISO(exam.date);
  const left = daysUntil(iso);
  const when = left < 0 ? `${Math.abs(left)}d ago` : left === 0 ? "today" : `in ${left}d`;
  const where = exam.rooms.length ? ` · ${exam.rooms.join(", ")}` : "";
  const section = exam.section ? ` ${exam.section}` : "";
  return `${exam.subject} ${exam.course}${section} — ${exam.day} ${iso} ${exam.start}-${exam.end} (${when})${where}`;
}

export function registerExamTools(server: McpServer) {
  server.registerTool(
    "course_exams",
    {
      title: "Exam dates for a Purdue course",
      description:
        "Scheduled evening and final exam dates, times, and rooms for a course, with days remaining. Evening exams are the mid-semester ones held outside class time; finals are the end-of-term block. Use this to plan what to study next. Source: Purdue Registrar exam schedule PDFs.",
      inputSchema: {
        subject: z.string().describe("Subject abbreviation, e.g. MA, CS, PHYS"),
        number: z.string().describe("Course number, e.g. 26100"),
        kind: z.enum(["evening", "final", "both"]).optional(),
        campus: z.enum(["PWL", "PIN"]).optional(),
      },
    },
    async ({ subject, number, kind, campus }): Promise<ToolResult> => {
      const site = (campus ?? "PWL") as Campus;
      const want = kind ?? "both";
      const kinds: ("evening" | "final")[] =
        want === "both" ? ["evening", "final"] : [want];

      const sections: string[] = [];
      for (const k of kinds) {
        const exams = (await allExams(site, k)).filter(
          (e) =>
            e.subject === subject.toUpperCase().trim() &&
            e.course.replace(/[A-Z]+$/, "") === number.trim(),
        );
        if (exams.length) {
          sections.push(`${k === "evening" ? "Evening exams" : "Final exam"}:\n` +
            exams.map((e) => `  ${describe(e)}`).join("\n"));
        }
      }

      if (!sections.length) {
        return text(
          `No scheduled ${want === "both" ? "" : want + " "}exams found for ${subject.toUpperCase()} ${number} at ${CAMPUSES[site]}. ` +
            `Courses without evening exams appear only in the final exam schedule, and the final schedule is published later in the term.`,
        );
      }
      return text(`${subject.toUpperCase()} ${number} — ${CAMPUSES[site]}\n\n${sections.join("\n\n")}`);
    },
  );

  server.registerTool(
    "upcoming_exams",
    {
      title: "Upcoming Purdue exams",
      description:
        "Every exam in the next N days across the published schedule, soonest first. Optionally filter to a set of courses you are enrolled in. Useful for answering what to study now during midterm season. Source: Purdue Registrar exam schedule PDFs.",
      inputSchema: {
        days: z.number().int().min(1).max(120).optional(),
        courses: z
          .array(z.string())
          .optional()
          .describe('Restrict to these courses, e.g. ["MA 26100", "CS 18000"]'),
        kind: z.enum(["evening", "final", "both"]).optional(),
        campus: z.enum(["PWL", "PIN"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ days, courses, kind, campus, limit }): Promise<ToolResult> => {
      const site = (campus ?? "PWL") as Campus;
      const horizon = days ?? 30;
      const want = kind ?? "both";
      const kinds: ("evening" | "final")[] = want === "both" ? ["evening", "final"] : [want];

      const wanted = (courses ?? []).map((c) => c.toUpperCase().replace(/\s+/g, " ").trim());
      const rows: { iso: string; line: string }[] = [];

      for (const k of kinds) {
        for (const exam of await allExams(site, k)) {
          const iso = toISO(exam.date);
          const left = daysUntil(iso);
          if (left < 0 || left > horizon) continue;
          const label = `${exam.subject} ${exam.course.replace(/[A-Z]+$/, "")}`;
          if (wanted.length && !wanted.includes(label)) continue;
          rows.push({ iso, line: `${describe(exam)}  [${k}]` });
        }
      }

      if (!rows.length) {
        return text(
          `No exams scheduled in the next ${horizon} days${wanted.length ? ` for ${wanted.join(", ")}` : ""} at ${CAMPUSES[site]}.`,
        );
      }

      // One course can hold several rows (multiple sections or rooms); keeping
      // them distinct would bury the schedule in near-duplicates.
      const seen = new Set<string>();
      const unique = rows
        .sort((a, b) => a.iso.localeCompare(b.iso))
        .filter((r) => {
          const key = r.line.split("—")[0] + r.iso;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, limit ?? 50);

      return text(
        `Exams in the next ${horizon} days — ${CAMPUSES[site]}\n\n` +
          unique.map((r) => `  ${r.line}`).join("\n"),
      );
    },
  );

  server.registerTool(
    "exam_schedule_status",
    {
      title: "Exam schedule freshness",
      description:
        "What the published exam schedules currently contain: term, row counts, and date range. Use to confirm the schedule for a term has been posted before trusting an empty result. Source: Purdue Registrar exam schedule PDFs.",
      inputSchema: { campus: z.enum(["PWL", "PIN"]).optional() },
    },
    async ({ campus }): Promise<ToolResult> => {
      const site = (campus ?? "PWL") as Campus;
      const parts: string[] = [`Exam schedules — ${CAMPUSES[site]}`];

      for (const k of ["evening", "final"] as const) {
        try {
          const lines = await pdfLines(site, k);
          const exams = await allExams(site, k);
          const header = lines.find((l) => /Fall|Spring|Summer|Winter/.test(l)) ?? "";
          const term = /((?:Fall|Spring|Summer|Winter)\s+\d{4})/.exec(header)?.[1] ?? "term not stated";
          const dates = [...new Set(exams.map((e) => toISO(e.date)))].sort();
          parts.push(
            `\n${k === "evening" ? "Evening" : "Final"}: ${exams.length} exams · ${term}` +
              (dates.length ? `\n  ${dates[0]} → ${dates[dates.length - 1]}` : "\n  no dated rows"),
          );
        } catch (error) {
          parts.push(`\n${k}: unavailable (${(error as Error).message})`);
        }
      }
      return text(parts.join("\n"));
    },
  );
}
