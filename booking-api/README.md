# lsh-booking-api — runbook

Separate Cloudflare Worker + D1 for Little Slate House bookings. It does **not** touch the Astro site or its Pages project.

**Safety defaults (live):** `AUTOMATION_ENABLED=false`, `STRIPE_MODE=test`, `PAYMENT_POLICY` unset. With these:
- a live Stripe key is refused for Checkout,
- no email reaches anyone who is not on `EMAIL_ALLOWLIST`,
- there is no refund code path at all (refunds stay a manual action in the Stripe dashboard),
- webhooks are still verified and recorded, so no payment is lost.

Guest data, payment IDs, management addresses and the entry code live only in D1 or Worker secrets, never in this (public) repo.

## What it does

| Area | Behaviour |
|---|---|
| Holds | Owner creates a hold with the **agreed** price (`POST /admin/bookings`). Nights are locked atomically (`night_locks` primary key), so overlapping or concurrent requests cannot double-book. Holds last `HOLD_HOURS` (48). |
| Payment | Guest opens the secret pay link `/pay/<id>?t=<token>` → one Stripe Checkout Session per booking (reused on re-click). Full amount only; deposits are not implemented until the owner approves a policy. |
| Webhooks | `/webhooks/stripe`: signature verified (HMAC-SHA256, 5-min tolerance); each event claimed once in `stripe_events`; replays are acknowledged without re-processing; a crash returns 500 so Stripe retries. |
| States | `hold → pending_payment → confirmed`; a session that ends returns the booking to `hold` while the hold lasts, otherwise to `expired` (nights released). Late payment re-takes the nights only if they are free, otherwise it is flagged for the owner (no automatic refund). Amount mismatches are flagged, not confirmed. |
| Calendar | External iCal feeds are synced hourly. A feed that fails, is blocked or returns zero events, or a stale feed, makes availability **unknown** and holds are refused. Previous blocks are kept on failure. `/calendar.ics?t=…` exports our bookings (no guest details) for OTAs to import; our own UIDs are not re-imported. |
| Email | Resend. Each logical email has a unique dedupe key (`confirmation:<id>`, `management_new_booking:<id>`, `welcome:<id>`, `maintenance:<date>`), also sent as Resend's `Idempotency-Key`. Failures retry hourly, up to 5 attempts, then get reported. Only **approved** templates send. |
| Welcome | Daily 06:45 UTC: confirmed bookings arriving in 2 days (Europe/London dates; catches up to arrival-1). The entry code comes only from the `ENTRY_CODE` secret and appears only in the welcome email. |
| Maintenance | Daily: calendar health, calendar conflicts, unapproved templates, failed webhook events, dead emails, flagged payments, arrivals without a welcome email. Emailed to `MAINTENANCE_EMAIL` when there are issues. |
| Import | `POST /admin/import`: dry run by default. Links an existing payment to a booking and marks past emails `historical` so they never resend. Never calls Stripe. Idempotent. |

## Tests (local, no accounts needed)

```sh
cd booking-api && npm ci && npm test            # 44 tests, Miniflare + in-memory D1, everything outbound mocked
./scripts/rollback-rehearsal.sh                  # D1 export → damage → restore, via wrangler local D1
```
The latest output is in `TEST-EVIDENCE.txt`.

## First deployment (TEST environment first)

Needs Cloudflare access (the Cloudflare plugin/MCP or `wrangler login`). Nothing below touches the Pages site.

```sh
npx wrangler d1 create lsh-booking-test           # put database_id into [env.test] in wrangler.toml
npx wrangler d1 migrations apply lsh-booking-test --env test --remote
for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET RESEND_API_KEY ADMIN_TOKEN ICAL_EXPORT_TOKEN ENTRY_CODE \
         MANAGEMENT_EMAIL MAINTENANCE_EMAIL EMAIL_ALLOWLIST MANAGEMENT_CONTACT_TEXT; do
  npx wrangler secret put $s --env test           # TEST values: sk_test_…, test-only addresses
done
npx wrangler deploy --env test                    # → https://lsh-booking-api-test.<subdomain>.workers.dev
# Set API_BASE_URL in [env.test.vars] to that URL and deploy again.
```
In Stripe (**test mode**), add a webhook endpoint `https://…/webhooks/stripe` with events
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

Then configure the deployment:
```sh
API=https://lsh-booking-api-test.<subdomain>.workers.dev; H="authorization: Bearer $ADMIN_TOKEN"
curl -X PUT $API/admin/calendar-sources/ota -H "$H" -d '{"url":"https://…ical feed…"}'
curl -X PUT $API/admin/templates/welcome   -H "$H" -d @welcome.json   # the EXISTING saved template, {"subject","html","text","approved":true}
curl -X POST $API/admin/run -H "$H" -d '{"job":"hourly"}'
curl $API/admin/status -H "$H"
```
Template variables: `{{guest_name}} {{guest_surname}} {{arrival_date}} {{departure_date}} {{nights}} {{party_size}} {{booking_id}} {{amount}} {{management_contact}}`, plus `{{entry_code}}` (welcome only).

## Live deployment (automation still OFF)

```sh
npx wrangler d1 create lsh-booking                # database_id → top-level [[d1_databases]]
npm run backup:live                               # before EVERY migration once data exists
npm run migrate:live
# secrets as above, without --env; MAINTENANCE_EMAIL/EMAIL_ALLOWLIST = owner addresses only
npx wrangler deploy
```

### Reconciling the existing New Year payment (owner-run, dry run first)
```sh
curl -X POST $API/admin/import -H "$H" -d '{
  "booking": {"guest_name":"…","guest_surname":"…","guest_email":"…","payer_name":"…",
              "party_size":5,"arrival":"2026-12-30","departure":"2027-01-03","amount_pence":90000},
  "payment": {"payment_intent_id":"pi_…","amount_pence":90000,"livemode":true},
  "historical_emails": ["confirmation","management_new_booking"]
}'
# Review the plan it prints. Then re-send with "apply": true.
```
Only list in `historical_emails` the emails that were actually sent already. If the nights are blocked by an
external feed that is this same booking, add `"take_over_ical_nights": true`.

## Activation (requires the owner's explicit written approval)

1. Approve the `confirmation` and `management_new_booking` templates (the seeded ones are DRAFTS) and paste in the welcome template.
2. Owner decides `PAYMENT_POLICY` (only `full_upfront` is implemented).
3. Set live secrets: `STRIPE_SECRET_KEY` (live), and `STRIPE_WEBHOOK_SECRET` from a live-mode webhook endpoint.
4. In `wrangler.toml` `[vars]`: `STRIPE_MODE="live"`, `PAYMENT_POLICY="full_upfront"`, `AUTOMATION_ENABLED="true"`. Then `npx wrangler deploy`.

## Rollback

| What | How |
|---|---|
| Stop all automation now | Set `AUTOMATION_ENABLED="false"` and deploy (or edit the variable in the dashboard). Guest email and live Checkout stop immediately; webhooks keep recording. |
| Bad Worker code | `npx wrangler rollback` (previous Worker version) or `npx wrangler deployments list`, then roll back to a chosen version. |
| Bad data or migration | `npx wrangler d1 time-travel restore lsh-booking --timestamp=<before change>`, or restore the `backups/*.sql` export (see `scripts/rollback-rehearsal.sh`). |
| Remove entirely | `npx wrangler delete` (Worker only). The Pages site is independent and unaffected. |
