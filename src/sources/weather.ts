import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJSON } from "../lib/http.js";
import { campusNowLabel, prettyStamp } from "../lib/time.js";
import { text, type ToolResult } from "../lib/result.js";

// Purdue Memorial Mall, West Lafayette IN. NWS API is public and unauthenticated.
const CAMPUS = "40.4237,-86.9212";
const NWS = "https://api.weather.gov";

type Points = {
  properties: {
    forecast: string;
    forecastHourly: string;
    observationStations: string;
    relativeLocation: { properties: { city: string; state: string } };
  };
};

async function points(): Promise<Points["properties"]> {
  const d = await getJSON<Points>(`${NWS}/points/${CAMPUS}`, { ttlMs: 24 * 60 * 60_000 });
  return d.properties;
}

const c2f = (c: number | null | undefined) =>
  c === null || c === undefined ? null : Math.round((c * 9) / 5 + 32);

export function registerWeather(server: McpServer) {
  server.registerTool(
    "campus_weather",
    {
      title: "Purdue campus weather",
      description:
        "Current conditions and forecast for the Purdue West Lafayette campus, plus any active severe-weather alerts. Source: NOAA/NWS api.weather.gov (live).",
      inputSchema: {
        hourly: z
          .boolean()
          .optional()
          .describe("Return hour-by-hour instead of day/night periods."),
        periods: z.number().int().min(1).max(24).optional().describe("How many periods. Default 4."),
      },
    },
    async ({ hourly, periods }): Promise<ToolResult> => {
      const p = await points();
      const n = periods ?? 4;

      const [obsRes, fcRes, alertRes] = await Promise.allSettled([
        (async () => {
          const stations = await getJSON<{ features: { properties: { stationIdentifier: string } }[] }>(
            p.observationStations,
            { ttlMs: 24 * 60 * 60_000 },
          );
          const id = stations.features?.[0]?.properties?.stationIdentifier;
          if (!id) return null;
          return getJSON<{
            properties: {
              timestamp: string;
              textDescription: string;
              temperature: { value: number | null };
              windSpeed: { value: number | null };
              relativeHumidity: { value: number | null };
            };
          }>(`${NWS}/stations/${id}/observations/latest`, { ttlMs: 5 * 60_000 });
        })(),
        getJSON<{
          properties: {
            periods: {
              name: string;
              startTime: string;
              temperature: number;
              temperatureUnit: string;
              windSpeed: string;
              shortForecast: string;
              detailedForecast: string;
              probabilityOfPrecipitation?: { value: number | null };
            }[];
          };
        }>(hourly ? p.forecastHourly : p.forecast, { ttlMs: 15 * 60_000 }),
        getJSON<{ features: { properties: { event: string; headline: string; ends: string | null } }[] }>(
          `${NWS}/alerts/active?point=${CAMPUS}`,
          { ttlMs: 5 * 60_000 },
        ),
      ]);

      const out: string[] = [`West Lafayette / Purdue campus — ${campusNowLabel()}`];

      if (obsRes.status === "fulfilled" && obsRes.value) {
        const o = obsRes.value.properties;
        const t = c2f(o.temperature.value);
        const wind = o.windSpeed.value === null ? null : Math.round(o.windSpeed.value * 0.621371);
        out.push(
          `\nNow: ${o.textDescription || "—"}${t !== null ? `, ${t}°F` : ""}` +
            `${o.relativeHumidity?.value ? `, ${Math.round(o.relativeHumidity.value)}% humidity` : ""}` +
            `${wind !== null ? `, wind ${wind} mph` : ""}` +
            ` (observed ${prettyStamp(o.timestamp)})`,
        );
      }

      if (alertRes.status === "fulfilled" && alertRes.value.features?.length) {
        out.push("\nACTIVE ALERTS:");
        for (const f of alertRes.value.features)
          out.push(
            `  ⚠ ${f.properties.event} — ${f.properties.headline}${f.properties.ends ? ` (until ${prettyStamp(f.properties.ends)})` : ""}`,
          );
      }

      if (fcRes.status === "fulfilled") {
        out.push("\nForecast:");
        for (const per of fcRes.value.properties.periods.slice(0, n)) {
          const pop = per.probabilityOfPrecipitation?.value;
          out.push(
            `  ${hourly ? prettyStamp(per.startTime) : per.name}: ${per.temperature}°${per.temperatureUnit}, ` +
              `${per.shortForecast}, wind ${per.windSpeed}${pop ? `, ${pop}% precip` : ""}`,
          );
        }
      } else {
        out.push("\nForecast unavailable from NWS right now.");
      }

      return text(out.join("\n"));
    },
  );
}
