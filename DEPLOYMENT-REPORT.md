# Little Slate House — Deployment Readiness Report

Updated: 2026-10-11 (verified handoff + owner records audit) · Branch: `ccr-175a0349-1giy42`

**Verdict: ready for a TEST deployment once access is granted; NOT ready for production automation.**
Code and tests are complete locally (72/72 passing, rollback rehearsal passing, public site build byte-identical to `main`).
Nothing is deployed yet. This session has no Cloudflare API access, no Gmail access and no write access to Google Calendar.
Production is untouched: no live charge, refund, confirmation, calendar write or deletion, and no customer email.

This repo is public. Guest names, contact addresses, booking references, payment IDs, account IDs, feed URLs and the entrance code are deliberately left out of it.

---

## 1. Found and verified

| Item | Finding | How verified |
|---|---|---|
| Cloudflare Pages project | `littleslatehouse-website` on domain `littleslatehouse.co.uk` (active 11 Oct 2026), deployed from this repo; account ID supplied by owner | Owner handoff. Could not re-check: `api.cloudflare.com` is denied by this sandbox, and the Cloudflare connector shows no Pages/DNS and does not identify its account. |
| Public site source | Astro 6 static site, 6 pages. Branch build is **byte-identical to `main`** (24 files) | `booking-api/scripts/site-regression.sh` |
| Owner's dedicated Google calendar | "Little Slate House — Bookings", Europe/London. **No events at all** (2024 → 2027); last changed 9 Aug 2026 (the day its feed was shared). Connected permission: **reader** | Google Calendar connector |
| **Why that calendar is empty** | Bookings exist only as **12 "Stay at Little Slate House" events that Gmail auto-created on the owner's *primary* calendar** from booking emails (Aug 2026 → Aug 2027). They are marked *free/transparent*, are not on the dedicated calendar, and so are **not in the feed Travel Chapter subscribes to**. Their all-day spans include the checkout day (e.g. a stay ending 3 Jan is shown to 4 Jan), so they must not be read as checkout-exclusive iCal blocks. **The empty calendar is not evidence of availability.** | Google Calendar connector (read-only) |
| Stripe | Connector reaches the "Little Slate House" account in **test mode only** (no live access from here). No test webhook endpoints. | Stripe connector |
| Resend | Domain `littleslatehouse.co.uk` status **failed** (all three records). 0 webhooks. | Resend connector |
| Feed URL exposure | No Google or Travel Chapter feed URLs anywhere in the repo or its git history | `git log --all -p` scan |
| Booking Desk ChatGPT Site | A **test-mode prototype**: the Site states that charges, refunds and emails never leave the app, and uses a simulated UK clock. No source, database, template or export option was found. It holds only **two fictional records**, which must not be imported. It has no production Stripe, Resend, calendar or persistence. | Owner's ChatGPT audit (Part A); not reachable from this sandbox |
| Booking ledger | 13 stays from Aug 2026 identified from Gmail: 9 agent bookings, 3 direct/owner bookings (2 past, New Year upcoming) and 1 **proposed** owner hold for Apr 2027 (acceptance and payment not found). Agent amounts are **owner income**, not guest price. The ledger is *not* a complete portal export. Details are kept out of this repo. | Owner's ChatGPT audit |
| How direct bookings reach Travel Chapter today | The owner enters them as **owner bookings in the Travel Chapter portal**; each has a Travel Chapter reference. None came through the Google feed. | Owner's ChatGPT audit |
| Two-way iCal completion | **Not confirmed in either direction** (no confirmation email from owner or Travel Chapter). Destination calendar of the inbound Travel Chapter feed: not found. | Owner's ChatGPT audit |
| Policies | Direct: full upfront; check-in from 3pm (agent guests 5pm); checkout 10am; cleaners from 10am, so same-day turnover. Discounts: 10% direct / 12% returning are documented, but eligibility detail, stacking and an approved algorithm are **not**. Minimum stay: not found. Direct damage deposit: none approved. | Owner's ChatGPT audit, with source emails |
| Gmail | No Gmail connector in this session. Feed URLs and the welcome wording must be copied into secrets by the owner. | Connector list |

## 2. Implemented and working (locally)

`booking-api/`: a separate Cloudflare Worker + D1 database. The Pages site is not modified, apart from one line described at the end of this section. Runbook: `booking-api/README.md`.

- **Availability:**
  - The Travel Chapter feed is an authoritative blocking input.
  - **`PUBLISH_MODE=tc_portal` (live default):** the owner enters each direct booking in the Travel Chapter portal, as done today. The system tells them to, then confirms when the agent feed shows the block. **No Google writes**, so no duplicate owner bookings in TABs.
  - `PUBLISH_MODE=google` (TEST, or later once Travel Chapter confirms no duplicates): one stable event per direct booking on the dedicated Google calendar.
  - Echoes of our own bookings are linked as confirmation, not treated as conflicts.
  - Disappearing blocks are never released automatically. Ghosts and amendments are flagged.
  - Fail-closed on missing, empty or stale feeds. The agent feed is re-pulled before every quote and every Checkout.
- **Payments:**
  - Stripe Checkout with **authorisation only** (`capture_method=manual`). The owner captures after Travel Chapter shows the block, or after verifying with them.
  - Signature-verified, idempotent webhooks.
  - Live immediate capture refused; live Stripe writes refused while `AUTOMATION_ENABLED=false`.
- **Price validation:** the agreed total is required. Discounts (10% direct / 12% returning) are **refused unless an explicit rule is approved** in `APPROVED_DISCOUNT_RULES`, which is empty by default. Totals must match the rule exactly.
- **Damage deposit:** direct deposits and waivers are **refused**. The agent's £300 deposit / £35 waiver scheme is not applied. No refund code path exists.
- **Cancellations and amendments:** a pending coordinated-change queue with an agreed time and an acknowledgment. It produces a draft message for Travel Chapter's iCal cancellations team (never sent automatically). Dates stay blocked until both sides are done, then verified against the agent feed.
- **Email:**
  - Resend with per-message dedupe, retries and allow-list gating.
  - Management notices on new bookings and on released cancellations.
  - Welcome email two days before arrival in Europe/London time; the entrance code comes from a Worker secret only.
- **Historical bookings:** dry-run-first import that links to the agent's block and records the payment as reconciled. It can mark emails as **already sent** or as **handled outside this system** (e.g. the welcome already scheduled in Gmail), so they are never generated again. Prior correspondence is kept in the audit log.
- **Operations:** cron every 30 minutes for feeds and retries; daily reconciler and owner alert; D1 backup and restore; kill switch.
- **Site safety:** Tailwind v4 was scanning `booking-api/` and adding one unused CSS rule to the public site. One line in `src/styles/global.css` (`@source not "../../booking-api";`) restores a byte-identical site build.

## 3. Tests: 72 passed, 0 failed (+ rollback rehearsal PASS, site regression PASS)

Full output: `booking-api/TEST-EVIDENCE.txt`. All runs are local (Miniflare/workerd, in-memory D1) with Stripe, Resend, Google Calendar and both feeds **mocked**, using fictional data.

| # | Requested area | Covered by | Result |
|---|---|---|---|
| 1 | Enquiry and price validation | agreed total required; party size ≤ 6; unapproved discount refused; approved rule must match exactly | PASS |
| 2 | Agent and direct conflicts | agent booking blocks quote; concurrent holds (1 of 10 wins); overlap race before Checkout and after authorisation; back-to-back allowed | PASS |
| 3 | Google write and publishing | one stable event per booking, no guest data; own events recognised; Google outage → nothing released; `tc_portal` mode makes no Google calls and tells the owner to use the portal | PASS (mocked) |
| 4 | Travel Chapter feed and 24h delay | pending at 23h, overdue alert at 27h, cleared on echo; stale/empty/failed feeds fail closed; London timezone conversion | PASS (mocked) |
| 5 | Amendments, cancellations, ghosts | missing → still blocked; transient omission; ghost (same/new UID); amendment keeps old dates; coordinated cancel → verified | PASS |
| 6 | Stripe TEST Checkout, signatures, replay | manual capture; bad/stale signatures rejected; exact replay = duplicate; crash → retry once; owner capture idempotent | PASS (mocked) |
| 7 | Resend delivery and retries, test recipients | allow-list gate; outage → retry → delivered once; give-up after 5 → reported | PASS (mocked) |
| 8 | Cleaner and management notices | new-booking + cancellation notices to test address only; real address blocked while automation off | PASS |
| 9 | Pre-arrival scheduling, timezone, duplicates | D-3 none / D-2 sent once; BST late-evening run; Gmail-scheduled welcome never duplicated, 27 vs 28 Dec flagged | PASS |
| 10 | Damage deposit, no live refunds | deposit/waiver refused; single accommodation line in Checkout; no refund endpoints | PASS |
| 11 | Backups, health checks, rollback | daily reconciler issues; D1 export → damage → restore rehearsal | PASS |
| 12 | Public website regression | build byte-identical to `main` | PASS |

**Not yet tested against real services (blocked by access):** Cloudflare deploy and cron, real D1, real Google Calendar write, real Travel Chapter feed, Stripe test-mode round trip through a deployed URL, Resend real delivery (domain not verified).

## 4. Credentials still to configure

Never in chat or the repo.

**A. For this Claude environment** (so I can deploy). In the cloud environment settings (environment menu in the session title bar → Edit):
- Add **network secrets / environment variables** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Add `api.cloudflare.com` under **Allowed domains**, keeping "Allow package managers" ticked.
- Start a **new session** afterwards; secrets are picked up at session start.

Scoped token (Cloudflare dashboard → My Profile → API Tokens → Create custom token):

| Scope | Permission | Why |
|---|---|---|
| Account | Workers Scripts: **Edit** | deploy the Worker and set its secrets |
| Account | D1: **Edit** | create the databases and run migrations, backups and restores |
| Account | Cloudflare Pages: **Read** | confirm the live project and deployments (no changes) |
| Account | Account Settings: **Read** | wrangler account lookup |
| Zone `littleslatehouse.co.uk` | DNS: **Edit** | add the three Resend records only (or **Read**, if you prefer to add them yourself) |
| Account resources | this account only | |

**B. Worker secrets** (set with `wrangler secret put`, separately for TEST and LIVE):
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (TEST: `sk_test_…`)
- `RESEND_API_KEY`
- `ADMIN_TOKEN` (32+ random characters)
- `ENTRY_CODE`
- `MANAGEMENT_EMAIL`, `MAINTENANCE_EMAIL`, `EMAIL_ALLOWLIST` (TEST: your own test inboxes only), `MANAGEMENT_CONTACT_TEXT`
- `ICAL_TC_URL` (Travel Chapter TABs feed from the 10 Aug email) and `ICAL_OWNER_URL` (the existing dedicated Google feed from the 9 Aug email). **Leave that URL unchanged.**
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`: an OAuth client authorised by the **calendar's owner account** with scope `https://www.googleapis.com/auth/calendar.events`. Generating a refresh token does not alter the calendar or its private ICS URL. For TEST, `GOOGLE_CALENDAR_ID` and `ICAL_OWNER_URL` must point at the **disposable test calendar**.

**C. Owner-side setup this session cannot do:**
1. Create a disposable Google calendar (e.g. "LSH TEST – do not share"), **never shared with Travel Chapter**. The connector here has no create-calendar or write permission.
2. Copy both feed URLs from Gmail straight into the secrets above. There is no Gmail access here.
3. Export the welcome wording (3 Sep 2026 message / Booking Desk template) into `welcome.json` for `PUT /admin/templates/welcome`. Keep the entrance code as `{{entry_code}}` only.

## 5. Decisions needing your approval

1. **New Year welcome date:** Gmail has it scheduled for **27 Dec**; the saved policy implies **28 Dec**. Keep, move, or cancel and let the system send it? Until you decide, the system will **not** send any welcome for this booking and will keep flagging it.
2. **New Year confirmation:** no post-payment confirmation was found as sent. Send one manually, or none? The system will not generate one.
3. **New Year management notice:** was cleaning or management already told about 30 Dec–3 Jan? This decides whether the import marks it historical.
4. **Publishing route:** keep `PUBLISH_MODE=tc_portal` (enter direct bookings in the Travel Chapter portal, as now), or switch to `google` after Travel Chapter answers the duplicate question. Until then, do **not** back-fill existing owner bookings into the dedicated Google calendar; they are already in TABs.
5. **Discount rules:** approve exact rules (e.g. `{"direct10":10,"returning12":12}`), who counts as "returning", and whether rules can combine (the system applies at most one rule per booking). Otherwise keep discounts manual.
6. **Direct damage deposit:** remains disabled. Approve a policy separately if wanted.
7. **Draft templates:** approve or replace `confirmation`, `management_new_booking`, `management_cancellation`, `authorization_received`.
8. **Go-live operating model:** authorise-then-capture after Travel Chapter confirms (recommended until real-time cross-channel confirmation exists).
9. **April 2027 owner hold:** acceptance and payment of the revised offer were not found. It stays **only** as a Travel Chapter block, not as a confirmed direct booking. Confirm its status before anything else is done with it.
10. **Minimum stay:** none found. The system enforces none, and the owner quotes each stay.
11. **Booking Desk:** retire it as a test prototype. No data in it needs migrating.

## 6. Blocked by missing access (with owner action)

| Blocked item | Unblock |
|---|---|
| Deploy TEST Worker + D1, test URL, cron | §4A token + `api.cloudflare.com` allowed, new session |
| Confirm live Pages project and root/www DNS | same token (Pages Read, DNS Read) |
| Resend domain verification | add the §7 DNS records (token with DNS Edit, or by hand), then Verify |
| Feed URLs, welcome wording, Travel Chapter and management drafts | no Gmail connector; owner copies URLs into secrets and exports the welcome |
| Google write + disposable test calendar | owner OAuth (§4B) and owner-created test calendar (§4C) |
| Travel Chapter confirmation | owner sends the existing draft (see below) |

**Booking Desk: reuse vs. new (now settled).** The Site is a test-mode prototype with no exportable source, database or templates, and only fictional records.

| Kind | Items | Handling |
|---|---|---|
| Content reused | Welcome wording (from the Gmail versions); payment-link and checkout-reminder wording as reference | Owner to supply or approve templates |
| Records reused | Real bookings come from Gmail and the Travel Chapter portal, not the Site | **New Year** is imported via `booking-api/imports/new-year.example.json`. Agent bookings and the April hold stay as Travel Chapter blocks (annotate refs after the first sync). Past stays are not imported. |
| New implementation | Workflow, schema, payments, calendars, notifications, scheduling | `booking-api/` |

Gap noted from history: a checkout reminder was once sent on the arrival day by mistake. There is no automated checkout-reminder template yet. If you want one, it would be timed from the departure date and approved like the others.

**Question to add to the existing draft to Travel Chapter** (owner to add and send; not sent by me):
> "If our dedicated Google Calendar sends a blocked date into TABs, could that create a duplicate owner booking when the same reservation is already registered in your system?"

The existing draft to Travel Chapter already asks whether two-way sync is complete and how to test safely. Add the question above, plus:
> "Could you also confirm which calendar your TABs feed should be imported into on our side, and whether owner bookings we enter in the portal will continue to be the preferred route for direct bookings?"

The draft to management already asks for their preferred notification address. Both drafts stay unsent until you approve.

## 7. DNS records still to add (Resend; DNS-only / grey cloud; keep all existing records)

| Type | Name | Value |
|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBKgcXPu++bR/MpPggZ2508MLJ2VoCt6LKfyPWvkqrBB9RtFmaazYJ9ix/SIL9WHIPoz7pMfmet/8MJsnFNz4E0bDXkujpAcLbla3Bx6iRIfFK1gVY98X3KqB8yTjw013GvU3fe9fF1Z2oqe4JshpIF99vXhR/QB5PLVe0pGrzCwIDAQAB` |
| CNAME | `rsend` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send` | `send.forge.rmta.net` |

## 8. Safe deployment steps (each reversible)

1. **Backup first:** note the current Pages production deployment (Pages → Deployments). No Pages change is planned. If the one-line `global.css` change is merged, the site output stays identical (verified).
2. **TEST:**
   - `wrangler d1 create lsh-booking-test` → set `database_id` in `[env.test]` → `migrations apply --env test --remote`.
   - Set the TEST secrets (Stripe test keys, allow-listed test inboxes, **disposable** Google calendar and feed, read-only copy of the Travel Chapter feed).
   - `wrangler deploy --env test`.
   - Register sources, load the welcome template, run `/admin/run hourly`, check `/admin/status`.
3. **TEST round trip:**
   - Quote → pay with Stripe test card `4242…` (authorise) → block appears on the disposable calendar → confirm with `owner_verified_with_agent` → capture → emails to test inboxes only.
   - Then: cancellation through the change queue, a declined card (`4000 0000 0000 0002`), webhook replay from the Stripe dashboard, and a mocked-clock welcome run.
4. **LIVE with automation OFF:**
   - `wrangler d1 create lsh-booking`, `npm run backup:live` (empty), migrate, deploy with `AUTOMATION_ENABLED=false`, `STRIPE_MODE=test`, `PAYMENT_POLICY` empty.
   - Keep `PUBLISH_MODE=tc_portal`.
   - Register the real feeds (read-only pull). Compare `/admin/external-blocks` with the Travel Chapter owner portal and the private ledger: every agent stay, the New Year owner booking and the April hold must appear as blocks. Attach agent refs.
5. **Reconcile New Year:** fill `imports/new-year.example.json` into a gitignored `imports/new-year.json`. Dry-run import (linked to the agent block, payment reconciled, welcome marked as handled in Gmail, prior correspondence audited), review, then `apply`.
6. **Only after Travel Chapter's answer and your written approval:** live Stripe keys + live webhook, `STRIPE_MODE=live`, `PAYMENT_POLICY=full_upfront`, `AUTOMATION_ENABLED=true`, keeping `CAPTURE_MODE=manual`.

## 9. Rollback

| Situation | Action |
|---|---|
| Any doubt in production | set `AUTOMATION_ENABLED=false` (dashboard variable or redeploy): guest email and live Stripe writes stop immediately; webhooks keep recording |
| Bad Worker release | `npx wrangler rollback` (or `wrangler deployments list` → chosen version) |
| Bad data or migration | `npx wrangler d1 time-travel restore lsh-booking --timestamp=<before>`, or restore `backups/*.sql` (rehearsed: `scripts/rollback-rehearsal.sh`) |
| Remove the backend | `npx wrangler delete` (Worker only). Remove any published Google blocks via the coordinated procedure, never by deleting from one side only. |
| Website | untouched by the backend. If needed, roll back the Pages deployment from the Pages dashboard; reverting the one-line `global.css` change is also safe. |
