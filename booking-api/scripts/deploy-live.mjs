#!/usr/bin/env node
// Deploys the LIVE booking Worker (lsh-booking-api + D1 lsh-booking) with automation OFF:
//   AUTOMATION_ENABLED=false, no Stripe key (no payments possible), PAYMENT_POLICY=full_upfront (owner-approved),
//   PUBLISH_MODE=tc_portal (no Google writes), email only to LIVE_EMAIL_ALLOWLIST.
// Secret VALUES are piped to wrangler on stdin and never printed. The Pages site is not touched.
//
//   node scripts/deploy-live.mjs --check   # offline: what is present / missing
//   node scripts/deploy-live.mjs           # deploy, configure, sync feeds, New Year import DRY RUN only
//
// Requires NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt inside the Claude sandbox.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const CHECK = process.argv.includes('--check');
const env = process.env;
const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
const log = (...a) => console.log(...a);

const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ADMIN_TOKEN_LIVE', 'LIVE_EMAIL_ALLOWLIST', 'MAINTENANCE_EMAIL',
  'ICAL_TC_URL', 'ICAL_OWNER_URL', 'ENTRY_CODE', 'RESEND_API_KEY', 'WELCOME_TEMPLATE_B64', 'MANAGEMENT_CONTACT_TEXT'];
const problems = [];
for (const k of REQUIRED) if (!has(k)) problems.push(`${k} missing`);
const allow = (env.LIVE_EMAIL_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
if (has('MAINTENANCE_EMAIL') && allow.length && !allow.map((a) => a.toLowerCase()).includes(env.MAINTENANCE_EMAIL.trim().toLowerCase())) problems.push('MAINTENANCE_EMAIL is not in LIVE_EMAIL_ALLOWLIST');
if (has('ADMIN_TOKEN_LIVE') && env.ADMIN_TOKEN_LIVE.length < 24) problems.push('ADMIN_TOKEN_LIVE shorter than 24 characters');
if (has('ADMIN_TOKEN_LIVE') && has('ADMIN_TOKEN_TEST') && env.ADMIN_TOKEN_LIVE === env.ADMIN_TOKEN_TEST) problems.push('ADMIN_TOKEN_LIVE must differ from ADMIN_TOKEN_TEST');
if (has('ICAL_TEST_OWNER_URL') && env.ICAL_OWNER_URL === env.ICAL_TEST_OWNER_URL) problems.push('ICAL_OWNER_URL equals the TEST calendar feed');
if (has('ENTRY_CODE') && env.ENTRY_CODE === 'TEST-0000') problems.push('ENTRY_CODE is the test placeholder');

let w = null;
if (has('WELCOME_TEMPLATE_B64')) {
  const t = Buffer.from(env.WELCOME_TEMPLATE_B64, 'base64').toString('utf8');
  const [first, ...rest] = t.split(/\r?\n/);
  const text = rest.join('\n').replace(/^\s*\n/, '');
  const ph = new Set([...t.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]));
  const missing = ['guest_surname', 'arrival_date', 'departure_date', 'nights', 'entry_code'].filter((p) => !ph.has(p));
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w = {
    subject: first.replace(/^SUBJECT:\s*/, '').trim(),
    text,
    html: text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n'),
    ok: first.startsWith('SUBJECT:') && !missing.length && !(has('ENTRY_CODE') && t.includes(env.ENTRY_CODE)) && t.length > 600,
    missing,
  };
}
let ny = null;
if (has('NEW_YEAR_IMPORT_B64')) {
  try { ny = JSON.parse(Buffer.from(env.NEW_YEAR_IMPORT_B64, 'base64').toString('utf8')); delete ny._comment; delete ny.apply; }
  catch { problems.push('NEW_YEAR_IMPORT_B64 is not valid base64 JSON'); }
}

log('== LIVE deployment check (automation stays OFF) ==');
for (const k of [...REQUIRED, 'NEW_YEAR_IMPORT_B64']) log(`${has(k) ? 'present' : 'missing'}  ${k}`);
if (w) log(`Welcome template: ${w.ok ? 'complete' : `INCOMPLETE (${w.missing.join(', ') || 'length/code check'}) → loaded UNAPPROVED`}`);
log(`Stripe: ${has('STRIPE_LIVE_SECRET_KEY') ? 'live key present but NOT deployed (activation is a separate, approved step)' : 'no live key (payments impossible, as intended)'}`);
for (const p of problems) log(`PROBLEM: ${p}`);
if (CHECK || problems.length) process.exit(problems.length ? 1 : 0);

const wr = (args, input) => {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: ROOT, input, encoding: 'utf8', env: { ...env, WRANGLER_SEND_METRICS: 'false' } });
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${(r.stderr || r.stdout).slice(-1500)}`);
  return r.stdout;
};

log('\n== D1 lsh-booking ==');
let db = JSON.parse(wr(['d1', 'list', '--json'])).find((d) => d.name === 'lsh-booking');
if (!db) {
  wr(['d1', 'create', 'lsh-booking', '--location', 'weur']);
  db = JSON.parse(wr(['d1', 'list', '--json'])).find((d) => d.name === 'lsh-booking');
  log(`created ${db.uuid}`);
} else {
  log(`exists ${db.uuid}; backing up before migrations`);
  wr(['d1', 'export', 'lsh-booking', '--remote', '--output', `backups/lsh-booking-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`]);
}
const tomlPath = `${ROOT}wrangler.toml`;
writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8')
  .replace(/(database_name = "lsh-booking"\ndatabase_id = )"[^"]*"/, `$1"${db.uuid}"`));
log(wr(['d1', 'migrations', 'apply', 'lsh-booking', '--remote']).split('\n').slice(-6).join('\n'));

// Hard guarantees for this deploy, whatever wrangler.toml says.
const vars = ['--var', 'AUTOMATION_ENABLED:false', '--var', 'STRIPE_MODE:test', '--var', 'PAYMENT_POLICY:full_upfront', '--var', 'PUBLISH_MODE:tc_portal',
  '--var', 'CAPTURE_MODE:manual', '--var', 'ALLOW_CLOCK_OVERRIDE:false', '--var', 'ALLOW_TEST_FAULTS:false'];
log('\n== Deploy lsh-booking-api (LIVE, automation OFF) ==');
let out = wr(['deploy', ...vars]);
const url = (out.match(/https:\/\/lsh-booking-api\.[a-z0-9-]+\.workers\.dev/) || [])[0];
if (!url) throw new Error('could not find workers.dev URL in deploy output');
log(`LIVE URL: ${url}`);
const PUBLIC_URL = 'https://bookings.littleslatehouse.co.uk'; // custom domain (wrangler.toml routes); guest pay links use it

const secrets = {
  ADMIN_TOKEN: env.ADMIN_TOKEN_LIVE,
  EMAIL_ALLOWLIST: allow.join(','),
  MAINTENANCE_EMAIL: env.MAINTENANCE_EMAIL,
  MANAGEMENT_CONTACT_TEXT: env.MANAGEMENT_CONTACT_TEXT,
  ENTRY_CODE: env.ENTRY_CODE,
  RESEND_API_KEY: env.RESEND_API_KEY,
  ICAL_TC_URL: env.ICAL_TC_URL,
  ICAL_OWNER_URL: env.ICAL_OWNER_URL,
};
// Owner's Google sign-in to /admin (read-only). The OAuth client needs ${PUBLIC_URL}/auth/callback as a redirect URI.
const loginId = env.LOGIN_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const loginSecret = env.LOGIN_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
if (loginId && loginSecret) {
  Object.assign(secrets, { LOGIN_GOOGLE_CLIENT_ID: loginId, LOGIN_GOOGLE_CLIENT_SECRET: loginSecret,
    SESSION_SECRET: env.SESSION_SECRET || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') });
} else log('Google sign-in: no OAuth client in the environment; /admin stays token-only');
if (has('MANAGEMENT_EMAIL')) secrets.MANAGEMENT_EMAIL = env.MANAGEMENT_EMAIL; // blocked by the allow-list until activation
wr(['secret', 'bulk'], JSON.stringify(secrets));
log(`secrets (names): ${Object.keys(secrets).sort().join(', ')}`);
wr(['deploy', ...vars, '--var', `API_BASE_URL:${PUBLIC_URL}`]);
log(`redeployed with API_BASE_URL ${PUBLIC_URL}`);

const api = async (method, path, body) => {
  const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${env.ADMIN_TOKEN_LIVE}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
log('\n== Configure ==');
log('travel_chapter source:', (await api('PUT', '/admin/calendar-sources/travel_chapter', { kind: 'agent', url_secret: 'ICAL_TC_URL' })).status);
log('owner_google source:', (await api('PUT', '/admin/calendar-sources/owner_google', { kind: 'owner_publisher', url_secret: 'ICAL_OWNER_URL', allow_empty: true })).status);
log('welcome template:', (await api('PUT', '/admin/templates/welcome', { subject: w.subject, html: w.html, text: w.text, approved: w.ok })).status, w.ok ? 'approved' : 'UNAPPROVED');
const run = await api('POST', '/admin/run', { job: 'hourly' });
for (const c of run.data.calendars || []) log(`sync ${c.id}: ${c.ok ? `ok, ${c.events} events, anomalies ${c.anomalies.length}` : `FAILED: ${c.error}`}`);

if (ny) {
  log('\n== New Year import: DRY RUN only (apply needs owner review) ==');
  const r = await api('POST', '/admin/import', ny);
  log(`status ${r.status}; result ${r.data.result ?? r.data.error}`);
  for (const a of r.data.actions || []) log(`  action: ${a}`);
  for (const x of r.data.warnings || []) log(`  warning: ${x}`);
}
const st = await api('GET', '/admin/status');
log('\n== Status ==');
log(JSON.stringify({ environment: st.data.environment, automation_enabled: st.data.automation_enabled, stripe_mode: st.data.stripe_mode,
  payment_policy: st.data.payment_policy, calendar_reliable: st.data.calendar?.reliable, calendar_problems: st.data.calendar?.problems }, null, 2));
