/** West Lafayette campus timezone. Indiana observes US Eastern time. */
export const CAMPUS_TZ = "America/Indiana/Indianapolis";

/** Today on campus, as YYYY-MM-DD, regardless of where the server runs. */
export function campusToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAMPUS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Human clock time on campus, e.g. "Mon Aug 17, 6:42 PM". */
export function campusNowLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

/** Offset a YYYY-MM-DD date by N days without tripping over local time. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * A YYYY-MM-DD the calendar actually has, or null. The shape check alone is
 * not enough: "2026-13-45" passes the regex and then throws "Invalid time
 * value" out of Intl the moment anything tries to format it.
 */
export function parseCampusDate(s: string): string | null {
  if (!isDateString(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

/** "17:00:00" -> "5:00 PM" */
export function prettyTime(hms: string | null | undefined): string {
  if (!hms) return "";
  const [h, m] = hms.split(":").map(Number);
  if (Number.isNaN(h)) return hms;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m ?? 0).padStart(2, "0")} ${ampm}`;
}

/** ISO timestamp -> campus-local "Mon Aug 17, 5:00 PM" */
export function prettyStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** UTC offset for a campus date, e.g. "-04:00" — Indiana switches with DST. */
function campusOffset(date: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  return name.replace("GMT", "") || "-05:00";
}

/** A campus-local wall time on YYYY-MM-DD as a UTC ISO stamp. */
export function campusIso(date: string, time = "00:00:00"): string {
  return new Date(`${date}T${time}${campusOffset(date)}`).toISOString();
}

/** ISO timestamp -> campus-local "Nov 17, 2021" */
export function prettyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/**
 * "Thu, Sep 3, 3:00 PM – 5:00 PM", but keeps the date on the end when the
 * event runs past midnight — a semester-long event is not a two-hour one.
 */
export function stampRange(start: string, end: string | null | undefined): string {
  const from = prettyStamp(start);
  if (!end) return from;
  const sameDay = prettyDate(start) === prettyDate(end);
  return `${from} – ${sameDay ? prettyStamp(end).split(", ").pop() : prettyStamp(end)}`;
}
