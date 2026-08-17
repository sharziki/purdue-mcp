# Installing purdue-mcp

This file is written to be handed to a coding agent verbatim. It is self-contained:
an agent can follow it end to end without fetching anything else.

Stable raw URL:
`https://raw.githubusercontent.com/sharziki/purdue-mcp/main/install.md`

## What it is

`purdue-mcp` is an MCP server exposing public, real-time Purdue University (West
Lafayette) data — dining menus, live RecWell gym occupancy, the course catalog,
CityBus schedules, campus and club events, student orgs, library hours, athletics
schedules, university news, the academic calendar, and campus weather.

- npm: `purdue-mcp` · repo: https://github.com/sharziki/purdue-mcp · MIT
- Requires Node.js 20+. No API keys, no accounts, no auth of any kind.

## Install

Pick the client in use. Every command below is idempotent — safe to re-run.

### Claude Code

```bash
claude mcp add purdue -s user -- npx -y purdue-mcp@latest
```

`-s user` installs it once for every project. Drop it to scope to the current
project only. Verify with `claude mcp list` — the row should read `✔ Connected`.

### Codex CLI

```bash
codex mcp add purdue -- npx -y purdue-mcp@latest
```

Verify with `codex mcp get purdue`.

### Cursor, Claude Desktop, Windsurf, and other config-file clients

Merge this into the client's MCP config JSON (`mcpServers` object):

```json
{
  "mcpServers": {
    "purdue": {
      "command": "npx",
      "args": ["-y", "purdue-mcp@latest"]
    }
  }
}
```

Config file locations:

| Client | Path |
| --- | --- |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Merge into the existing `mcpServers` object — do not overwrite the file, other
servers are likely already configured there.

### VS Code (GitHub Copilot)

```bash
code --add-mcp '{"name":"purdue","command":"npx","args":["-y","purdue-mcp@latest"]}'
```

## Staying up to date

The `@latest` tag makes npm re-resolve the newest published version on every
launch, so the server updates itself with no action required.

The tradeoff is a registry round-trip at startup (roughly a second) and a
requirement to be online. For a faster, offline-capable setup, install globally
and drop the `npx` indirection:

```bash
npm install -g purdue-mcp
```

then use `"command": "purdue-mcp"` with no `args` — but remember to run
`npm update -g purdue-mcp` yourself to pick up new versions.

## Verify it works

Restart the client, then ask it:

> How busy is the CoRec right now?

A working install answers with live headcounts per space. Other good smoke
questions: *what's for dinner at Wiley tonight*, *when's the next bus from the
PMU*, *who teaches CS 18000 this fall*.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npx: command not found` | Node.js is missing or below v20. Install Node 20+. |
| Server appears but exposes no tools | The client cached an old process. Fully restart it, not just the window. |
| Startup times out | First run downloads the package. Raise the client's startup timeout to 30s, or `npm i -g purdue-mcp` and point at the binary directly. |
| A single tool errors, others work | An upstream Purdue endpoint is down. The tools are independent; the rest keep working. |

## Prompt to hand another agent

Paste this into any coding agent to have it install the server itself:

> Install the `purdue-mcp` MCP server for me — it provides public real-time
> Purdue University data (dining menus, live gym occupancy, courses, bus times,
> events, athletics, library hours, weather). It is on npm as `purdue-mcp`,
> needs Node 20+, and requires no API key.
>
> Detect which MCP client I'm using and register it with `npx -y
> purdue-mcp@latest` as the command — `claude mcp add purdue -s user -- npx -y
> purdue-mcp@latest` for Claude Code, `codex mcp add purdue -- npx -y
> purdue-mcp@latest` for Codex, or merge a `mcpServers.purdue` entry into the
> client's JSON config for Cursor/Claude Desktop/Windsurf (merge, don't
> overwrite). Use the `@latest` tag so it stays current. Then verify the server
> connects and tell me which tools it exposes.
>
> Full instructions: https://raw.githubusercontent.com/sharziki/purdue-mcp/main/install.md
