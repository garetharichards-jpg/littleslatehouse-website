// Test harness: runs the bundled Worker in Miniflare with an in-memory D1 and a mocked outside world.
// All data here is fictional. No real Stripe, Resend or calendar endpoint is ever contacted.

import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const ADMIN = 'test-admin-token-0123456789abcdef';
export const WHSEC = 'whsec_test_fixture_secret';

export const BASE_BINDINGS = {
  ENVIRONMENT: 'test',
  AUTOMATION_ENABLED: 'false',
  STRIPE_MODE: 'test',
  PAYMENT_POLICY: 'full_upfront',
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_WEBHOOK_SECRET: WHSEC,
  RESEND_API_KEY: 're_test_fixture',
  FROM_EMAIL: 'LSH Test <test@littleslatehouse.co.uk>',
  ADMIN_TOKEN: ADMIN,
  ICAL_EXPORT_TOKEN: 'ical-export-token-fixture',
  EMAIL_ALLOWLIST: 'guest@test.invalid,mgmt@test.invalid,owner@test.invalid',
  MANAGEMENT_EMAIL: 'mgmt@test.invalid',
  MAINTENANCE_EMAIL: 'owner@test.invalid',
  MANAGEMENT_CONTACT_TEXT: 'Management: test contact',
  ENTRY_CODE: 'TEST-CODE-0000',
  ALLOW_CLOCK_OVERRIDE: 'true',
  ALLOW_TEST_FAULTS: 'true',
  REQUIRE_EXTERNAL_CALENDAR: 'true',
  CALENDAR_MAX_STALENESS_HOURS: '3',
  CALENDAR_ALLOW_EMPTY: 'false',
  HOLD_HOURS: '48',
  DAILY_CRON: '45 6 * * *',
  API_BASE_URL: 'http://api.test',
  SITE_URL: 'https://site.test',
  SITE_ORIGINS: 'https://site.test',
};

export const ICS_URL = 'https://calendar.test/feed.ics';

export function ics(events) {
  const d = (s) => s.replace(/-/g, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0',
    ...events.flatMap((e, i) => ['BEGIN:VEVENT', `UID:${e.uid || `ext-${i}@ota.test`}`,
      `DTSTART;VALUE=DATE:${d(e.start)}`, `DTEND;VALUE=DATE:${d(e.end)}`, 'SUMMARY:Blocked', 'END:VEVENT']),
    'END:VCALENDAR'].join('\r\n');
}

function migrationsSql() {
  return readdirSync(new URL('../migrations/', import.meta.url)).sort()
    .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
    .join('\n')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

export async function start(bindingOverrides = {}) {
  // Mutable world the Worker talks to.
  const world = {
    calls: [],
    resendStatus: 200,
    icsBody: ics([{ start: '2027-06-01', end: '2027-06-03' }]),
    icsStatus: 200,
    stripeSessions: 0,
    networkDown: false,
  };

  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-09-01',
    d1Databases: { DB: 'lsh-test' },
    bindings: { ...BASE_BINDINGS, ...bindingOverrides },
    outboundService: async (req) => {
      const url = req.url;
      const body = req.method === 'GET' ? null : await req.text();
      world.calls.push({ url, method: req.method, headers: Object.fromEntries(req.headers), body });
      if (url.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
        world.stripeSessions += 1;
        const id = `cs_test_${world.stripeSessions}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, livemode: false });
      }
      if (url === 'https://api.resend.com/emails') {
        if (world.resendStatus !== 200) return Response.json({ message: 'simulated failure' }, { status: world.resendStatus });
        return Response.json({ id: `re_${world.calls.length}` });
      }
      if (url === ICS_URL) return new Response(world.icsBody, { status: world.icsStatus });
      return new Response('unexpected outbound call', { status: 599 });
    },
  }));

  const db = await mf.getD1Database('DB');
  for (const stmt of migrationsSql()) await db.prepare(stmt).run();

  const api = async (method, path, body, headers = {}) => {
    const res = await mf.dispatchFetch(`http://api.test${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const admin = (method, path, body, headers = {}) => api(method, path, body, { authorization: `Bearer ${ADMIN}`, ...headers });

  const webhook = (event, { secret = WHSEC, t = Math.floor(Date.now() / 1000), headers = {}, signature } = {}) => {
    const raw = JSON.stringify(event);
    const sig = signature ?? `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
    return api('POST', '/webhooks/stripe', raw, { 'stripe-signature': sig, ...headers });
  };

  const emails = () => world.calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.body));
  const stripeCalls = () => world.calls.filter((c) => c.url.startsWith('https://api.stripe.com'));

  return { mf, db, world, api, admin, webhook, emails, stripeCalls, stop: () => mf.dispose() };
}

// Common setup: calendar source synced, templates approved.
export async function ready(t, { now } = {}) {
  await t.admin('PUT', '/admin/calendar-sources/ota', { url: ICS_URL });
  const r = await t.admin('POST', '/admin/run', { job: 'hourly', ...(now ? { now } : {}) });
  for (const name of ['confirmation', 'management_new_booking']) {
    const row = await t.db.prepare('SELECT * FROM email_templates WHERE name = ?').bind(name).first();
    await t.admin('PUT', `/admin/templates/${name}`, { subject: row.subject, html: row.html, text: row.text, approved: true });
  }
  // TEST FIXTURE ONLY: stands in for the owner's saved welcome template, which must be pasted in for real use.
  await t.admin('PUT', '/admin/templates/welcome', {
    subject: 'TEST welcome {{guest_surname}} {{arrival_date}}',
    html: '<p>Dear {{guest_surname}} party, {{nights}} nights from {{arrival_date}} to {{departure_date}}. Check-in 3pm. Code {{entry_code}}. {{management_contact}}</p>',
    text: 'Dear {{guest_surname}} party, {{nights}} nights from {{arrival_date}} to {{departure_date}}. Check-in 3pm. Code {{entry_code}}. {{management_contact}}',
    approved: true,
  });
  return r;
}

export const guest = (over = {}) => ({
  guest_name: 'Test Guest', guest_surname: 'Guest', guest_email: 'guest@test.invalid',
  party_size: 5, arrival: '2027-03-10', departure: '2027-03-14', amount_pence: 50000, ...over,
});

export function sessionEvent(type, booking, over = {}, eventId = `evt_${Math.random().toString(36).slice(2)}`) {
  return {
    id: eventId, type, livemode: false,
    data: { object: {
      id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', amount_total: booking.amount_pence,
      currency: 'gbp', client_reference_id: booking.id, metadata: { booking_id: booking.id }, payment_intent: 'pi_test_1', livemode: false,
      ...over,
    } },
  };
}

// Create a hold and open Checkout through the guest pay link.
export async function holdAndCheckout(t, over = {}) {
  const h = await t.admin('POST', '/admin/bookings', guest(over));
  if (h.status !== 201) throw new Error(`hold failed ${h.status} ${JSON.stringify(h.data)}`);
  const u = new URL(h.data.pay_url);
  const pay = await t.api('GET', u.pathname + u.search);
  return { booking: h.data, pay };
}
