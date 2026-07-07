# PulseSync Companion MCP

Optional, self-hosted infrastructure for the PulseSync iPhone + Apple Watch
app: export your health samples to **storage you control**, and (if you
choose) let an AI assistant **read** that exported data with your explicit
permission.

## What this is

- A **reference Cloudflare Worker** you deploy to your own free Cloudflare
  account. PulseSync sends samples to it; they land in your own D1 database.
- A **read-only MCP server** that lets any MCP-capable AI assistant (Claude
  Desktop, Claude Code, and others) answer questions about your exported
  data — sleep, activity, heart metrics, your own subjective logs.
- Docs written for non-developers.

## What this is NOT

- **Not required.** PulseSync works fully as a standalone local app — local
  insights and private backup need none of this.
- **Not a medical device.** Nothing here diagnoses, treats, or interprets.
  The MCP actively instructs assistants to stay descriptive and avoid
  medical or causal overclaiming.
- **Not a write path for AI.** The MCP is read-only by construction. The
  assistant never holds the write credential and cannot add, change, or
  delete your data.
- **Not anyone else's cloud.** Every component runs in your accounts, under
  your tokens, deletable by you at any time.

## Two paths

1. **Default:** install PulseSync, use it locally. Done. This repository is
   irrelevant to you.
2. **Advanced Export (this repo):** deploy the Worker, paste its URL and an
   ingest token into the app, and optionally connect an assistant through
   the Companion MCP using a *separate* read token.

> **Advanced Export** — Send PulseSync samples to storage you control. This
> is optional and not required for local insights or private cloud backup.
> You'll need a Worker endpoint URL and bearer auth token.

> **Connect an AI Assistant** — Use the PulseSync Companion MCP to let an
> assistant read only the exported data you authorize.

## Architecture

```
┌──────────────────┐   POST /v1/ingest    ┌──────────────────┐
│  PulseSync app   │   Bearer INGEST_TOKEN│  YOUR Cloudflare │
│  (iPhone+Watch)  ├─────────────────────►│  Worker          │
└──────────────────┘   (write plane)      └────────┬─────────┘
                                                   │
                                                   ▼
                                          ┌──────────────────┐
                                          │  YOUR D1 database│
                                          │  (samples table) │
                                          └────────┬─────────┘
                                                   │ GET /v1/query/*
                                                   │ Bearer READ_TOKEN
                                                   │ (read plane)
┌──────────────────┐      stdio (MCP)     ┌────────┴─────────┐
│  Your AI         │◄────────────────────►│  Companion MCP   │
│  assistant       │                      │  (read-only)     │
└──────────────────┘                      └──────────────────┘
```

Two separate secrets keep the planes apart: the app holds only the write
key; the assistant holds only the read key. Neither can do the other's job.

## Get started

1. **[Deploy your endpoint](docs/quickstart.md)** — ~15 minutes, copy-paste
   commands, free tier.
2. **[Point the app at it](docs/pulsesync-app-settings.md)**.
3. **[Connect an assistant](docs/ai-assistant-setup.md)** (optional).
4. Read **[privacy and consent](docs/privacy-and-consent.md)** — who sees
   what, and how to revoke anything.

Verify a deployment any time:

```sh
node scripts/validate-deploy.mjs https://<your-endpoint> --ingest-token ... --read-token ...
```

## Repository layout

```
worker/    Reference Cloudflare Worker (TypeScript): ingest + read API + D1 schema
mcp/       Companion MCP server (TypeScript, Node, stdio)
scripts/   validate-deploy.mjs — post-deploy sanity checks
docs/      Quickstart, app settings, assistant setup, privacy
```

## Roadmap

- Remote (HTTP) MCP transport, so assistants can connect without a local
  Node process. The server is stdio-first today.
- Additional read aggregations as PulseSync's sample types grow.

## License

[MIT](LICENSE) © 2026 Velastrae Labs
