# Little Slate House — Booking System Deployment Report

Date: 2026-10-11 · Branch: `ccr-175a0349-1giy42`
Status: **BLOCKED — no deployment or code changes made. Production untouched.**

## 1. What was inspected

| Item | Finding |
|---|---|
| This repo (`garetharichards-jpg/littleslatehouse-website`) | Static Astro 6 + Tailwind marketing site only (6 pages). Only repo visible to this session (`list_repos`). |
| Booking Desk source | **Not found.** No Stripe, Resend, D1, Worker, wrangler, booking or payment code anywhere in the repo or git history (8 commits). |
| Database / bookings / business rules | **Not found.** No schema, records, deposit rules, cleaner/management contacts, or welcome-email template. |
| £900 New Year payment | **Cannot be reconciled** — no booking records or Stripe access. |
| Existing backend | Only `n8n-workflows/website-enquiry-handler.json` (enquiry email via n8n, webhook URL still a placeholder in `EnquiryForm.astro`). `DECISIONS.md` states payments/booking engine were explicitly out of scope. |
| Availability calendar | Placeholder only (`availability.astro`); intended source was a Travel Chapter iCal feed. |
| Cloudflare Pages project name | **Unknown.** Repo never records it. Docs only say "Cloudflare Pages", domain `www.littleslatehouse.co.uk`. |
| Credentials | None in the environment (no Cloudflare, Stripe or Resend tokens, no wrangler login). |
| Network | Outbound access to `littleslatehouse.co.uk` returns 403 from the sandbox proxy, so the live site, Cloudflare API, Stripe and Resend are all unreachable. |

## 2. Reused / changed / tested

- **Reused:** n/a — nothing existing to reuse was accessible.
- **Changed:** nothing except this report. No data invented, no payments, emails or refunds triggered, no deployment made.
- **Tested:** nothing, as there is no system to test.

## 3. Blockers (what I need)

1. **The "Little Slate Booking Desk" (ChatGPT Site) source and records**: export or paste of its code, DB/schema, bookings, business rules (deposit %, balance due date, cleaner/management recipients, welcome-email text). If it is not exportable, say so and I will build a clean replacement from rules you supply, but that is a different, larger decision than "reuse".
2. **Cloudflare access**: account/Pages project name, plus an API token scoped to Pages, Workers and D1 (or run the commands in section 5 yourself). Add the token as a secret in the environment settings.
3. **Network allowlist**: add `api.cloudflare.com`, `api.stripe.com`, `api.resend.com`, `littleslatehouse.co.uk` to the environment's allowed domains.
4. **Stripe**: test-mode secret key and webhook secret (never live keys at this stage). For the £900 payment: its PaymentIntent/Checkout Session ID and the booking it belongs to (guest name, dates).
5. **Resend**: API key (test), verified sending domain, and test recipient addresses.

## 4. Planned design (once unblocked; nothing built yet)

- Existing Pages site stays as-is. Add a separate Worker (`lsh-booking-api`) + D1 database; Pages is not modified, so rollback is unaffected.
- Tables: `bookings`, `payments` (unique `stripe_event_id` / session id for idempotency), `email_log` (unique per booking+template, prevents duplicate sends), `blocked_dates`.
- Endpoints: create booking + Checkout Session per booking; `/webhook/stripe` (signature-verified, idempotent); `/availability` (conflict check on insert in a transaction).
- Cron triggers: pre-arrival welcome email at T-2 days, balance/deposit reminders, daily maintenance checks.
- `AUTOMATION_ENABLED=false` by default; when false, webhooks record events but send no guest emails and take no live payments. Live Stripe keys not installed until you approve.
- £900 reconciliation: a one-off, dry-run-first script that *links* the existing Stripe payment to the booking, marks it paid, and suppresses confirmation email and any charge or refund. It prints a diff and requires `--apply`.
- Test plan: Stripe test mode (declined card 4000 0000 0000 0002), webhook replay x2, overlapping-date conflict, Resend failure simulation with retry, cron dry run, rollback.

## 5. Activation / rollback (to be finalised)

- Activate: `wrangler secret put` keys → `wrangler d1 migrations apply` → deploy Worker → set `AUTOMATION_ENABLED=true` only after your written approval.
- Rollback: set `AUTOMATION_ENABLED=false`; `wrangler rollback` the Worker; Pages deployment can be rolled back from the Pages dashboard (current deployment preserved); export D1 first with `wrangler d1 export`.

## 6. Outstanding

Everything in section 4. No action will be taken on real payments, guest emails or refunds without your explicit approval.
