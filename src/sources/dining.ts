import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON } from "../lib/http.js";
import { campusNowLabel, campusToday, isDateString, prettyStamp, prettyTime } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

const BASE = "https://api.hfs.purdue.edu/menus/v2";

type Meal = {
  ID: string;
  Name: string;
  Type: string;
  StartTime: string;
  EndTime: string;
};

type Location = {
  LocationId: string;
  Name: string;
  FormalName: string;
  ShortName: string;
  Type: string;
  PhoneNumber: string | null;
  Latitude: number;
  Longitude: number;
  Url: string | null;
  Address: { Street: string; City: string; State: string; ZipCode: string };
  UpcomingMeals: Meal[];
};

type Allergen = { Name: string; Value: boolean };
type Item = {
  ID: string;
  Name: string;
  IsVegetarian: boolean;
  Allergens: Allergen[];
};
type Station = { Name: string; Items: Item[]; Notes: string | null };
type MenuMeal = {
  Name: string;
  Type: string;
  Status: string;
  Hours: { StartTime: string; EndTime: string } | null;
  Notes: string | null;
  Stations: Station[];
};
type Menu = {
  Location: string;
  Date: string;
  IsPublished: boolean;
  Notes: string | null;
  Meals: MenuMeal[];
};

async function locations(): Promise<Location[]> {
  const data = await getJSON<{ Location: Location[] }>(`${BASE}/locations`, {
    ttlMs: 10 * 60_000,
  });
  return data.Location ?? [];
}

async function menu(location: string, date: string): Promise<Menu> {
  return getJSON<Menu>(`${BASE}/locations/${encodeURIComponent(location)}/${date}`, {
    ttlMs: 5 * 60_000,
  });
}

/** Resolve a fuzzy user string ("wiley", "WILY", "earhart") to the API's location name. */
function matchLocation(all: Location[], input: string): Location | undefined {
  const q = input.trim().toLowerCase();
  return (
    all.find((l) => l.Name.toLowerCase() === q) ??
    all.find((l) => l.LocationId.toLowerCase() === q || l.ShortName?.toLowerCase() === q) ??
    all.find((l) => l.FormalName.toLowerCase() === q) ??
    all.find((l) => l.Name.toLowerCase().includes(q) || l.FormalName.toLowerCase().includes(q))
  );
}

function statusNow(loc: Location): string {
  const now = Date.now();
  const open = loc.UpcomingMeals?.find(
    (m) => new Date(m.StartTime).getTime() <= now && now <= new Date(m.EndTime).getTime(),
  );
  if (open) return `OPEN — ${open.Name} until ${prettyStamp(open.EndTime)}`;
  const next = loc.UpcomingMeals?.find((m) => new Date(m.StartTime).getTime() > now);
  return next ? `closed — next: ${next.Name} ${prettyStamp(next.StartTime)}` : "closed";
}

function dietTags(item: Item): string {
  const on = (n: string) => item.Allergens?.find((a) => a.Name === n)?.Value === true;
  const tags: string[] = [];
  if (on("Vegan")) tags.push("vegan");
  else if (on("Vegetarian") || item.IsVegetarian) tags.push("vegetarian");
  const allergens = (item.Allergens ?? [])
    .filter((a) => a.Value && !["Vegan", "Vegetarian"].includes(a.Name))
    .map((a) => a.Name);
  if (allergens.length) tags.push(`contains: ${allergens.join(", ")}`);
  return tags.length ? ` [${tags.join("; ")}]` : "";
}

function hasAllergen(item: Item, name: string): boolean {
  const n = name.trim().toLowerCase();
  return (item.Allergens ?? []).some((a) => a.Name.toLowerCase() === n && a.Value);
}

export function registerDining(server: McpServer) {
  server.registerTool(
    "dining_locations",
    {
      title: "List Purdue dining locations",
      description:
        "List every Purdue dining location (dining courts, quick bites, On-the-GO!) with whether it is open right now and the next meal period. Source: Purdue HFS dining API (live).",
      inputSchema: {
        type: z
          .enum(["Dining Courts", "Quick Bites", "On-the-GO!"])
          .optional()
          .describe("Filter to one category of location."),
        open_now: z.boolean().optional().describe("Only return locations currently serving."),
      },
    },
    async ({ type, open_now }): Promise<ToolResult> => {
      let all = await locations();
      if (type) all = all.filter((l) => l.Type === type);
      const rows = all.map((l) => ({ loc: l, status: statusNow(l) }));
      const shown = open_now ? rows.filter((r) => r.status.startsWith("OPEN")) : rows;
      if (!shown.length) return text("No dining locations match.");
      const body = shown
        .map(
          ({ loc, status }) =>
            `${loc.Name} (${loc.Type})\n  ${status}\n  ${loc.Address.Street}, ${loc.Address.City}` +
            `${loc.PhoneNumber ? ` · ${loc.PhoneNumber}` : ""}${loc.Url ? `\n  ${loc.Url}` : ""}`,
        )
        .join("\n\n");
      return text(`Campus time: ${campusNowLabel()}\n\n${body}`);
    },
  );

  server.registerTool(
    "dining_menu",
    {
      title: "Get a dining court menu",
      description:
        "Full menu for one Purdue dining location on a date, by meal period and station, with dietary tags. Source: Purdue HFS dining API (live).",
      inputSchema: {
        location: z
          .string()
          .describe("Location name or code, e.g. 'Wiley', 'Earhart', 'Hillenbrand', 'WILY'."),
        date: z.string().optional().describe("YYYY-MM-DD. Defaults to today on campus."),
        meal: z
          .string()
          .optional()
          .describe("Filter to one meal period, e.g. 'Breakfast', 'Lunch', 'Dinner', 'Late Lunch'."),
        vegetarian_only: z.boolean().optional(),
        vegan_only: z.boolean().optional(),
        exclude_allergens: z
          .array(z.string())
          .optional()
          .describe("Drop items containing any of these, e.g. ['Peanuts','Gluten','Milk']."),
      },
    },
    async ({
      location,
      date,
      meal,
      vegetarian_only,
      vegan_only,
      exclude_allergens,
    }): Promise<ToolResult> => {
      const day = date && isDateString(date) ? date : campusToday();
      const all = await locations();
      const loc = matchLocation(all, location);
      if (!loc)
        return text(
          `Unknown location "${location}". Known: ${all.map((l) => l.Name).join(", ")}`,
          true,
        );

      const m = await menu(loc.Name, day);
      if (!m.IsPublished || !m.Meals?.length)
        return text(`${loc.Name} — no published menu for ${day}.`);

      let meals = m.Meals;
      if (meal) {
        const q = meal.toLowerCase();
        meals = meals.filter((x) => x.Name.toLowerCase().includes(q));
        if (!meals.length)
          return text(
            `No meal matching "${meal}" at ${loc.Name} on ${day}. Available: ${m.Meals.map((x) => x.Name).join(", ")}`,
          );
      }

      const chunks: string[] = [`${loc.Name} — ${day}`];
      if (m.Notes) chunks.push(m.Notes);

      for (const meal of meals) {
        const hrs = meal.Hours
          ? ` (${prettyTime(meal.Hours.StartTime)}–${prettyTime(meal.Hours.EndTime)})`
          : "";
        const lines: string[] = [`\n## ${meal.Name}${hrs} — ${meal.Status}`];
        for (const st of meal.Stations ?? []) {
          const items = (st.Items ?? []).filter((it) => {
            if (vegan_only && !hasAllergen(it, "Vegan")) return false;
            if (vegetarian_only && !(hasAllergen(it, "Vegetarian") || it.IsVegetarian)) return false;
            if (exclude_allergens?.some((a) => hasAllergen(it, a))) return false;
            return true;
          });
          if (!items.length) continue;
          lines.push(`### ${st.Name}`);
          for (const it of items) lines.push(`- ${it.Name}${dietTags(it)} (id: ${it.ID})`);
        }
        if (lines.length > 1) chunks.push(lines.join("\n"));
        else chunks.push(`\n## ${meal.Name}${hrs} — no items match the filters.`);
      }
      return text(chunks.join("\n"));
    },
  );

  server.registerTool(
    "dining_find_item",
    {
      title: "Find a food item across dining courts",
      description:
        "Search every Purdue dining court's menu for a dish on a given date — answers 'who is serving chicken tenders today'. Source: Purdue HFS dining API (live).",
      inputSchema: {
        query: z.string().describe("Dish or keyword, e.g. 'chicken tenders', 'pho', 'cookie'."),
        date: z.string().optional().describe("YYYY-MM-DD. Defaults to today on campus."),
        meal: z.string().optional().describe("Restrict to a meal period, e.g. 'Dinner'."),
        include_retail: z
          .boolean()
          .optional()
          .describe("Also search Quick Bites / On-the-GO! locations. Default false."),
      },
    },
    async ({ query, date, meal, include_retail }): Promise<ToolResult> => {
      const day = date && isDateString(date) ? date : campusToday();
      const q = query.trim().toLowerCase();
      const all = await locations();
      const targets = include_retail ? all : all.filter((l) => l.Type === "Dining Courts");

      const menus = await Promise.allSettled(targets.map((l) => menu(l.Name, day)));
      const hits: string[] = [];
      menus.forEach((res, i) => {
        if (res.status !== "fulfilled") return;
        const m = res.value;
        for (const ml of m.Meals ?? []) {
          if (meal && !ml.Name.toLowerCase().includes(meal.toLowerCase())) continue;
          for (const st of ml.Stations ?? []) {
            for (const it of st.Items ?? []) {
              if (!it.Name.toLowerCase().includes(q)) continue;
              const hrs = ml.Hours
                ? `${prettyTime(ml.Hours.StartTime)}–${prettyTime(ml.Hours.EndTime)}`
                : "";
              hits.push(
                `${targets[i].Name} · ${ml.Name} ${hrs} · ${st.Name}\n  ${it.Name}${dietTags(it)} (id: ${it.ID})`,
              );
            }
          }
        }
      });

      if (!hits.length)
        return text(
          `No menu item matching "${query}" on ${day}${meal ? ` for ${meal}` : ""} at ${targets.length} location(s).`,
        );
      return text(`"${query}" on ${day} — ${hits.length} hit(s)\n\n${hits.join("\n\n")}`);
    },
  );

  server.registerTool(
    "dining_item_nutrition",
    {
      title: "Nutrition facts for a dining item",
      description:
        "Full nutrition panel for one menu item, by the item id returned from dining_menu or dining_find_item. Source: Purdue HFS dining API (live).",
      inputSchema: {
        item_id: z.string().describe("Item GUID from dining_menu / dining_find_item."),
      },
    },
    async ({ item_id }): Promise<ToolResult> => {
      const data = await getJSON<{
        Nutrition: { Name: string; LabelValue: string | null; DailyValue: string | null }[];
      }>(`${BASE}/items/${encodeURIComponent(item_id)}`, { ttlMs: 60 * 60_000 });
      if (!data.Nutrition?.length) return text(`No nutrition data for item ${item_id}.`);
      const lines = data.Nutrition.map(
        (n) => `${n.Name}: ${n.LabelValue ?? "—"}${n.DailyValue ? ` (${n.DailyValue} DV)` : ""}`,
      );
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "dining_line_length",
    {
      title: "Live dining court line lengths",
      description:
        "Crowdsourced real-time line-length reports for Purdue dining courts. Often empty outside peak hours. Source: Purdue HFS dining API (live).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const data = await getJSON<{ LineLengthReport: any[] }>(`${BASE}/linelength`, {
        ttlMs: 30_000,
      });
      const reports = data.LineLengthReport ?? [];
      if (!reports.length)
        return text(
          `No line-length reports right now (${campusNowLabel()}). This feed is crowdsourced and is usually only populated during peak meal hours.`,
        );
      return text(JSON.stringify(reports, null, 2));
    },
  );
}
