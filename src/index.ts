#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDining } from "./sources/dining.js";
import { registerCourses } from "./sources/courses.js";
import { registerEvents } from "./sources/events.js";
import { registerWeather } from "./sources/weather.js";
import { registerRecreation } from "./sources/recreation.js";
import { registerLibraries } from "./sources/libraries.js";
import { registerAthletics } from "./sources/athletics.js";
import { registerNews } from "./sources/news.js";
import { registerTransit } from "./sources/transit.js";
import { registerBanner } from "./sources/banner.js";
import { registerCommunity } from "./sources/community.js";

const server = new McpServer(
  { name: "purdue-mcp", version: "0.3.0" },
  {
    instructions: [
      "Public, real-time Purdue University (West Lafayette) data in one place.",
      "",
      "Dining: dining_locations, dining_menu, dining_find_item, dining_item_nutrition, dining_line_length.",
      "Academics (catalog): list_terms, list_subjects, search_courses, course_sections,",
      "  find_building, academic_calendar.",
      "Registration (LIVE seats — prefer these for 'can I get in'): course_availability,",
      "  section_details, banner_terms.",
      "Campus life: search_events (official calendar), search_student_orgs and search_club_events",
      "  (BoilerLink), purdue_news.",
      "Facilities: recwell_occupancy (live gym headcounts), library_hours.",
      "Athletics: athletics_sports, athletics_schedule, athletics_upcoming.",
      "Getting around: bus_routes, bus_stops, bus_next_departures (CityBus, scheduled times).",
      "Student voice (unofficial): reddit_purdue, purdue_exponent.",
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
registerRecreation(server);
registerLibraries(server);
registerAthletics(server);
registerNews(server);
registerTransit(server);
registerBanner(server);
registerCommunity(server);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("purdue-mcp failed to start:", err);
  process.exit(1);
});
