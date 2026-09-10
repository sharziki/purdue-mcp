#!/usr/bin/env node
/**
 * `purdue-mcp-huddle` — refresh your own copy of the Huddle event corpus.
 *
 * Huddle is behind Vercel's bot challenge, which no plain HTTP client clears
 * and which refuses datacenter IPs outright — so the fetch has to happen in a
 * real browser, on a normal connection, which means yours. This writes the
 * result where `huddle_events` looks for it. Nothing runs unless you run it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchInPage, NoBrowserError } from "./lib/browser.js";
import { DEFAULT_CACHE, EVENTS_PAGE, eventsApi, toMirror, type RawEvent } from "./lib/huddle.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "purdue-mcp-huddle — refresh the Huddle event corpus for purdue-mcp",
      "",
      "  --out <path>       where to write it (default: " + DEFAULT_CACHE + ")",
      "  --college <name>   default: Purdue University",
      "  --quiet            only print errors",
      "",
      "Run it again whenever you want fresher flyers. To keep it current, put it",
      "on a schedule — see the purdue-huddle skill, or:",
      "",
      "  crontab -e   →   7,37 * * * * npx -y purdue-mcp-huddle --quiet",
    ].join("\n"),
  );
  process.exit(0);
}

const college = flag("college", "Purdue University")!;
const out = flag("out", DEFAULT_CACHE)!;
const quiet = args.includes("--quiet");
const log = (msg: string) => !quiet && console.log(msg);

/** A corpus this small means the scrape half-failed; do not overwrite with it. */
const MIN_EVENTS = 200;

try {
  log(`fetching ${college} events from ${EVENTS_PAGE} …`);
  const raw = await fetchInPage<RawEvent[]>(EVENTS_PAGE, eventsApi(college), {
    ready: /Huddle/i,
    onStatus: log,
  });

  if (!Array.isArray(raw)) throw new Error(`expected an array, got ${typeof raw}`);
  if (raw.length < MIN_EVENTS) {
    throw new Error(`only ${raw.length} events — refusing to overwrite with a thin corpus`);
  }

  const mirror = toMirror(raw, college);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(mirror)}\n`);
  log(`wrote ${out}`);
  log(`${mirror.count} events · huddle_events will use this now`);
} catch (e) {
  const err = e as Error;
  console.error(`purdue-mcp-huddle: ${err.message}`);
  if (err instanceof NoBrowserError) {
    console.error("huddle_events still works — it falls back to the shared mirror, which may be stale.");
  }
  process.exit(1);
}
