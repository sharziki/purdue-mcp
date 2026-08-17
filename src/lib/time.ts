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
