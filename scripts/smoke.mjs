#!/usr/bin/env node
// Live smoke test: spawns the built server over stdio and calls every tool
// against the real upstreams. No mocks — this is the verification step.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname] }),
);

const { tools } = await client.listTools();
console.log(`registered tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

const calls = [
  ["dining_locations", { open_now: false }],
  ["dining_nearby", { place: "PMU", limit: 3 }],
  ["dining_nearby", { place: "Beering", payment: "dining dollars", limit: 2 }],
  ["dining_menu", { location: "Wiley", meal: "Lunch" }],
  ["dining_find_item", { query: "chicken" }],
  ["dining_line_length", {}],
  ["list_terms", { limit: 5 }],
  ["list_subjects", { query: "computer" }],
  ["search_courses", { subject: "CS", number: "180" }],
  ["course_sections", { subject: "CS", number: "18000" }],
  ["find_building", { query: "LWSN" }],
  ["search_events", { days: 14, limit: 3 }],
  ["search_student_orgs", { query: "robotics", limit: 3 }],
  ["search_student_orgs", { category: "Gaming", limit: 3 }],
  ["search_student_orgs", { query: "a cappella", limit: 2, include_links: true }],
  ["student_org_profile", { org: "Boiler Blockchain", events: 2 }],
  ["student_org_profile", { org: "https://boilerlink.purdue.edu/organization/boilerblockchain", events: 0 }],
  ["search_club_events", { limit: 3 }],
  ["search_club_events", { perk: "free food", days: 30, limit: 3 }],
  ["search_club_events", { perk: "free stuff", days: 30, limit: 2 }],
  ["search_club_events", { category: "Callout", days: 30, limit: 3 }],
  ["search_club_events", { theme: "Social", limit: 2 }],
  ["boilerlink_categories", {}],
  ["huddle_events", { days: 30, limit: 3 }],
  ["huddle_events", { query: "free food", days: 60, limit: 2 }],
  ["huddle_events", { tag: "Free Food", days: 60, limit: 2 }],
  ["huddle_events", { query: "diwali", past: true, limit: 2 }],
  ["campus_weather", { periods: 2 }],
  ["banner_terms", {}],
  ["course_availability", { subject: "CS", number: "18000", open_only: true, limit: 4 }],
  ["section_details", { crn: "26043" }],
  ["reddit_purdue", { limit: 3 }],
  ["purdue_exponent", { limit: 3 }],
  ["recwell_occupancy", { sort: "busiest" }],
  ["library_hours", {}],
  ["athletics_sports", {}],
  ["athletics_schedule", { sport: "Football", upcoming_only: true }],
  ["athletics_upcoming", { days: 60, limit: 3 }],
  ["purdue_news", { limit: 2 }],
  ["academic_calendar", {}],
  ["bus_routes", {}],
  ["bus_stops", { query: "Purdue Memorial Union" }],
  ["bus_next_departures", { stop: "Purdue Memorial Union (PMU) on MD Blvd", limit: 5 }],
];

let failures = 0;
for (const [name, args] of calls) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const body = res.content.map((c) => c.text).join("\n");
    const flag = res.isError ? "ERR " : "ok  ";
    if (res.isError) failures++;
    console.log(`--- ${flag}${name} ${JSON.stringify(args)}`);
    console.log(body.split("\n").slice(0, 8).join("\n"));
    console.log(body.length > 400 ? `… (${body.length} chars)\n` : "");
  } catch (e) {
    failures++;
    console.log(`--- THREW ${name}: ${e.message}\n`);
  }
}

// BoilerLink: a website key only resolves through the by-key endpoint, and the
// event id has to survive the round trip from a search result into the detail
// tool. Both are silent-wrong-answer bugs, not errors, so assert on them.
const call = async (name, args) =>
  (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");

const byUrl = await call("student_org_profile", {
  org: "https://boilerlink.purdue.edu/organization/boilerblockchain",
  events: 0,
});
if (!/^Boiler Blockchain/.test(byUrl)) {
  failures++;
  console.log(`--- FAIL org URL resolved to: ${byUrl.split("\n")[0]}`);
} else {
  console.log("--- ok  org URL/website key resolves to the right org\n");
}

const listing = await call("search_club_events", { limit: 5 });
const eventId = /boilerlink\.purdue\.edu\/event\/(\d+)/.exec(listing)?.[1];
if (!eventId) {
  failures++;
  console.log("--- FAIL search_club_events returned no event link to follow");
} else {
  const detail = await call("club_event_details", { event: eventId });
  console.log(`--- ok  club_event_details ${eventId}`);
  console.log(detail.split("\n").slice(0, 8).join("\n"));
  console.log("");
  if (!detail.includes(eventId)) {
    failures++;
    console.log("--- FAIL club_event_details returned a different event");
  }
}

// The local index is the whole reason org search stopped being BoilerLink's
// keyword OR. These three are exactly what upstream gets wrong: a typo returns
// nothing, "rock climbing" ranks Rock Band with the climbing clubs, and a
// club's Instagram is not in the search index at all.
const typo = await call("search_student_orgs", { query: "robotcs", limit: 5 });
if (!/Robot/i.test(typo)) {
  failures++;
  console.log(`--- FAIL typo query found no robotics clubs:\n${typo.split("\n")[0]}`);
} else {
  console.log("--- ok  typo 'robotcs' still finds the robotics clubs\n");
}

const phrase = await call("search_student_orgs", { query: "rock climbing", limit: 5 });
const climbAt = phrase.indexOf("Climbing Club");
const rockBandAt = phrase.indexOf("Music Gaming");
if (climbAt < 0 || (rockBandAt >= 0 && rockBandAt < climbAt)) {
  failures++;
  console.log("--- FAIL 'rock climbing' did not rank a climbing club first");
} else {
  console.log("--- ok  'rock climbing' ranks climbing clubs above Rock Band\n");
}

const withLinks = await call("search_student_orgs", {
  query: "a cappella",
  limit: 3,
  include_links: true,
});
if (!/instagram\.com/i.test(withLinks)) {
  failures++;
  console.log("--- FAIL include_links returned no socials");
} else {
  console.log("--- ok  include_links returns email/website/socials\n");
}

// Payment is derived from the category, not published by HFS, and getting it
// wrong sends someone to a counter their swipe will not cover. On-the-GO! reads
// like a swipe exchange and is retail.
const read = async (args) =>
  (await client.callTool({ name: "dining_nearby", arguments: { place: "PMU", limit: 12, ...args } }))
    .content.map((c) => c.text).join("\n");
const swipe = await read({ payment: "meal swipe" });
const dollars = await read({ payment: "dining dollars" });
const wrong = [];
if (!/Dining Courts/.test(swipe)) wrong.push("no dining court on a swipe");
if (/On-the-GO!|Quick Bites/.test(swipe)) wrong.push("retail listed under meal swipe");
if (!/On-the-GO!/.test(dollars)) wrong.push("On-the-GO! missing from dining dollars");
if (/Dining Courts/.test(dollars)) wrong.push("dining court listed under dining dollars");
if (wrong.length) {
  failures++;
  console.log(`--- FAIL payment split: ${wrong.join("; ")}`);
} else {
  console.log("--- ok  payment split: courts take a swipe, everything else is dining dollars");
}

await client.close();
console.log(failures ? `\n${failures} failing tool call(s)` : "\nall tool calls returned data");
process.exit(failures ? 1 : 0);
