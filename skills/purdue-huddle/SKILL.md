---
name: purdue-huddle
description: Use when Purdue student-club events from Huddle (gethuddle.social) are stale, missing, or the huddle_events tool says its copy was pulled hours ago — this sets up or refreshes the local copy that purdue-mcp reads. Triggers on "refresh huddle", "huddle events are old", "set up purdue-mcp huddle", "no huddle events showing", "purdue-mcp-huddle".
---

# Keeping Huddle events fresh

## Why this needs setting up at all

Every other source in `purdue-mcp` is fetched live. Huddle cannot be, and the
reason is worth understanding before you debug it:

`gethuddle.social` sits behind Vercel's bot challenge. Every plain HTTP client —
`curl`, `fetch`, the MCP server itself — gets `429` with
`x-vercel-mitigated: challenge`, whatever headers it sends. A real browser
clears the challenge in about a second **on a normal home or campus
connection**, and never clears it from a datacenter address. That was measured,
not assumed: the same headless Chrome passed on a laptop and sat on "Vercel
Security Checkpoint" indefinitely from a VPS.

So there is no server anyone can run that stays fresh. The fetch has to happen
on a machine like yours, which means you run it.

## Setup

One command, using a Chrome/Chromium/Edge/Brave you already have:

```bash
npx -y purdue-mcp-huddle
```

It writes `~/.cache/purdue-mcp/huddle-purdue.json` (~1.7 MB, about 2,600
events) and `huddle_events` picks it up on the next call. Takes ~4 seconds.

Nothing is installed as a service, nothing runs in the background, and no
browser profile or login is touched — it launches a throwaway profile,
reads the public events API from inside the page, and exits.

## Keeping it current

New flyers appear daily, so a copy from last week will miss this week's
callouts. Pick whichever fits the machine:

```bash
# cron (Linux/macOS)
crontab -e
7,37 * * * * npx -y purdue-mcp-huddle --quiet
```

```bash
# systemd user timer (Linux) — survives reboots, catches up after suspend
# Use OnCalendar, not OnUnitActiveSec: the monotonic clock stops while a
# laptop sleeps, so an interval timer silently drifts by the length of
# every nap.
```

On a laptop that sleeps a lot, running it by hand when you actually want
events is honestly fine — the tool always tells you how old its copy is.

## Options

| Flag / variable | Effect |
| --- | --- |
| `--out <path>` | Write somewhere else. Pair with `PURDUE_MCP_HUDDLE_MIRROR`. |
| `--college <name>` | Another Huddle campus. Default `Purdue University`. |
| `--quiet` | Errors only, for cron. |
| `PURDUE_MCP_CHROME` | Path to a browser, if it is somewhere unusual. |
| `PURDUE_MCP_HUDDLE_MIRROR` | Where `huddle_events` reads from — a file path or a URL. Overrides the local copy, so a club or a household can share one file. |

## When it goes wrong

**"No Chrome, Chromium, Edge or Brave found."** Firefox cannot be used at all —
it does not speak the DevTools protocol. Install any Chromium-family browser, or
point `PURDUE_MCP_CHROME` at one you have.

**"…is a sandboxed (flatpak/snap) browser and did not respond."** Those wrappers
start the browser inside their own sandbox and hand automation an unreliable
debug channel — it may work once and hang the next time. Use a normally
installed browser instead.

**"the page never finished loading… Security Checkpoint."** This connection's IP
is being challenged. Almost always a VPN, a cloud shell, or a datacenter host.
Turn the VPN off, or run it from a normal connection.

**Results still look old.** `huddle_events` caches for 10 minutes in-process,
and its footer states the age of the copy it used. If that age is not dropping
after a refresh, check that the refresher wrote where the tool is reading —
`PURDUE_MCP_HUDDLE_MIRROR` beats the default location.

**Nothing set up at all?** `huddle_events` still answers, from a shared copy in
the package's repo. It is refreshed by hand and often stale, and the tool says
so in every response.
