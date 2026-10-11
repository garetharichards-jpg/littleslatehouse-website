-- Little Slate House booking API — initial schema.
-- Dates are ISO 'YYYY-MM-DD' (Europe/London calendar dates); timestamps are ISO-8601 UTC.

CREATE TABLE bookings (
  id               TEXT PRIMARY KEY,               -- e.g. LSH-2026-AB12CD
  guest_name       TEXT NOT NULL,
  guest_surname    TEXT NOT NULL,
  guest_email      TEXT NOT NULL,
  payer_name       TEXT,                           -- may differ from guest
  party_size       INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 6),
  arrival          TEXT NOT NULL,
  departure        TEXT NOT NULL CHECK (departure > arrival),
  nights           INTEGER NOT NULL,
  amount_pence     INTEGER NOT NULL CHECK (amount_pence > 0),
  currency         TEXT NOT NULL DEFAULT 'gbp',
  status           TEXT NOT NULL CHECK (status IN ('hold','pending_payment','confirmed','cancelled','expired')),
  hold_expires_at  TEXT,
  pay_token        TEXT,                           -- secret for the guest's pay link
  source           TEXT NOT NULL CHECK (source IN ('direct','import')),
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- One row per occupied night. PRIMARY KEY on night makes double-booking impossible,
-- even under concurrent requests. owner = 'booking:<id>' or 'ical:<source_id>'.
CREATE TABLE night_locks (
  night      TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_night_locks_owner ON night_locks(owner);

CREATE TABLE calendar_sources (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,                      -- stored here, not in source control
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_ok_at   TEXT,
  last_attempt_at TEXT,
  last_error   TEXT,
  last_event_count INTEGER
);

CREATE TABLE payments (
  id                         TEXT PRIMARY KEY,
  booking_id                 TEXT NOT NULL REFERENCES bookings(id),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT UNIQUE,
  amount_pence               INTEGER NOT NULL,
  currency                   TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','refunded_externally')),
  livemode                   INTEGER NOT NULL,
  checkout_url               TEXT,
  checkout_expires_at        TEXT,
  source                     TEXT NOT NULL CHECK (source IN ('checkout','reconciled')),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

-- Idempotency store for Stripe webhooks.
CREATE TABLE stripe_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  livemode     INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('processing','processed','failed','ignored')),
  attempts     INTEGER NOT NULL DEFAULT 1,
  error        TEXT,
  received_at  TEXT NOT NULL,
  processed_at TEXT
);

-- Owner-approved templates. The welcome template must be pasted in from the existing
-- saved version; nothing sends from a template where approved = 0.
CREATE TABLE email_templates (
  name       TEXT PRIMARY KEY,                     -- confirmation | management_new_booking | welcome | maintenance_alert
  subject    TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  approved   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- dedupe_key UNIQUE guarantees each logical email is sent at most once.
CREATE TABLE email_log (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT,
  template    TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','suppressed','historical')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  TEXT,
  provider_id TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  booking_id TEXT,
  detail     TEXT
);
