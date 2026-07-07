# Privacy and Consent

Health data is intimate. This page states plainly who can see what, and how
you turn any of it off.

## The core principle: you own the storage

With Advanced Export, PulseSync sends your samples to **your** Cloudflare
account — a Worker and database that you created, that you pay for (free
tier for personal volumes), and that you can delete at any moment. There is
no PulseSync cloud in this path. Nobody else operates the endpoint. No data
passes through anyone else's servers on the way there.

## Nothing is shared without explicit setup

- Advanced Export is **off by default**. The app works fully without it.
- Connecting an AI assistant requires a second, separate, deliberate setup
  step (installing the Companion MCP and giving it your read token).
- There is no automatic sharing, no analytics pipeline, no third-party
  destination. Each hop exists only because you configured it.

## Two keys, two jobs

| Key | Who holds it | What it can do |
|-----|--------------|----------------|
| **INGEST_TOKEN** | The PulseSync app on your phone | Write new samples. Nothing else. |
| **READ_TOKEN** | Your AI assistant's MCP config | Read samples and summaries. Nothing else. |

The AI assistant **never sees the write credential**. It cannot add, alter,
or delete your data. The Companion MCP is read-only by construction — it
contains no write code paths at all.

## What the assistant sees

Only what the read token exposes: the samples you exported and aggregate
summaries of them. The assistant sees data **only when you ask it a
question that requires reading it**, and every response is labeled with the
time range and source so you can see exactly what was accessed.

## Revoking access

Every grant is reversible, immediately:

- **Cut off the assistant:** rotate the read key —
  `npx wrangler secret put READ_TOKEN` — or remove the MCP entry from your
  assistant's config. The old key stops working the moment the new one is set.
- **Stop exporting:** turn off Advanced Export in the app, or rotate
  INGEST_TOKEN.
- **Delete everything:** `npx wrangler d1 delete pulsesync` erases the
  database; `npx wrangler delete` removes the Worker. Gone means gone —
  it was only ever in your account.

## What this is not

- **Not a medical device.** The data is consumer-sensor and self-reported
  information. The MCP explicitly instructs assistants not to diagnose,
  prescribe, or overclaim causes.
- **Not a backup guarantee.** Your endpoint is one copy that you manage.
- **Not telemetry.** This repository's code sends data only where you point
  it, and logs only status codes and counts — never tokens, never health
  values.
