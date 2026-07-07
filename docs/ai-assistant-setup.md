# Connecting an AI Assistant

> **Connect an AI Assistant** — Use the PulseSync Companion MCP to let an
> assistant read only the exported data you authorize.

The Companion MCP is a small read-only server that runs on your computer
and speaks the [Model Context Protocol](https://modelcontextprotocol.io).
Any MCP-capable assistant can use it — Claude Desktop and Claude Code are
shown below, but the same config shape works elsewhere.

## What you need

- Your **endpoint URL** and **READ_TOKEN** from the [quickstart](quickstart.md).
  (Never put the INGEST_TOKEN here — the assistant should never hold a
  write credential.)
- Node.js 18+ on the machine where your assistant runs.

## Claude Desktop

Add this to your `claude_desktop_config.json`
(Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pulsesync": {
      "command": "npx",
      "args": ["-y", "pulsesync-companion-mcp"],
      "env": {
        "PULSESYNC_ENDPOINT": "https://pulsesync-worker.<your-subdomain>.workers.dev",
        "PULSESYNC_READ_TOKEN": "<your READ_TOKEN>"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the `pulsesync` server and its tools
listed.

## Claude Code

```sh
claude mcp add pulsesync \
  --env PULSESYNC_ENDPOINT=https://pulsesync-worker.<your-subdomain>.workers.dev \
  --env PULSESYNC_READ_TOKEN=<your READ_TOKEN> \
  -- npx -y pulsesync-companion-mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "pulsesync": {
      "command": "npx",
      "args": ["-y", "pulsesync-companion-mcp"],
      "env": {
        "PULSESYNC_ENDPOINT": "https://pulsesync-worker.<your-subdomain>.workers.dev",
        "PULSESYNC_READ_TOKEN": "<your READ_TOKEN>"
      }
    }
  }
}
```

## Running from a local clone instead of npx

```sh
cd pulsesync-companion-mcp/mcp
npm install
npm run build
```

Then use `"command": "node"` with
`"args": ["/path/to/pulsesync-companion-mcp/mcp/dist/index.js"]` in the
configs above.

## Available tools (all read-only)

| Tool | What it answers |
|------|-----------------|
| `pulsesync_status` | What's in the store — totals, types, date span |
| `pulsesync_recent_samples` | Raw samples by type and time range |
| `pulsesync_daily_summary` | One day's aggregated metrics |
| `pulsesync_sleep_window` | Sleep segments and totals for a night |
| `pulsesync_activity_summary` | Per-day steps/energy/exercise over a range |
| `pulsesync_subjective_logs` | Your self-reported entries |
| `pulsesync_patterns` | Descriptive per-day aggregates over N days |
| `pulsesync_export_health` | Is the pipeline alive; when data last arrived |

Every response includes the time range queried, the data's provenance, the
sample count, and an explicit note when data is too sparse to summarize
confidently — plus standing guidance that this is descriptive device data,
not medical information.

## Try asking

- "What did my sleep look like last night?"
- "Summarize my activity for the past week."
- "Is my PulseSync export still running?"

## Timezone note

Day boundaries default to UTC. Tell your assistant your timezone (or ask it
to pass `tz_offset`) if your days look shifted.
