import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export const INSTRUCTIONS = [
  "Public, real-time Purdue University (West Lafayette) data in one place.",
  "",
  "Dining: dining_locations, dining_nearby, dining_menu, dining_find_item, dining_item_nutrition, dining_line_length.",
  "  dining_nearby answers 'I am at X, where should I eat' -- nearest first, with walk time and whether it takes a swipe or dining dollars.",
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
].join("\n");

/** One fully-registered server. Callers own the transport. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "purdue-mcp", version: "0.3.0" },
    { instructions: INSTRUCTIONS },
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

  return server;
}
