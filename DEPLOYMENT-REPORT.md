# Little Slate House — Deployment Readiness Report

Updated: 2026-10-11 (verified handoff) · Branch: `ccr-175a0349-1giy42`

**Verdict: ready for a TEST deployment once access is granted; NOT ready for production automation.**
Code and tests are complete locally (71/71 passing, rollback rehearsal passing, public site build byte-identical to `main`).
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
| Booking Desk ChatGPT Site | **Not reachable** from this environment (DNS blocked by sandbox). Source, schema, records and templates not obtained. | curl / WebFetch |
| Gmail | **No Gmail connector in this session.** Feed URLs, welcome wording and drafts could not be read or edited. | Connector list |

## 2. Implemented and working (locally)

`booking-api/`: a separate Cloudflare Worker + D1 database. The Pages site is not modified, apart from one line described at the end of this section. Runbook: `booking-api/README.md`.

- **Availability:**
  - The Travel Chapter feed is an authoritative blocking input.
  - The owner's dedicated Google calendar is the publisher feed, with one stable event per direct booking.
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

## 3. Tests: 71 passed, 0 failed (+ rollback rehearsal PASS, site regression PASS)

Full output: `booking-api/TEST-EVIDENCE.txt`. All runs are local (Miniflare/workerd, in-memory D1) with Stripe, Resend, Google Calendar and both feeds **mocked**, using fictional data.

| # | Requested area | Covered by | Result |
|---|---|---|---|
| 1 | Enquiry and price validation | agreed total required; party size ≤ 6; unapproved discount refused; approved rule must match exactly | PASS |
| 2 | Agent and direct conflicts | agent booking blocks quote; concurrent holds (1 of 10 wins); overlap race before Checkout and after authorisation; back-to-back allowed | PASS |
| 3 | Google write and publishing | one stable event per booking, no guest data; own events recognised; Google outage → nothing released | PASS (mocked) |
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
4. **Existing bookings not on the dedicated calendar:** the 12 Gmail-detected stays include agent and owner bookings. Should the owner's *direct* bookings be added to the dedicated calendar? Do this only after Travel Chapter answers the duplicate question (§6), because publishing them could create duplicate owner bookings in TABs.
5. **Discount rules:** approve exact rules (e.g. `{"direct10":10,"returning12":12}`) and eligibility, or keep discounts manual.
6. **Direct damage deposit:** remains disabled. Approve a policy separately if wanted.
7. **Draft templates:** approve or replace `confirmation`, `management_new_booking`, `management_cancellation`, `authorization_received`.
8. **Go-live operating model:** authorise-then-capture after Travel Chapter confirms (recommended until real-time cross-channel confirmation exists).

## 6. Blocked by missing access (with owner action)

| Blocked item | Unblock |
|---|---|
| Deploy TEST Worker + D1, test URL, cron | §4A token + `api.cloudflare.com` allowed, new session |
| Confirm live Pages project and root/www DNS | same token (Pages Read, DNS Read) |
| Resend domain verification | add the §7 DNS records (token with DNS Edit, or by hand), then Verify |
| Feed URLs, welcome wording, Travel Chapter and management drafts | no Gmail connector; owner copies URLs into secrets and exports the welcome |
| Google write + disposable test calendar | owner OAuth (§4B) and owner-created test calendar (§4C) |
| Booking Desk export | owner uses the Site's own export, if it has one, and shares it privately. If none exists, see below. |
| Travel Chapter confirmation | owner sends the existing draft (see below) |

**Booking Desk: reuse vs. new.** Without the export, nothing from the Booking Desk is reused in code. The welcome template is reused as content once exported. Records are re-entered through the dry-run import. Workflow, schema and logic are a new implementation in `booking-api/` and cover holds, payments, calendars, notifications and the welcome email. If the export arrives, compare its records with the import list and its templates with the seeded drafts.

**Question to add to the existing draft to Travel Chapter** (owner to add and send; not sent by me):
> "If our dedicated Google Calendar sends a blocked date into TABs, could that create a duplicate owner booking when the same reservation is already registered in your system?"

Also ask Travel Chapter to confirm whether the owner Google feed has been added on their side (two-way sync complete) and how to test safely. Drafts to Travel Chapter and to management stay unsent until you approve.

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
   - Register the real feeds (read-only pull). Compare `/admin/external-blocks` with the Travel Chapter owner portal and the Gmail-detected stays. Attach agent refs.
5. **Reconcile New Year:** dry-run import (linked to the agent block, payment reconciled, welcome marked as handled in Gmail), review, then `apply`.
6. **Only after Travel Chapter's answer and your written approval:** live Stripe keys + live webhook, `STRIPE_MODE=live`, `PAYMENT_POLICY=full_upfront`, `AUTOMATION_ENABLED=true`, keeping `CAPTURE_MODE=manual`.

## 9. Rollback

| Situation | Action |
|---|---|
| Any doubt in production | set `AUTOMATION_ENABLED=false` (dashboard variable or redeploy): guest email and live Stripe writes stop immediately; webhooks keep recording |
| Bad Worker release | `npx wrangler rollback` (or `wrangler deployments list` → chosen version) |
| Bad data or migration | `npx wrangler d1 time-travel restore lsh-booking --timestamp=<before>`, or restore `backups/*.sql` (rehearsed: `scripts/rollback-rehearsal.sh`) |
| Remove the backend | `npx wrangler delete` (Worker only). Remove any published Google blocks via the coordinated procedure, never by deleting from one side only. |
| Website | untouched by the backend. If needed, roll back the Pages deployment from the Pages dashboard; reverting the one-line `global.css` change is also safe. |
