# lsh-booking-api — runbook

Separate Cloudflare Worker + D1 for Little Slate House direct bookings. It does **not** touch the Astro site or its Pages project.

## Safety defaults (live)

`AUTOMATION_ENABLED=false`, `STRIPE_MODE=test`, `PAYMENT_POLICY` unset, `CAPTURE_MODE=manual`. With these:
- a live Stripe key is refused for any Stripe write (Checkout, capture, releasing an authorisation),
- immediate capture in live is refused even when automation is on (`ALLOW_IMMEDIATE_CAPTURE_LIVE=false`),
- no email reaches anyone not on `EMAIL_ALLOWLIST`,
- nothing is ever sent to Travel Chapter automatically (the system writes drafts for the owner),
- there is no refund code path,
- webhooks are still verified and recorded, so no payment is lost.

Guest data, payment IDs, agent references, feed URLs, OAuth tokens and the entry code live only in D1 or Worker secrets, never in this public repo.

## Calendars: Travel Chapter two-way iCal

| Source | `kind` | Role |
|---|---|---|
| Travel Chapter TABs feed (`ICAL_TC_URL` secret) | `agent` | Authoritative **blocking** input for agent reservations. |
| Owner's dedicated Google calendar private iCal (`ICAL_OWNER_URL` secret) | `owner_publisher` | The feed Travel Chapter subscribes to. Direct bookings are written here via the Google Calendar API (`GOOGLE_*` secrets) with a stable event id per booking. Our own events are recognised by UID and never re-imported as conflicts. |

Rules the code enforces:
- **Fail closed.** A feed that errors, is blocked, returns zero events (agent feed) or is older than `CALENDAR_MAX_STALENESS_HOURS` makes availability **unknown**; quotes and Checkout are refused.
- **Re-check before money moves.** The agent feed is pulled again immediately before a quote (hold) and before Checkout is created.
- **Per-event history.** Every VEVENT is stored with source, UID, Europe/London dates (DTEND exclusive), LAST-MODIFIED/SEQUENCE, first/last seen.
- **Disappearance never releases dates.** A block that leaves the feed becomes `missing`, still blocks, and opens a pending change.
- **Ghosts.** A released block that comes back (same UID, or same dates under a new UID, or the dates of a cancelled direct booking) is a `ghost`. It blocks and is flagged; it is never treated as a new booking.
- **Amendments.** If an agent event's dates change, the old dates stay blocked until coordinated.
- **Echo = propagation.** When the agent feed shows a block with exactly a direct booking's dates, it is linked to that booking (`propagation = agent_confirmed`). Any other overlap with a direct booking is a **critical possible double booking**.
- **The 24h lag is real.** Bookings are `published` until the agent echo appears. After `PROPAGATION_SLA_HOURS` (26) they become `overdue` and are flagged. Polling every 30 minutes does not make Travel Chapter's own import faster.

## Booking flow (`CAPTURE_MODE=manual`, the default)

1. Owner agrees dates and price, then `POST /admin/bookings` → **hold** (agent feed re-pulled; nights locked atomically; a DB trigger refuses nights under any unlinked external block). The response includes the guest's private pay link.
2. Guest opens the pay link → feed re-pulled again → Stripe Checkout with `capture_method=manual`: the card is **authorised, not charged**.
3. Webhook → **authorized** → block published to the Google calendar → owner gets an "Action needed" email.
4. Travel Chapter's feed shows the block → `agent_confirmed`. If it doesn't, the owner checks with Travel Chapter.
5. Owner `POST /admin/bookings/:id/confirm` (requires `agent_confirmed`, or `{"owner_verified_with_agent": true, "note": "..."}`; refused while an overlap is open) → funds **captured** → **confirmed** → guest confirmation + management notification.

Card authorisations usually lapse after about 7 days; the daily report warns from day 5. A lapsed authorisation on published dates goes to the coordinated-release queue.

## Cancellations and amendments: pending coordinated changes

Releasing dates that were ever published needs the Travel Chapter procedure: a simultaneous change on both systems within the same hour, usually followed by a confirmation call.

1. `POST /admin/bookings/:id/cancel` → **cancellation_pending**. Dates stay blocked and the Google event stays. A `cancel_direct` change is opened with a **draft message** for the owner iCal cancellations team (not sent automatically).
2. `POST /admin/changes/:id/coordinate {"agreed_at": "<ISO time agreed with Travel Chapter>"}`.
3. At the agreed time: `POST /admin/changes/:id/complete {"acknowledgment": "who confirmed, when"}` → Google event removed and our nights released. If Google fails, nothing is released.
4. Dates remain blocked by Travel Chapter's copy until their feed drops it. The reconciler then marks the change **verified**, or reports it if it's still there after 26h.

Other change kinds: `external_missing`, `external_amended`, `ghost_block` (needs `"resolution": "genuine_booking" | "remove_ghost"`), `overlap`, `propagation_overdue`. All need an acknowledgment, and all are listed by `GET /admin/changes`.

## Daily reconciler (06:45 UTC) and alerts

Checks and emails `MAINTENANCE_EMAIL` about:
- feed health and staleness,
- open coordinated changes and critical overlaps,
- propagation pending or overdue,
- Google blocks missing,
- cancelled bookings still on the agent feed,
- duplicate or overlapping agent blocks,
- authorisations awaiting confirmation,
- unapproved templates,
- failed webhooks and dead emails,
- payments flagged for review,
- arrivals without a welcome email.

Agent booking references (from Travel Chapter booking emails) can be attached to blocks with `PUT /admin/external-blocks {"source_id","uid","agent_ref"}`.

## Email

Resend, with a unique dedupe key per message (also sent as Resend's `Idempotency-Key`). Failures retry, up to 5 attempts, then get reported. Only **approved** templates send. Seeded: `maintenance_alert` and `owner_authorization` (internal, approved); `confirmation`, `management_new_booking` and `authorization_received` (**drafts**). `welcome` must be pasted in from the existing saved template. The welcome email goes two days before arrival (Europe/London), and the entry code comes only from the `ENTRY_CODE` secret.

## Tests (local, no accounts needed)

```sh
cd booking-api && npm ci && npm test            # 65 tests: Miniflare + in-memory D1; Stripe, Resend, Google and both feeds mocked
./scripts/rollback-rehearsal.sh                  # D1 export → damage → restore, via wrangler local D1
```
The latest output is in `TEST-EVIDENCE.txt`.

## Deployment (TEST first)

Needs a Cloudflare API token for the account that owns `littleslatehouse.co.uk` (Workers Scripts edit, D1 edit, Pages read, DNS read).

```sh
npx wrangler d1 create lsh-booking-test           # database_id → [env.test] in wrangler.toml
npx wrangler d1 migrations apply lsh-booking-test --env test --remote
for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET RESEND_API_KEY ADMIN_TOKEN ENTRY_CODE MANAGEMENT_EMAIL MAINTENANCE_EMAIL \
         EMAIL_ALLOWLIST MANAGEMENT_CONTACT_TEXT ICAL_TC_URL ICAL_OWNER_URL \
         GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN GOOGLE_CALENDAR_ID; do
  npx wrangler secret put $s --env test
done
npx wrangler deploy --env test
```

**TEST must not write to the real published calendar.** Use a separate throwaway Google calendar for `GOOGLE_CALENDAR_ID`, and its own private iCal for `ICAL_OWNER_URL`. The TEST deployment may *read* the real Travel Chapter feed (read-only) or a copy of it.

Then register the sources (secret **names**, not URLs) and load the welcome template:
```sh
curl -X PUT $API/admin/calendar-sources/travel_chapter -H "$H" -d '{"kind":"agent","url_secret":"ICAL_TC_URL"}'
curl -X PUT $API/admin/calendar-sources/owner_google   -H "$H" -d '{"kind":"owner_publisher","url_secret":"ICAL_OWNER_URL","allow_empty":true}'
curl -X PUT $API/admin/templates/welcome -H "$H" -d @welcome.json      # the EXISTING saved template, approved:true
curl -X POST $API/admin/run -H "$H" -d '{"job":"hourly"}'; curl $API/admin/status -H "$H"
```

Stripe (**test mode**) webhook endpoint `…/webhooks/stripe`, events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
`payment_intent.canceled`, `payment_intent.payment_failed`, `charge.refunded`.

## Live deployment (automation OFF) and the existing New Year booking

Same steps without `--env test`, with `npm run backup:live` before every migration. Then reconcile the existing paid owner booking.
It is already held by Travel Chapter as an owner booking, so it is **linked, not re-published**:
```sh
curl -X POST $API/admin/import -H "$H" -d '{
  "booking": {"guest_name":"…","guest_surname":"…","guest_email":"…","payer_name":"…",
              "party_size":5,"arrival":"2026-12-30","departure":"2027-01-03","amount_pence":90000},
  "payment": {"payment_intent_id":"pi_…","amount_pence":90000,"livemode":true},
  "agent_ref": "<Travel Chapter owner-booking ref>",
  "historical_emails": ["confirmation","management_new_booking"]
}'      # dry run: review the plan; then resend with "apply": true
```
It never calls Stripe, Google or Resend. List only emails that were genuinely sent already. Departure 30 Dec of the preceding agent booking and arrival 30 Dec are back-to-back and allowed.

## Activation (requires the owner's explicit written approval)

1. Two-way sync confirmed with Travel Chapter: they have added the owner Google feed, and its URL is unchanged.
2. Templates approved (`confirmation`, `management_new_booking`, `authorization_received`) and welcome pasted in.
3. `PAYMENT_POLICY="full_upfront"` decided by the owner.
4. Live `STRIPE_SECRET_KEY` + live webhook secret; `STRIPE_MODE="live"`, `AUTOMATION_ENABLED="true"`. Keep `CAPTURE_MODE="manual"` until a real-time cross-channel arrangement exists.

## Rollback

| What | How |
|---|---|
| Stop all automation now | `AUTOMATION_ENABLED="false"` and deploy (or edit the variable in the dashboard). Guest email and live Stripe writes stop immediately; webhooks keep recording. |
| Bad Worker code | `npx wrangler rollback` |
| Bad data or migration | `npx wrangler d1 time-travel restore lsh-booking --timestamp=…`, or restore a `backups/*.sql` export (see `scripts/rollback-rehearsal.sh`) |
| Remove entirely | `npx wrangler delete`. Any Google blocks it published stay until removed through the coordinated procedure. The Pages site is unaffected. |
