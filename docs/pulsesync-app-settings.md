# Connecting the PulseSync App to Your Endpoint

Once your Worker is deployed ([quickstart](quickstart.md)), point the
PulseSync app at it.

> **Advanced Export** — Send PulseSync samples to storage you control. This
> is optional and not required for local insights or private cloud backup.
> You'll need a Worker endpoint URL and bearer auth token.

## Where the settings live

In the PulseSync app:

1. Open **Settings → Advanced Export**.
2. Enable **Advanced Export**.
3. Fill in two fields:

| App field | What to enter |
|-----------|---------------|
| **Endpoint URL** | Your Worker URL, e.g. `https://pulsesync-worker.<your-subdomain>.workers.dev` |
| **Auth Token** | Your **INGEST_TOKEN** (the *write* key from quickstart Step 4) |

4. Tap **Test Connection**. The app sends a request to your endpoint's
   health check and confirms it can reach it.

That's it. PulseSync will now batch and send samples to your endpoint in
the background. Deliveries are idempotent — if a batch is retried, your
endpoint recognizes duplicates automatically, so no data is ever
double-counted.

## Important: which token goes here

Enter the **INGEST_TOKEN** in the app — never the READ_TOKEN.

- The app only ever needs to *write*.
- Your AI assistant only ever needs to *read*.
- Keeping the keys separate means neither side can do the other's job.

## Checking that data is flowing

- The app's sync status screen shows the last successful export.
- Or open `https://<your-endpoint>/v1/health` in any browser — it shows a
  sample count and the last time data was received (no health data
  contents, just counts).

## If exports stop

1. Check the app's sync status for errors.
2. Check `/v1/health` — if `last_received_at` is stale, the app isn't
   reaching the endpoint.
3. If you rotated INGEST_TOKEN, update the token in the app to match.
