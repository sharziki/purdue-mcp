#!/usr/bin/env node
/**
 * Refresh the Huddle mirror.
 *
 * gethuddle.social sits behind Vercel's bot challenge: every plain HTTP client
 * — curl, node fetch, the MCP server itself — gets 429 with
 * `x-vercel-mitigated: challenge`, no matter the headers or the IP. Only a real
 * browser that runs the challenge script gets a 200. So the corpus is pulled
 * once here by a headless Chrome and published as a static JSON file that the
 * `huddle_events` tool can read with an ordinary fetch. robots.txt on the site
 * is `Allow: /`, and this runs twice an hour, once, for everyone.
 *
 * Run it from a residential connection: the challenge is IP-reputation gated
 * and never clears from a datacenter address, headless browser or not.
 *
 *   node scripts/huddle-mirror.mjs [--out huddle-purdue.json] [--college "Purdue University"]
 */
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const COLLEGE = arg("college", "Purdue University");
const OUT = arg("out", "huddle-purdue.json");
const SITE = "https://www.gethuddle.social";
const PAGE = `${SITE}/events/purdue`;
const API = `/api/firestore/events?college=${encodeURIComponent(COLLEGE)}`;

/** A mirror with almost nothing in it is a scrape that half-failed. */
const MIN_EVENTS = 200;

/** eventEndDate comes back as a raw Firestore timestamp on ~1% of rows. */
function iso(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.seconds === "number") {
    return new Date(v.seconds * 1000).toISOString();
  }
  return null;
}

/** Drop the fields the tool never shows: geohash, placeID, creatorID, rsvpList. */
function trim(e) {
  const out = {
    id: e.eventID || e.id,
    title: (e.eventTitle || "").trim(),
    org: (e.orgHosting || "").trim(),
    start: iso(e.eventDate),
    end: iso(e.eventEndDate),
    location: (e.eventLocation || "").trim(),
    address: (e.eventAddress || "").trim(),
    description: (e.eventDescription || "").trim(),
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
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v === "" || v === null || v === 0 || v === false || (Array.isArray(v) && !v.length)) {
      delete out[k];
    }
  }
  return out;
}

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 90_000 });

  // The challenge swaps the document out from under us when it passes; the
  // title is the cheapest signal that we are on the real page.
  await page.waitForFunction(() => /Huddle/i.test(document.title), { timeout: 90_000 }).catch(() => {});
  const title = await page.title();
  if (/checkpoint|challenge/i.test(title)) {
    throw new Error(`still on the Vercel challenge page after 90s (title: ${title})`);
  }

  const res = await page.evaluate(async (api) => {
    const r = await fetch(api, { headers: { Accept: "application/json" } });
    const body = await r.text();
    return { status: r.status, body };
  }, API);

  if (res.status !== 200) throw new Error(`upstream ${res.status}: ${res.body.slice(0, 200)}`);

  const raw = JSON.parse(res.body);
  if (!Array.isArray(raw)) throw new Error(`expected an array, got ${typeof raw}`);
  if (raw.length < MIN_EVENTS) throw new Error(`only ${raw.length} events — refusing to publish a thin mirror`);

  const events = raw
    .map(trim)
    .filter((e) => e.id && e.title && e.start)
    .sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));

  const payload = {
    source: PAGE,
    college: COLLEGE,
    fetchedAt: new Date().toISOString(),
    count: events.length,
    events,
  };
  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  console.log(`wrote ${OUT}: ${events.length} events, ${(JSON.stringify(payload).length / 1e6).toFixed(2)} MB`);
} finally {
  await browser.close();
}
