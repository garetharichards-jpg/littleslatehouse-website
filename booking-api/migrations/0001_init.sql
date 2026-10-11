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
  amount_pence     INTEGER NOT NULL CHECK (amount_pence > 0),  -- agreed accommodation total
  list_price_pence INTEGER,                        -- before discount, when a discount rule was applied
  discount_rule    TEXT,                           -- name of an owner-approved rule (APPROVED_DISCOUNT_RULES)
  currency         TEXT NOT NULL DEFAULT 'gbp',
  status           TEXT NOT NULL CHECK (status IN ('hold','pending_payment','authorized','confirmed','cancellation_pending','cancelled','expired')),
  hold_expires_at  TEXT,
  pay_token        TEXT,                           -- secret for the guest's pay link
  source           TEXT NOT NULL CHECK (source IN ('direct','import')),
  notes            TEXT,
  agent_ref        TEXT,                           -- Travel Chapter booking reference, if the agent holds a record
  google_event_id  TEXT,                           -- event on the owner's published Google calendar
  published_at     TEXT,
  propagation      TEXT NOT NULL DEFAULT 'none'
                   CHECK (propagation IN ('none','publish_failed','published','agent_confirmed','overdue','withdrawn')),
  agent_confirmed_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- One row per night held by a DIRECT booking. PRIMARY KEY on night makes double-booking impossible,
-- even under concurrent requests. owner = 'booking:<id>' or 'ical:<source_id>'.
CREATE TABLE night_locks (
  night      TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_night_locks_owner ON night_locks(owner);

-- Feed URLs are credentials: only the NAME of the Worker secret holding the URL is stored here.
CREATE TABLE calendar_sources (
  id               TEXT PRIMARY KEY,                 -- e.g. 'travel_chapter', 'owner_google'
  kind             TEXT NOT NULL CHECK (kind IN ('agent','owner_publisher')),
  url_secret       TEXT NOT NULL,                    -- e.g. 'ICAL_TC_URL'
  enabled          INTEGER NOT NULL DEFAULT 1,
  allow_empty      INTEGER NOT NULL DEFAULT 0,       -- an empty feed is UNVERIFIED unless the owner allows it
  last_ok_at       TEXT,
  last_attempt_at  TEXT,
  last_error       TEXT,
  last_event_count INTEGER
);

-- Every VEVENT ever seen, by origin. Disappearance never silently releases dates.
-- state: present | missing (gone from feed, still blocks) | released (owner-verified gone) | ghost (released then reappeared, blocks)
CREATE TABLE ical_events (
  source_id         TEXT NOT NULL REFERENCES calendar_sources(id),
  uid               TEXT NOT NULL,
  start_date        TEXT NOT NULL,                   -- Europe/London date, inclusive
  end_date          TEXT NOT NULL,                   -- Europe/London date, checkout-exclusive
  summary           TEXT,
  last_modified     TEXT,
  sequence          INTEGER,
  state             TEXT NOT NULL CHECK (state IN ('present','missing','released','ghost')),
  linked_booking_id TEXT,                            -- set when this block IS one of our direct bookings echoed back
  agent_ref         TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  missing_since     TEXT,
  PRIMARY KEY (source_id, uid)
);
CREATE INDEX idx_ical_events_dates ON ical_events(start_date, end_date);

-- A direct-booking night cannot be locked while an unlinked blocking external event covers it.
CREATE TRIGGER trg_night_locks_external_block
BEFORE INSERT ON night_locks
WHEN EXISTS (
  SELECT 1 FROM ical_events e
  WHERE e.state IN ('present','missing','ghost')
    AND e.start_date <= NEW.night AND e.end_date > NEW.night
    AND (e.linked_booking_id IS NULL OR 'booking:' || e.linked_booking_id != NEW.owner)
)
BEGIN
  SELECT RAISE(ABORT, 'EXTERNAL_BLOCK');
END;

-- Coordinated changes with Travel Chapter. Dates stay blocked until the change is completed by the owner.
CREATE TABLE pending_changes (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('cancel_direct','external_missing','external_amended','ghost_block','overlap','propagation_overdue')),
  booking_id    TEXT,
  source_id     TEXT,
  uid           TEXT,
  start_date    TEXT,
  end_date      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('open','coordinated','released','verified','closed')),
  agreed_at     TEXT,                              -- agreed time for the simultaneous change on both systems
  draft_message TEXT,                              -- text for the owner to send; never sent automatically
  detail        TEXT,
  acknowledgment TEXT,                             -- e.g. who at Travel Chapter confirmed, and when
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT
);
CREATE INDEX idx_pending_changes_status ON pending_changes(status);

CREATE TABLE payments (
  id                         TEXT PRIMARY KEY,
  booking_id                 TEXT NOT NULL REFERENCES bookings(id),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT UNIQUE,
  amount_pence               INTEGER NOT NULL,
  currency                   TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN ('pending','authorized','succeeded','failed','canceled','refunded_externally')),
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
  note        TEXT,                              -- e.g. 'scheduled externally in Gmail for 2026-12-27'
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
