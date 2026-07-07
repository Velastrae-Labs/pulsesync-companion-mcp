# Quickstart — Deploy Your Own Export Endpoint

This guide gets you from zero to a working, private export endpoint in about
15 minutes. You do **not** need to be a developer — every command is
copy-paste, and each step tells you what to expect.

> **Do I need this?** Only if you want PulseSync's **Advanced Export** —
> sending your samples to storage you control, optionally readable by an AI
> assistant. PulseSync works fully as a local app without any of this.

## What you'll end up with

- A free Cloudflare account running a tiny "Worker" (a small program) and a
  "D1" database — both owned entirely by you.
- An **endpoint URL** and an **ingest token** to paste into the PulseSync app.
- A separate **read token** for connecting an AI assistant later (optional).

Cloudflare's free tier is more than enough for personal health data volumes.

## Prerequisites

1. A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. [Node.js](https://nodejs.org) 18 or newer installed on your computer.
3. This repository downloaded:
   ```sh
   git clone https://github.com/Velastrae-Labs/pulsesync-companion-mcp.git
   cd pulsesync-companion-mcp/worker
   npm install
   ```

## Step 1 — Log in to Cloudflare

```sh
npx wrangler login
```

A browser window opens; approve the request. This lets the deploy tool act
on your Cloudflare account.

## Step 2 — Create the database

```sh
npx wrangler d1 create pulsesync
```

The command prints a block containing a `database_id` (a long string of
letters and numbers). **Copy it.** Open `worker/wrangler.jsonc` in any text
editor and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with your id.

## Step 3 — Create the table

```sh
npx wrangler d1 migrations apply pulsesync --remote
```

Answer **yes** when asked. This creates the `samples` table your data will
live in.

## Step 4 — Set your two secret tokens

You need two different secrets. Think of them as two different keys:

- **INGEST_TOKEN** — the *write* key. Only the PulseSync app gets this.
- **READ_TOKEN** — the *read* key. Only your AI assistant setup gets this.

Generate two long random strings (this prints one; run it twice):

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save both somewhere safe (a password manager is ideal). Then:

```sh
npx wrangler secret put INGEST_TOKEN
# paste the first random string when prompted

npx wrangler secret put READ_TOKEN
# paste the second random string when prompted
```

**Never use the same string for both.** Keeping them separate means your AI
assistant can never write to or tamper with your data.

## Step 5 — Deploy

```sh
npx wrangler deploy
```

The output includes your Worker's URL, something like:

```
https://pulsesync-worker.<your-subdomain>.workers.dev
```

That URL is your **endpoint**. Write it down alongside your two tokens.

## Step 6 — Verify it works

From the repository root:

```sh
node scripts/validate-deploy.mjs https://pulsesync-worker.<your-subdomain>.workers.dev \
  --ingest-token <your INGEST_TOKEN> \
  --read-token <your READ_TOKEN>
```

You should see all checks pass, including a dedupe check (the script sends
one clearly-marked test sample twice and confirms the second copy is
recognized as a duplicate).

## What you have now

| Item | Where it goes |
|------|---------------|
| Endpoint URL | PulseSync app **and** MCP config |
| INGEST_TOKEN | PulseSync app only — see [pulsesync-app-settings.md](pulsesync-app-settings.md) |
| READ_TOKEN | AI assistant config only — see [ai-assistant-setup.md](ai-assistant-setup.md) |

## Rotating or revoking access

At any time:

```sh
npx wrangler secret put INGEST_TOKEN   # sets a new write key; the old one stops working
npx wrangler secret put READ_TOKEN     # sets a new read key; the old one stops working
```

To shut the whole thing down: `npx wrangler delete` removes the Worker, and
`npx wrangler d1 delete pulsesync` deletes the database (and all data in it).
It's your infrastructure — you can walk away whenever you want.
