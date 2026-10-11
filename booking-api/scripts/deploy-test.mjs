#!/usr/bin/env node
// Deploys the isolated TEST environment (Worker lsh-booking-api-test + D1 lsh-booking-test) from
// environment variables. Secret VALUES are piped to wrangler on stdin and never printed or written
// to the repo. Safe to re-run.
//
//   node scripts/deploy-test.mjs --check   # report what is present / missing; no network calls
//   node scripts/deploy-test.mjs           # deploy
//
// Never touches the live Worker, the live D1, the Pages site or the real Google calendar.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const CHECK = process.argv.includes('--check');
const env = process.env;
const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
const log = (...a) => console.log(...a);

// ---- 1. Inputs -------------------------------------------------------------------------------
const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const OPTIONAL = {
  STRIPE_TEST_SECRET_KEY: 'Stripe test Checkout + webhook (skipped without it)',
  RESEND_API_KEY: 'test email delivery (emails stay queued/failed without it)',
  TEST_EMAIL_ALLOWLIST: 'your own test inboxes (no email can be delivered without it)',
  MAINTENANCE_EMAIL: 'owner alert address (must also be in the allow-list)',
  ICAL_TC_URL: 'Travel Chapter feed (read-only pull)',
  ICAL_TEST_OWNER_URL: 'disposable test calendar private iCal',
  GOOGLE_CLIENT_ID: 'Google publishing in TEST', GOOGLE_CLIENT_SECRET: 'Google publishing in TEST',
  GOOGLE_REFRESH_TOKEN: 'Google publishing in TEST', GOOGLE_TEST_CALENDAR_ID: 'disposable test calendar id',
  WELCOME_TEMPLATE_B64: 'welcome template',
};

const problems = [];
for (const k of REQUIRED) if (!has(k)) problems.push(`${k} missing (required)`);
if (has('STRIPE_TEST_SECRET_KEY') && !/^(sk|rk)_test_/.test(env.STRIPE_TEST_SECRET_KEY)) {
  problems.push('STRIPE_TEST_SECRET_KEY is not a TEST key: refusing to continue');
}
const allow = (env.TEST_EMAIL_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
if (has('MAINTENANCE_EMAIL') && allow.length && !allow.includes(env.MAINTENANCE_EMAIL.trim())) {
  problems.push('MAINTENANCE_EMAIL is not in TEST_EMAIL_ALLOWLIST');
}
const googleReady = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_TEST_CALENDAR_ID', 'ICAL_TEST_OWNER_URL'].every(has);
if (has('GOOGLE_TEST_CALENDAR_ID') && has('GOOGLE_CALENDAR_ID') && env.GOOGLE_TEST_CALENDAR_ID === env.GOOGLE_CALENDAR_ID) {
  problems.push('GOOGLE_TEST_CALENDAR_ID equals the REAL calendar id: refusing (TEST must use a disposable calendar)');
}
if (has('ICAL_TEST_OWNER_URL') && has('ICAL_OWNER_URL') && env.ICAL_TEST_OWNER_URL === env.ICAL_OWNER_URL) {
  problems.push('ICAL_TEST_OWNER_URL equals the REAL owner feed: refusing');
}

// Welcome template: SUBJECT line, blank line, body. Approved only if it has the expected placeholders.
function welcome() {
  if (!has('WELCOME_TEMPLATE_B64')) return null;
  const t = Buffer.from(env.WELCOME_TEMPLATE_B64, 'base64').toString('utf8');
  const [first, ...rest] = t.split(/\r?\n/);
  const subject = first.replace(/^SUBJECT:\s*/, '').trim();
  const text = rest.join('\n').replace(/^\s*\n/, '');
  const ph = new Set([...t.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]));
  const needed = ['guest_surname', 'arrival_date', 'departure_date', 'nights', 'entry_code'];
  const missing = needed.filter((p) => !ph.has(p));
  const leaksCode = has('ENTRY_CODE') && t.includes(env.ENTRY_CODE);
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n')
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, '{{$1}}');
  return { subject, text, html, chars: t.length, missing, leaksCode, ok: first.startsWith('SUBJECT:') && !missing.length && !leaksCode && t.length > 600 };
}
const w = welcome();

log('== TEST deployment check ==');
for (const k of [...REQUIRED, ...Object.keys(OPTIONAL), 'ENTRY_CODE']) log(`${has(k) ? 'present' : 'missing'}  ${k}${!has(k) && OPTIONAL[k] ? `  — ${OPTIONAL[k]}` : ''}`);
log(`Google publishing in TEST: ${googleReady ? 'yes (disposable calendar)' : 'no → PUBLISH_MODE=tc_portal in TEST'}`);
if (w) log(`Welcome template: ${w.chars} chars; ${w.ok ? 'complete' : `INCOMPLETE (missing placeholders: ${w.missing.join(', ') || 'none'}${w.leaksCode ? '; contains the real code!' : ''}${w.chars <= 600 ? '; suspiciously short' : ''}) → loaded UNAPPROVED`}`);
for (const p of problems) log(`PROBLEM: ${p}`);
if (CHECK || problems.length) process.exit(problems.length ? 1 : 0);

// ---- 2. Cloudflare -------------------------------------------------------------------------------
const wr = (args, input) => {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: ROOT, input, encoding: 'utf8',
    env: { ...env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID },
  });
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${(r.stderr || r.stdout).slice(-1500)}`);
  return r.stdout;
};

log('\n== Cloudflare account ==');
log(wr(['whoami']).split('\n').filter((l) => /account|email|Token/i.test(l)).slice(0, 6).join('\n'));

log('\n== D1 lsh-booking-test ==');
const list = JSON.parse(wr(['d1', 'list', '--json']));
let db = list.find((d) => d.name === 'lsh-booking-test');
if (!db) {
  wr(['d1', 'create', 'lsh-booking-test', '--location', 'weur']);
  db = JSON.parse(wr(['d1', 'list', '--json'])).find((d) => d.name === 'lsh-booking-test');
  log(`created ${db.uuid}`);
} else log(`exists ${db.uuid}`);
const tomlPath = `${ROOT}wrangler.toml`;
let toml = readFileSync(tomlPath, 'utf8');
toml = toml.replace(/(database_name = "lsh-booking-test"\ndatabase_id = )"[^"]*"/, `$1"${db.uuid}"`);
writeFileSync(tomlPath, toml);
log(wr(['d1', 'migrations', 'apply', 'lsh-booking-test', '--env', 'test', '--remote']).split('\n').slice(-6).join('\n'));

// ---- 3. Worker + secrets -------------------------------------------------------------------------
const vars = ['--var', `PUBLISH_MODE:${googleReady ? 'google' : 'tc_portal'}`];
log('\n== Deploy lsh-booking-api-test ==');
let out = wr(['deploy', '--env', 'test', ...vars]);
const url = (out.match(/https:\/\/lsh-booking-api-test\.[a-z0-9-]+\.workers\.dev/) || [])[0];
if (!url) throw new Error('could not find workers.dev URL in deploy output');
log(`TEST URL: ${url}`);

const tokenFile = `${ROOT}.admin-token.test`;
const admin = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : randomBytes(24).toString('hex');
writeFileSync(tokenFile, admin); chmodSync(tokenFile, 0o600);

const secrets = {
  ADMIN_TOKEN: admin,
  ENTRY_CODE: 'TEST-0000',                      // TEST never uses the real entrance code
  EMAIL_ALLOWLIST: allow.join(','),
  MAINTENANCE_EMAIL: env.MAINTENANCE_EMAIL,
  MANAGEMENT_EMAIL: allow[0],                    // management notices go to YOUR test inbox in TEST
  MANAGEMENT_CONTACT_TEXT: 'TEST management contact',
  RESEND_API_KEY: env.RESEND_API_KEY,
  STRIPE_SECRET_KEY: env.STRIPE_TEST_SECRET_KEY,
  ICAL_TC_URL: env.ICAL_TC_URL,
  ICAL_OWNER_URL: env.ICAL_TEST_OWNER_URL,
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN: env.GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID: env.GOOGLE_TEST_CALENDAR_ID,
};

// Stripe TEST webhook endpoint (re-created on each run so its signing secret is known).
if (has('STRIPE_TEST_SECRET_KEY')) {
  const sk = env.STRIPE_TEST_SECRET_KEY;
  const hook = `${url}/webhooks/stripe`;
  const sres = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', { headers: { authorization: `Bearer ${sk}` } });
  const existing = (await sres.json()).data || [];
  for (const e of existing.filter((x) => x.url === hook)) {
    await fetch(`https://api.stripe.com/v1/webhook_endpoints/${e.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${sk}` } });
  }
  const events = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
    'checkout.session.expired', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.canceled',
    'payment_intent.payment_failed', 'charge.refunded'];
  const body = new URLSearchParams({ url: hook, description: 'Little Slate House TEST (lsh-booking-api-test)' });
  events.forEach((e, i) => body.append(`enabled_events[${i}]`, e));
  const created = await (await fetch('https://api.stripe.com/v1/webhook_endpoints', { method: 'POST', headers: { authorization: `Bearer ${sk}` }, body })).json();
  if (!created.secret) throw new Error(`Stripe webhook creation failed: ${created.error?.message || 'unknown'}`);
  if (created.livemode) throw new Error('Stripe returned a LIVE endpoint: aborting');
  secrets.STRIPE_WEBHOOK_SECRET = created.secret;
  log(`Stripe TEST webhook endpoint: ${created.id}`);
}

log('\n== Secrets (names only) ==');
const bulk = Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v !== ''));
wr(['secret', 'bulk', '--env', 'test'], JSON.stringify(bulk));
log(Object.keys(bulk).sort().join(', '));

out = wr(['deploy', '--env', 'test', ...vars, '--var', `API_BASE_URL:${url}`]);
log('redeployed with API_BASE_URL');

// ---- 4. Configure via admin API ------------------------------------------------------------------
const api = async (method, path, body) => {
  const r = await fetch(`${url}${path}`, {
    method, headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
log('\n== Configure ==');
if (has('ICAL_TC_URL')) log('travel_chapter source:', (await api('PUT', '/admin/calendar-sources/travel_chapter', { kind: 'agent', url_secret: 'ICAL_TC_URL' })).status);
if (has('ICAL_TEST_OWNER_URL')) log('owner_google (TEST calendar) source:', (await api('PUT', '/admin/calendar-sources/owner_google', { kind: 'owner_publisher', url_secret: 'ICAL_OWNER_URL', allow_empty: true })).status);
if (w) log('welcome template:', (await api('PUT', '/admin/templates/welcome', { subject: w.subject, html: w.html, text: w.text, approved: w.ok })).status, w.ok ? 'approved' : 'UNAPPROVED (incomplete)');
const run = await api('POST', '/admin/run', { job: 'hourly' });
for (const c of run.data.calendars || []) log(`sync ${c.id}: ${c.ok ? `ok, ${c.events} events, anomalies ${c.anomalies.length}` : `FAILED: ${c.error}`}`);
const st = await api('GET', '/admin/status');
log('\n== Status ==');
log(JSON.stringify({ environment: st.data.environment, automation_enabled: st.data.automation_enabled, stripe_mode: st.data.stripe_mode,
  capture_mode: st.data.capture_mode, calendar_reliable: st.data.calendar?.reliable, calendar_problems: st.data.calendar?.problems }, null, 2));
log(`\nAdmin token saved to ${tokenFile} (gitignored, mode 600). TEST URL: ${url}`);
