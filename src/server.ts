import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDining } from "./sources/dining.js";
import { registerCourses } from "./sources/courses.js";
import { registerEvents } from "./sources/events.js";
import { registerBoilerLink } from "./sources/boilerlink.js";
import { registerHuddle } from "./sources/huddle.js";
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
  "Campus life: search_events (official university calendar), purdue_news.",
  "Huddle (student-posted flyers -- callouts, free food, tryouts the calendars miss): huddle_events.",
  "BoilerLink (student orgs and their events): search_student_orgs, student_org_profile,",
  "  search_club_events, club_event_details, boilerlink_categories.",
  "  The two searches read a local index of every org and upcoming event, so they match",
  "  on meaning-ish keywords and survive typos -- ask them what someone is into.",
  "  search_student_orgs(include_links) returns email/website/Instagram; student_org_profile",
  "  has those plus the org's next events. Call boilerlink_categories for exact category names.",
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
    { name: "purdue-mcp", version: "0.5.1" },
    { instructions: INSTRUCTIONS },
  );

  registerDining(server);
  registerCourses(server);
  registerEvents(server);
  registerBoilerLink(server);
  registerHuddle(server);
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
