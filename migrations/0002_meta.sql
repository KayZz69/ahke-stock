-- One-row identity for this database. Devices remember it; if it ever changes (database
-- recreated or replaced), they re-send their full history instead of trusting old cursors.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', lower(hex(randomblob(8))));
