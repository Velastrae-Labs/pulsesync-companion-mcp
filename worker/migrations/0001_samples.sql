-- PulseSync samples table — the single interface between the app and readers.
-- Versioned via schema_v; adding a sample *type* is additive (no migration).

CREATE TABLE samples (
  uuid        TEXT PRIMARY KEY,   -- HealthKit sample UUID (or app-generated UUID for computed values)
  type        TEXT NOT NULL,      -- HK identifier, e.g. 'heartRateVariabilitySDNN', or 'subjective.*'
  value       REAL,               -- numeric value (NULL for category/complex types)
  unit        TEXT,               -- e.g. 'ms', 'count/min', 'degC'
  start_ts    INTEGER NOT NULL,   -- epoch ms
  end_ts      INTEGER NOT NULL,   -- epoch ms
  source      TEXT NOT NULL,      -- 'watch' | 'phone' | bundle id of origin app
  device      TEXT,               -- hardware, e.g. 'Apple Watch Series 11'
  metadata    TEXT,               -- JSON: motion context, session id, computed-by, etc.
  schema_v    INTEGER NOT NULL DEFAULT 1,
  received_at INTEGER NOT NULL    -- epoch ms, server clock
);

CREATE INDEX idx_samples_type_start ON samples(type, start_ts);
CREATE INDEX idx_samples_received   ON samples(received_at);
