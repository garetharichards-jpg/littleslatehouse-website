# Little Slate House — Booking System Deployment Report

Updated: 2026-10-11 · Branch: `ccr-175a0349-1giy42`

**Status:** booking backend built and tested **locally**, but **not deployed**. Cloudflare, Stripe and Resend are not reachable from this session, and the existing Booking Desk ChatGPT Site cannot be inspected. Production is untouched: no live booking changed, no email sent, no charge or refund made.

Guest names, payment IDs, management addresses and the entry code are deliberately kept out of this public repo.

## 1. Project and site

| Item | Status |
|---|---|
| Public site | `https://www.littleslatehouse.co.uk/`: Astro 6 static site in this repo. **Unchanged**: build output is byte-identical to `main` (24 files, verified). |
| Cloudflare Pages project | **Unverified.** Candidates: `littleslatehouse-website` (`littleslatehouse-website.pages.dev`) or `little-slate-house`. Needs Cloudflare access to confirm, along with root and www DNS. |
| Booking Desk (ChatGPT Site) | **Inaccessible**: `little-slate-booking-desk.garetharichards.chatgpt.site` is blocked by this sandbox's network policy. Code is probably not extractable from a public Site. **Request a native Site export.** It has not been silently rebuilt. |
| New backend | `booking-api/`: separate Worker `lsh-booking-api` + D1 `lsh-booking` (live), plus `lsh-booking-api-test` + `lsh-booking-test` (isolated TEST). Not yet deployed, so **no test URL exists yet**. |

## 2. Reused vs new

| Reused | How |
|---|---|
| Astro site, `/availability/` page | Checkout `success_url`/`cancel_url` return there; CORS allows the site origins for `/api/availability`. No site files changed. |
| Site facts (`sleeps 6`, 3pm check-in) | Party size capped at 6; 3pm wording lives in the owner's templates. |
| n8n enquiry workflow | Left as-is (still a placeholder URL); the enquiry form is not altered. |
| Booking Desk logic, records, templates | **Not reusable yet**: inaccessible. Its welcome template must be pasted in unchanged (`PUT /admin/templates/welcome`). |

New: `booking-api/` (Worker, D1 migrations, tests, rollback rehearsal, runbook `booking-api/README.md`).

## 3. Test evidence (local: Miniflare/workerd + in-memory D1, all external calls mocked, fictional data)

Full output: `booking-api/TEST-EVIDENCE.txt`. **44/44 tests pass; rollback rehearsal passes.**

| Critical test | Result |
|---|---|
| Stripe test Checkout: pay link → session with agreed amount and booking metadata; re-click reuses session | PASS |
| Live Stripe key refused while `AUTOMATION_ENABLED=false`; checkout refused until payment policy approved | PASS |
| Webhook signature: missing, wrong secret, stale timestamp → 400, nothing stored | PASS |
| Webhook success → confirmed; guest + management emailed exactly once | PASS |
| Exact replay → duplicate, no side effects; different event for same session → no-op | PASS |
| Crash mid-processing → 500 → Stripe retry confirms exactly once | PASS |
| Declined card → recorded, hold kept; session expired → back to hold or released; async failure → released | PASS |
| Amount mismatch → not confirmed, flagged in maintenance | PASS |
| Late payment after expiry → confirmed if free, flagged (no refund) if taken; payment after return-to-hold confirms | PASS |
| Overlap rejected, back-to-back allowed; **10 concurrent holds → exactly 1 wins** | PASS |
| Calendar: no source, HTTP 403 feed, empty feed → availability UNKNOWN, holds refused | PASS |
| Feed failure keeps old blocks; becomes UNKNOWN once stale; own exported bookings not re-imported | PASS |
| Resend outage → failed → hourly retry delivers once (provider idempotency key = dedupe key); gives up after 5, reported | PASS |
| Non-allow-listed guest never emailed while automation off | PASS |
| Welcome email (mocked clock): none at D-3, sent at D-2 with surname/dates/nights/entry code, no duplicate on reruns, Europe/London date across BST | PASS |
| Unapproved welcome template → not sent, maintenance alert raised | PASS |
| Entry code never appears in confirmation/management mail | PASS |
| No refund endpoint; cancelling issues no refund; external refund only recorded | PASS |
| Import/reconcile: dry run writes nothing; apply links payment, marks past emails historical, **no Stripe or Resend calls**; re-run idempotent; later webhook for the same payment is a no-op; only the welcome email is sent on 28 Dec | PASS |
| Kill switch: `AUTOMATION_ENABLED=false` stops guest email | PASS |
| Test hooks (mock clock, fault injection) ignored in live environment | PASS |
| D1 rollback rehearsal: export → damage → restore → data identical | PASS |
| Website visual regression: Astro build output identical to `main` | PASS |

**Not yet tested (needs access):** real Stripe test-mode round trip, real Resend delivery, real iCal feeds, deployed URL, Cloudflare cron firing.

## 4. Access blockers

1. **Plugins:** Cloudflare, Stripe and Resend plugins were installed, but their tools are not loaded in this session (plugins load at session start). **Start a new session** on this branch to use them. Or allow `api.cloudflare.com`, `api.stripe.com`, `api.resend.com` in the environment's network settings and add tokens as environment secrets.
2. **Booking Desk:** native export of code/records/templates, supplied privately.
3. **Calendar:** which feed is authoritative (Travel Chapter/OTA iCal URL), or confirm D1 itself is authoritative (`REQUIRE_EXTERNAL_CALENDAR=false`).

## 5. Owner decisions (not invented)

- Payment policy: only **full upfront** is implemented. The 25% deposit / 6-week balance scheme was proposed, never approved, and is not built.
- Security-damage deposit and refund policy: not implemented. Refunds stay manual in Stripe.
- Confirmation and management email wording: seeded as **DRAFTS** (`approved=0`). Owner must approve or replace them.
- Whether confirmation and management emails for the New Year booking were already sent. This decides `historical_emails` on import.

## 6. Migration and backup

- Schema in `booking-api/migrations/` (`0001_init`, `0002_seed_templates`), applied with `wrangler d1 migrations apply`.
- Before every live migration: `npm run backup:live` (D1 export to `booking-api/backups/`, gitignored). D1 Time Travel also gives point-in-time restore.
- New Year payment: `POST /admin/import`, dry run first, then `apply`. No Stripe write, no metadata change, no email. Exact procedure is in `booking-api/README.md`. Also check Stripe for legacy v1 webhook endpoints (v2 destinations are empty) before adding the new endpoint, to avoid two systems reacting to the same payment.

## 7. DNS still to fix (Resend domain status FAILED)

In Cloudflare DNS for `littleslatehouse.co.uk`, set these **DNS-only (grey cloud)** and keep every existing record:

| Type | Name | Value |
|---|---|---|
| TXT | `resend._domainkey` | full DKIM public key copied from the Resend dashboard (current record fails; check it isn't truncated) |
| CNAME | `rsend` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send` | `send.forge.rmta.net` |

Then click **Verify** in Resend. Confirm the values against the dashboard, which is authoritative.

## 8. Launch and rollback

**Launch order (each step reversible):** deploy TEST → Stripe test-mode round trip + allow-listed email → deploy LIVE with automation OFF → import and reconcile the New Year booking (dry run, then apply) → owner approves templates and policy → **only on explicit written approval**: live Stripe keys, `STRIPE_MODE=live`, `PAYMENT_POLICY=full_upfront`, `AUTOMATION_ENABLED=true`.

**Rollback:** flip `AUTOMATION_ENABLED=false` (immediate stop) → `wrangler rollback` (Worker code) → D1 Time Travel or `backups/*.sql` restore (data) → `wrangler delete` (remove entirely). The Pages site and its deployments are independent and unaffected throughout.

## 9. Connector check (2026-10-11, read-only)

| Connector | Result |
|---|---|
| Cloudflare Developer Platform | Connected. The account it sees has **0 Workers and 0 D1 databases**. The connector has **no tools for Pages, DNS, Worker upload or secrets**, so it can't confirm the live Pages project, fix DNS, or deploy. Either this is a different account from the one hosting the site, or it simply can't see Pages. |
| Stripe | Connected to "Little Slate House", **test mode only** (no live access). Safe for test Checkout. The live £900 payment cannot be read from here, which is fine: nothing needs to touch it. Test-mode webhook endpoints: none. |
| Resend | Connected. Domain `littleslatehouse.co.uk` (region ap-northeast-1) is still **failed** on all three records. Resend webhooks: none. |

Exact Resend records (from the Resend API), all DNS-only in Cloudflare:

| Type | Name | Value |
|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBKgcXPu++bR/MpPggZ2508MLJ2VoCt6LKfyPWvkqrBB9RtFmaazYJ9ix/SIL9WHIPoz7pMfmet/8MJsnFNz4E0bDXkujpAcLbla3Bx6iRIfFK1gVY98X3KqB8yTjw013GvU3fe9fF1Z2oqe4JshpIF99vXhR/QB5PLVe0pGrzCwIDAQAB` |
| CNAME | `rsend` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send` | `send.forge.rmta.net` |

**Still needed to deploy:** a Cloudflare API token for the account that owns `littleslatehouse.co.uk` (Workers Scripts edit, D1 edit, Pages read, DNS read), added as an environment secret `CLOUDFLARE_API_TOKEN` with `api.cloudflare.com` allowed. Wrangler can then deploy the TEST Worker.
