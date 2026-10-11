# Little Slate House — Booking System Deployment Report

Updated: 2026-10-11 (Travel Chapter two-way iCal update applied) · Branch: `ccr-175a0349-1giy42`

**Status:** booking backend redesigned around the Travel Chapter two-way iCal arrangement, and tested **locally**. It is **not deployed**: Cloudflare deploy access is still missing. Production is untouched: no live booking changed, no email sent, no charge or refund, no calendar written.

This repo is public. Guest names, payment IDs, agent booking references, contact addresses, feed URLs and the entry code are deliberately not recorded here.

## 1. Project and sources

| Item | Status |
|---|---|
| Public site | `https://www.littleslatehouse.co.uk/`: Astro 6 static site in this repo. **Unchanged** (build output byte-identical to `main`). |
| Cloudflare Pages project | **Unverified** (`littleslatehouse-website` vs `little-slate-house`). The Cloudflare connector sees an account with 0 Workers and 0 D1 databases, and has no Pages, DNS or deploy tools. |
| Booking Desk (ChatGPT Site) | **Inaccessible** from this sandbox. **Native Site export requested**; not silently rebuilt. |
| Owner's dedicated Google calendar ("Little Slate House — Bookings", Europe/London) | Found through the Google Calendar connector. **It has no events at all from June 2026 to December 2027** (last updated 9 Aug 2026). So Travel Chapter currently receives **no owner blocks** from it. The connector has **reader** access only; the Worker needs its own write credentials. |
| Travel Chapter TABs feed | Not accessible here (the URL is in the owner's Gmail, which isn't connected). The feed must be supplied as the `ICAL_TC_URL` secret. |
| Two-way sync | **Not proven complete.** Travel Chapter asked the owner to confirm the link had been added before they would add the owner feed. Get written confirmation from Travel Chapter that they import the owner Google feed. |
| Feed URL exposure | Repo and full git history scanned: no Google or Travel Chapter feed URLs present. |
| New backend | `booking-api/` (Worker `lsh-booking-api` + D1; separate `-test` Worker + D1). No test URL yet. |

## 2. What changed for Travel Chapter (summary)

- **Two origins:** the Travel Chapter feed is an authoritative blocking input. The owner Google calendar is the publisher Travel Chapter subscribes to; direct bookings are written to it through the Google Calendar API with one stable event per booking.
- **Feed loop avoided:** our own Google events are recognised by UID. Travel Chapter's re-export of our booking (exact dates) is **linked** as propagation confirmation, not treated as a new booking.
- **Never release on disappearance:** missing blocks stay blocked. Ghosts and amendments are flagged. Every release needs an owner-recorded acknowledgment of the coordinated change.
- **24h lag:** no irreversible guarantee before the agent shows the block. The default is **deferred authorisation**: the card is authorised at Checkout, the block is published, the agent echo or the owner's verification follows, and only then does the owner confirm and capture. The live config refuses immediate capture.
- **Cancellations:** pending coordinated-change queue with an agreed time and a draft message for the agent's iCal cancellations team (never sent automatically). Dates stay blocked until both sides are done, then verified against the agent feed.
- **Checks before money moves:** the agent feed is re-pulled before every quote and every Checkout. The daily reconciler alerts on staleness, overlaps, ghosts, propagation pending or overdue, cancelled bookings still showing, duplicates and expiring authorisations.

The full runbook is in `booking-api/README.md`.

## 3. Test evidence

Local runs: Miniflare/workerd + in-memory D1, with Stripe, Resend, Google Calendar and both feeds mocked. Fictional data only. Full output: `booking-api/TEST-EVIDENCE.txt`. **65/65 pass; D1 rollback rehearsal passes; website build identical.**

| Critical scenario | Result |
|---|---|
| Deferred authorisation: Checkout `capture_method=manual`; authorised → published to Google → owner alerted, guest **not** told "confirmed" | PASS |
| Owner confirmation refused until agent echo, unless owner states they verified with the agent; capture once (idempotency key) → confirmed + emails once | PASS |
| Live immediate capture refused even with automation on; live key refused while automation off | PASS |
| 24h lag: pending at 23h (no false alarm), `overdue` + alert at 27h, cleared when the agent feed shows the block | PASS |
| Booking created on the agent channel blocks a direct quote | PASS |
| Overlap race: agent booking lands after the quote → pay link refuses Checkout; after authorisation → CRITICAL alert, confirmation blocked | PASS |
| Back-to-back with agent booking (checkout-exclusive DTEND) allowed; true overlap refused | PASS |
| Missed fetch keeps blocks; empty agent feed = unverified; empty owner feed allowed; stale → unknown | PASS |
| Block disappears → `missing`, still blocked, needs acknowledged release | PASS |
| Transient omission (block returns) → item closes itself | PASS |
| Ghost: released block reappears (same UID, or same dates with new UID) → blocked + flagged, not a new booking | PASS |
| Agent amendment keeps old dates blocked until coordinated | PASS |
| Coordinated cancellation: pending (still blocked) → agreed time → release (Google removed) → still blocked by agent copy → verified when the agent drops it → bookable | PASS |
| Agent still showing a cancelled booking >26h → reported; Google outage during release → nothing released | PASS |
| Cancelled booking's dates reappearing on agent feed → ghost + overlap flagged | PASS |
| Authorisation lapses on published dates → coordinated release, not freed | PASS |
| Existing New Year owner booking: links to matching agent block, **not re-published**, no Stripe/Google/email calls; re-run and re-sync are no-ops; partial overlap refused | PASS |
| Feed URLs never stored in D1, status output or errors; raw URL refused as source config | PASS |
| Timed DTSTART/DTEND converted to Europe/London dates | PASS |
| Earlier suite (44): webhook signature/replay/retry, concurrent holds, email dedupe/retry/allow-list, welcome email at D-2 with mocked clock, no refund path, kill switch, test hooks ignored in live | PASS |
| D1 backup → damage → restore rehearsal (applies the real migrations, incl. the blocking trigger) | PASS |

**Not yet tested (needs access):** real Travel Chapter feed, real Google Calendar write, real Stripe test-mode round trip, real Resend delivery, deployed cron.

## 4. Access blockers and owner actions

1. **Cloudflare:** API token for the account owning `littleslatehouse.co.uk` (Workers Scripts edit, D1 edit, Pages read, DNS read). Add it as environment secret `CLOUDFLARE_API_TOKEN` and allow `api.cloudflare.com`.
2. **Feeds (as Worker secrets only):** `ICAL_TC_URL` (Travel Chapter TABs feed) and `ICAL_OWNER_URL` (the existing dedicated Google feed; **keep the URL unchanged**, since Travel Chapter may already subscribe to it).
3. **Google write access:** OAuth client + refresh token for an account with write access to the dedicated calendar (`GOOGLE_*` secrets). For TEST, use a separate throwaway calendar.
4. **Confirm with Travel Chapter** that they have added the owner Google feed (two-way sync complete). Ask also whether, once our system starts writing direct-booking blocks to that calendar, their import could duplicate owner bookings they already hold (e.g. New Year).
5. **Booking Desk:** native export, and the existing saved welcome template.
6. **Decisions:** payment policy (only full upfront is implemented); security deposit and refund policy (not implemented); draft templates to approve; which historical emails were actually sent for New Year.
7. **Reconcile agent bookings:** after the first real sync, attach the Travel Chapter references from their booking emails to the matching blocks (`PUT /admin/external-blocks`). Kept out of this repo.
8. **Feed rotation:** no leak found in this repo. If either URL was ever shared beyond the owner and Travel Chapter, coordinate rotation with Travel Chapter first.

## 5. Migration and backup

- Schema: `booking-api/migrations/0001_init.sql` (bookings, night locks + external-block trigger, calendar sources, iCal events, pending changes, payments, Stripe events, templates, email log, audit) and `0002_seed_templates.sql`.
- `npm run backup:live` (D1 export) before every live migration; D1 Time Travel for point-in-time restore.
- The New Year booking is imported with a dry run first, linked to the agent's block, and never re-published, charged or emailed.

## 6. DNS still to fix (Resend domain status FAILED)

Add in Cloudflare DNS for `littleslatehouse.co.uk`, **DNS-only (grey cloud)**, keeping every existing record. Values are from the Resend API:

| Type | Name | Value |
|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBKgcXPu++bR/MpPggZ2508MLJ2VoCt6LKfyPWvkqrBB9RtFmaazYJ9ix/SIL9WHIPoz7pMfmet/8MJsnFNz4E0bDXkujpAcLbla3Bx6iRIfFK1gVY98X3KqB8yTjw013GvU3fe9fF1Z2oqe4JshpIF99vXhR/QB5PLVe0pGrzCwIDAQAB` |
| CNAME | `rsend` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send` | `send.forge.rmta.net` |

Then click Verify in Resend. Connector checks: Stripe is connected in **test mode only** (no v1 webhook endpoints in test); Resend has 0 webhooks.

## 7. Safe go-live operation (proposed, for owner agreement)

Until a real-time cross-channel lock or confirmation exists with Travel Chapter:

1. Quote only when `/admin/status` shows calendars **ok**.
2. Guests authorise; nothing is charged.
3. Confirm and capture only after the Travel Chapter feed shows the block, or after confirming dates directly with Travel Chapter.
4. Make all cancellations and amendments through the coordinated-change queue at an agreed time.

`CAPTURE_MODE` stays `manual`.

## 8. Launch and rollback

**Launch (each step reversible):**
1. Deploy TEST (throwaway Google calendar, Stripe test keys, allow-listed email).
2. Do a real test round trip.
3. Deploy LIVE with automation OFF.
4. Register feeds and run a sync. Review `/admin/external-blocks` against the Travel Chapter owner portal.
5. Import the New Year booking (dry run, then apply).
6. Only on **explicit written owner approval**: live Stripe keys, `STRIPE_MODE=live`, `PAYMENT_POLICY=full_upfront`, `AUTOMATION_ENABLED=true` (keeping `CAPTURE_MODE=manual`).

**Rollback, in order:**
1. `AUTOMATION_ENABLED=false` (immediate stop).
2. `wrangler rollback` (Worker code).
3. D1 Time Travel or backup restore (data).
4. `wrangler delete` (remove the Worker). Any published Google blocks are then removed through the coordinated procedure.

The Pages site is unaffected throughout.
