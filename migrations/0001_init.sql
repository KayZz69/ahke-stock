-- Append-only event log. `seq` is the server's sync cursor; `id` is the
-- client-generated idempotency key, so a retried upload never duplicates.
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT    NOT NULL UNIQUE,
  type        TEXT    NOT NULL,
  occurred_at TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  received_at TEXT    NOT NULL
);

-- Failed login attempts, for rate limiting.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (ip, ts);
