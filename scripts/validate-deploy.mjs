#!/usr/bin/env node
// validate-deploy.mjs — sanity-check a deployed PulseSync Worker.
//
// Plain Node, no dependencies. Never prints tokens.
//
// Usage:
//   node scripts/validate-deploy.mjs <endpoint-url> [--ingest-token TOKEN] [--read-token TOKEN]
//
// Environment variables work too: PULSESYNC_ENDPOINT, PULSESYNC_INGEST_TOKEN, PULSESYNC_READ_TOKEN.
//
// Checks:
//   1. GET /v1/health responds (always).
//   2. If an ingest token is provided: POSTs ONE clearly-marked test sample
//      (uuid prefixed "validate-", type "subjective.validation") and re-POSTs
//      it to confirm dedupe (second attempt must report duplicates: 1).
//   3. If a read token is provided: verifies /v1/query/status answers, and
//      confirms the read token is REJECTED by the ingest endpoint if both
//      tokens are set (credential separation check).

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

const endpoint = (args.find((a) => a.startsWith("http")) ?? process.env.PULSESYNC_ENDPOINT ?? "").replace(/\/+$/, "");
const ingestToken = argValue("--ingest-token") ?? process.env.PULSESYNC_INGEST_TOKEN;
const readToken = argValue("--read-token") ?? process.env.PULSESYNC_READ_TOKEN;

if (!endpoint) {
  console.error("Usage: node scripts/validate-deploy.mjs <endpoint-url> [--ingest-token TOKEN] [--read-token TOKEN]");
  process.exit(1);
}

let failures = 0;

function pass(msg) {
  console.log(`  PASS  ${msg}`);
}
function fail(msg) {
  failures++;
  console.log(`  FAIL  ${msg}`);
}
function skip(msg) {
  console.log(`  SKIP  ${msg}`);
}

async function req(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json };
}

console.log(`Validating PulseSync Worker at ${endpoint}\n`);

// --- 1. health -------------------------------------------------------------
console.log("1. Health check (public)");
try {
  const { status, json } = await req("/v1/health");
  if (status === 200 && json?.ok === true) {
    pass(`/v1/health ok — ${json.samples} sample(s) stored`);
  } else {
    fail(`/v1/health returned status ${status}`);
  }
} catch (e) {
  fail(`/v1/health unreachable: ${e.message}`);
}

// --- 2. ingest + dedupe ----------------------------------------------------
console.log("\n2. Ingest + dedupe (write plane)");
if (!ingestToken) {
  skip("no ingest token provided (--ingest-token or PULSESYNC_INGEST_TOKEN)");
} else {
  const now = Date.now();
  const testSample = {
    uuid: `validate-${now}-${Math.random().toString(36).slice(2, 10)}`,
    type: "subjective.validation",
    value: 1,
    unit: "count",
    start_ts: now,
    end_ts: now,
    source: "validate-deploy-script",
    metadata: { note: "test sample from scripts/validate-deploy.mjs — safe to delete" },
  };
  const payload = { schema_v: 1, samples: [testSample] };

  try {
    const first = await req("/v1/ingest", { method: "POST", token: ingestToken, body: payload });
    if (first.status === 200 && first.json?.accepted === 1) {
      pass(`ingest accepted the test sample (uuid prefix "validate-")`);
    } else {
      fail(`ingest first POST: status ${first.status}, body ${JSON.stringify(first.json)}`);
    }

    const second = await req("/v1/ingest", { method: "POST", token: ingestToken, body: payload });
    if (second.status === 200 && second.json?.duplicates === 1 && second.json?.accepted === 0) {
      pass("re-POST reported duplicates: 1 — dedupe works, retries are free");
    } else {
      fail(`ingest re-POST: expected duplicates:1, got ${JSON.stringify(second.json)}`);
    }
  } catch (e) {
    fail(`ingest unreachable: ${e.message}`);
  }

  // Bad token must be rejected.
  try {
    const bad = await req("/v1/ingest", { method: "POST", token: "wrong-token", body: payload });
    if (bad.status === 401) pass("wrong token rejected with 401");
    else fail(`wrong token got status ${bad.status} (expected 401)`);
  } catch (e) {
    fail(`ingest auth check failed: ${e.message}`);
  }
}

// --- 3. read API -----------------------------------------------------------
console.log("\n3. Read API (read plane)");
if (!readToken) {
  skip("no read token provided (--read-token or PULSESYNC_READ_TOKEN)");
} else {
  try {
    const { status, json } = await req("/v1/query/status", { token: readToken });
    if (status === 200 && json?.ok === true) {
      pass(`/v1/query/status ok — ${json.samples} sample(s), ${json.types?.length ?? 0} type(s)`);
    } else {
      fail(`/v1/query/status returned status ${status}`);
    }
  } catch (e) {
    fail(`/v1/query/status unreachable: ${e.message}`);
  }

  try {
    const noAuth = await req("/v1/query/status");
    if (noAuth.status === 401) pass("read API without token rejected with 401");
    else fail(`read API without token got status ${noAuth.status} (expected 401)`);
  } catch (e) {
    fail(`read auth check failed: ${e.message}`);
  }
}

// --- 4. credential separation ------------------------------------------------
console.log("\n4. Credential separation");
if (ingestToken && readToken && ingestToken !== readToken) {
  try {
    const cross = await req("/v1/query/status", { token: ingestToken });
    if (cross.status === 401) pass("ingest token is rejected by the read API — planes are separate");
    else fail(`ingest token was ACCEPTED by the read API (status ${cross.status}) — tokens must differ!`);
  } catch (e) {
    fail(`separation check failed: ${e.message}`);
  }
} else if (ingestToken && readToken && ingestToken === readToken) {
  fail("INGEST_TOKEN and READ_TOKEN are identical — use two different secrets");
} else {
  skip("need both tokens to verify separation");
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
