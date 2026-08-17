#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDining } from "./sources/dining.js";
import { registerCourses } from "./sources/courses.js";
import { registerEvents } from "./sources/events.js";
import { registerWeather } from "./sources/weather.js";

const server = new McpServer(
  { name: "purdue-mcp", version: "0.1.0" },
  {
    instructions: [
      "Public, real-time Purdue University (West Lafayette) data in one place.",
      "",
      "Dining: dining_locations, dining_menu, dining_find_item, dining_item_nutrition, dining_line_length.",
      "Academics: list_terms, list_subjects, search_courses, course_sections, find_building.",
      "Campus life: search_events (official calendar), search_student_orgs and search_club_events (BoilerLink).",
      "Environment: campus_weather.",
      "",
      "All data is public and unauthenticated. Nothing here reads a student account,",
      "grades, schedules, or any other private record. Dates default to the current",
      "day in the campus timezone (America/Indiana/Indianapolis).",
    ].join("\n"),
  },
);

registerDining(server);
registerCourses(server);
registerEvents(server);
registerWeather(server);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("purdue-mcp failed to start:", err);
  process.exit(1);
});
