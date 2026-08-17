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
  ["search_club_events", { limit: 3 }],
  ["campus_weather", { periods: 2 }],
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

await client.close();
console.log(failures ? `\n${failures} failing tool call(s)` : "\nall tool calls returned data");
process.exit(failures ? 1 : 0);
