-- The relay's whole database. No app names, no frames, no history: records that exist so a
-- pairing can be checked and revoked, and nothing that describes what a person did.

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,     -- 128-bit random, generated on the PC
  key_hash      TEXT NOT NULL,        -- sha256 of the device key; the key itself never lands here
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_codes (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  code_hash   TEXT NOT NULL,          -- peppered sha256 of the six digits
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pair_codes_by_hash ON pair_codes (code_hash);
CREATE INDEX IF NOT EXISTS pair_codes_by_device ON pair_codes (device_id);

CREATE TABLE IF NOT EXISTS phones (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS phones_by_device ON phones (device_id);

-- One row per address per hour, so a six-digit code cannot be walked through from a script.
CREATE TABLE IF NOT EXISTS claim_attempts (
  address     TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (address, window_start)
);
