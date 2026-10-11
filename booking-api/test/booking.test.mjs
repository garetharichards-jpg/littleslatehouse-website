import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { guest, holdAndCheckout, ics, ready, sessionEvent, start } from './harness.mjs';

const count = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).first()).n;

describe('safety rails', () => {
  let t;
  before(async () => { t = await start(); await ready(t); });
  after(() => t.stop());

  test('no refund endpoint exists', async () => {
    for (const p of ['/admin/refund', '/admin/bookings/x/refund', '/refund']) {
      assert.equal((await t.admin('POST', p, {})).status, 404, p);
    }
  });

  test('admin endpoints require the admin token', async () => {
    assert.equal((await t.api('GET', '/admin/status')).status, 401);
    assert.equal((await t.api('GET', '/admin/status', undefined, { authorization: 'Bearer wrong' })).status, 401);
  });

  test('cancelling a booking issues no refund and makes no Stripe call', async () => {
    const h = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-09-01', departure: '2027-09-03' }));
    const before = t.stripeCalls().length;
    const c = await t.admin('POST', `/admin/bookings/${h.data.id}/cancel`, { reason: 'test' });
    assert.equal(c.data.booking.status, 'cancelled', 'unpublished hold is released directly');
    assert.equal(t.stripeCalls().length, before);
  });
});

describe('live environment lockout', () => {
  test('live Stripe key refused while AUTOMATION_ENABLED=false; test hooks ignored in live', async () => {
    const t = await start({ ENVIRONMENT: 'live', STRIPE_SECRET_KEY: 'sk_live_fixture', STRIPE_MODE: 'live', AUTOMATION_ENABLED: 'false' });
    try {
      await ready(t);
      const { pay } = await holdAndCheckout(t);
      assert.equal(pay.status, 403);
      assert.match(pay.data.error, /live payments are disabled/);
      assert.equal(t.stripeCalls().length, 0);
      // x-test-now must be ignored in live: a far-future clock would otherwise make calendars stale.
      const a = await t.api('GET', '/api/availability?from=2027-01-01&to=2027-01-05', undefined, { 'x-test-now': '2030-01-01T00:00:00Z' });
      assert.equal(a.data.status, 'ok');
    } finally { await t.stop(); }
  });

  test('payment policy must be approved before checkout', async () => {
    const t = await start({ PAYMENT_POLICY: '' });
    try {
      await ready(t);
      const { pay } = await holdAndCheckout(t);
      assert.equal(pay.status, 409);
      assert.equal(t.stripeCalls().length, 0);
    } finally { await t.stop(); }
  });
});

describe('calendar availability fails closed', () => {
  test('no calendar source => holds refused, availability unknown', async () => {
    const t = await start();
    try {
      const h = await t.admin('POST', '/admin/bookings', guest());
      assert.equal(h.status, 409);
      assert.match(h.data.error, /availability unknown/);
      const a = await t.api('GET', '/api/availability?from=2027-03-01&to=2027-03-31');
      assert.equal(a.data.status, 'unknown');
    } finally { await t.stop(); }
  });

  test('blocked (HTTP 403) feed => unknown, not available', async () => {
    const t = await start();
    try {
      t.world.tcStatus = 403;
      await ready(t);
      assert.equal((await t.admin('POST', '/admin/bookings', guest())).status, 409);
    } finally { await t.stop(); }
  });

  test('empty feed => treated as unverified', async () => {
    const t = await start();
    try {
      t.world.tc = ics([]);
      const r = await ready(t);
      assert.equal(r.data.calendars[0].ok, false);
      assert.match(r.data.calendars[0].error, /zero events/);
      assert.equal((await t.admin('POST', '/admin/bookings', guest())).status, 409);
    } finally { await t.stop(); }
  });

  test('feed failure keeps previous blocks; becomes unknown once stale', async () => {
    const t = await start();
    try {
      await ready(t);
      let a = await t.api('GET', '/api/availability?from=2027-06-01&to=2027-06-05');
      assert.deepEqual(a.data.unavailable, ['2027-06-01', '2027-06-02']);
      assert.equal(a.data.status, 'ok');
      t.world.tcStatus = 500;
      await t.admin('POST', '/admin/run', { job: 'hourly' });
      a = await t.api('GET', '/api/availability?from=2027-06-01&to=2027-06-05');
      assert.deepEqual(a.data.unavailable, ['2027-06-01', '2027-06-02'], 'old blocks retained');
      const later = new Date(Date.now() + 4 * 3600_000).toISOString();
      a = await t.api('GET', '/api/availability?from=2027-06-01&to=2027-06-05', undefined, { 'x-test-now': later });
      assert.equal(a.data.status, 'unknown');
    } finally { await t.stop(); }
  });

  test('agent nights block holds; our own Google events are not treated as conflicts', async () => {
    const t = await start();
    try {
      await ready(t);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-05-30', departure: '2027-06-02' }))).status, 409);
      // A confirmed direct booking is published to Google; the owner feed then shows it with our own UID.
      const { booking: b } = await holdAndCheckout(t);
      await t.webhook(sessionEvent('checkout.session.completed', b));
      const ev = [...t.world.google.values()][0];
      assert.equal(ev.start.date, b.arrival);
      assert.doesNotMatch(JSON.stringify(ev), /Test Guest|guest@test/, 'no guest details on the shared calendar');
      t.world.owner = ics([{ uid: `${ev.id}@google.com`, start: b.arrival, end: b.departure }]);
      const r = await t.admin('POST', '/admin/run', { job: 'hourly' });
      assert.deepEqual(r.data.calendars.flatMap((c) => c.anomalies), []);
      const blocks = (await t.admin('GET', '/admin/external-blocks')).data;
      assert.equal(blocks.find((x) => x.source_id === 'owner_google').linked_booking_id, b.id);
    } finally { await t.stop(); }
  });
});

describe('booking conflicts and holds', () => {
  let t;
  before(async () => { t = await start(); await ready(t); });
  after(() => t.stop());

  test('overlap rejected, back-to-back allowed', async () => {
    assert.equal((await t.admin('POST', '/admin/bookings', guest())).status, 201);
    const o = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-03-13', departure: '2027-03-16' }));
    assert.equal(o.status, 409);
    assert.deepEqual(o.data.conflicts.direct.map((c) => c.night), ['2027-03-13']);
    assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-03-14', departure: '2027-03-17' }))).status, 201);
  });

  test('concurrent overlapping holds: exactly one wins', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      t.admin('POST', '/admin/bookings', guest({ arrival: '2027-04-10', departure: `2027-04-1${2 + (i % 5)}` }))));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 9);
    assert.equal(await count(t.db, "SELECT COUNT(*) AS n FROM bookings WHERE arrival = '2027-04-10'"), 1);
  });

  test('validation: party size and agreed amount required', async () => {
    assert.equal((await t.admin('POST', '/admin/bookings', guest({ party_size: 7, arrival: '2027-08-01', departure: '2027-08-02' }))).status, 400);
    assert.equal((await t.admin('POST', '/admin/bookings', guest({ amount_pence: 0, arrival: '2027-08-01', departure: '2027-08-02' }))).status, 400);
  });

  test('unpaid hold expires and releases nights', async () => {
    const h = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-10-01', departure: '2027-10-03' }));
    const later = new Date(Date.now() + 49 * 3600_000).toISOString();
    const r = await t.admin('POST', '/admin/run', { job: 'hourly', now: later });
    assert.ok(r.data.expired_holds.includes(h.data.id));
    assert.equal(await count(t.db, `SELECT COUNT(*) AS n FROM night_locks WHERE owner = 'booking:${h.data.id}'`), 0);
  });
});

describe('Stripe checkout and webhooks', () => {
  let t;
  before(async () => { t = await start(); await ready(t); });
  after(() => t.stop());

  test('pay link: wrong token 404; correct token redirects to Stripe; re-click reuses session', async () => {
    const h = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-11-01', departure: '2027-11-05' }));
    assert.equal((await t.api('GET', `/pay/${h.data.id}?t=nope`)).status, 404);
    const u = new URL(h.data.pay_url);
    const p1 = await t.api('GET', u.pathname + u.search);
    assert.equal(p1.status, 303);
    assert.match(p1.headers.get('location'), /^https:\/\/checkout\.stripe\.com\//);
    const p2 = await t.api('GET', u.pathname + u.search);
    assert.equal(p2.headers.get('location'), p1.headers.get('location'));
    assert.equal(t.stripeCalls().length, 1);
    const body = new URLSearchParams(t.stripeCalls()[0].body);
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), '50000');
    assert.equal(body.get('metadata[booking_id]'), h.data.id);
    assert.equal(t.stripeCalls()[0].headers.authorization, 'Bearer sk_test_fixture');
  });

  test('signature: missing, wrong secret, stale timestamp all rejected', async () => {
    const ev = sessionEvent('checkout.session.completed', { id: 'LSH-X', amount_pence: 1 });
    assert.equal((await t.webhook(ev, { signature: '' })).status, 400);
    assert.equal((await t.webhook(ev, { secret: 'whsec_wrong' })).status, 400);
    assert.equal((await t.webhook(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
    assert.equal(await count(t.db, 'SELECT COUNT(*) AS n FROM stripe_events'), 0);
  });

  test('live-mode event ignored by test deployment', async () => {
    const ev = { ...sessionEvent('checkout.session.completed', { id: 'LSH-X', amount_pence: 1 }), livemode: true };
    const r = await t.webhook(ev);
    assert.equal(r.status, 200);
    assert.match(r.data.ignored, /livemode/);
  });
});

describe('payment success, replay and idempotency', () => {
  let t, b;
  before(async () => {
    t = await start(); await ready(t);
    ({ booking: b } = await holdAndCheckout(t, { arrival: '2027-12-01', departure: '2027-12-04' }));
  });
  after(() => t.stop());

  test('completed => confirmed, guest + management emailed once', async () => {
    const ev = sessionEvent('checkout.session.completed', b, {}, 'evt_success_1');
    const r = await t.webhook(ev);
    assert.equal(r.status, 200);
    assert.equal(r.data.result.action, 'confirmed');
    const bk = await t.admin('GET', `/admin/bookings/${b.id}`);
    assert.equal(bk.data.booking.status, 'confirmed');
    assert.equal(bk.data.payments[0].status, 'succeeded');
    const sent = t.emails();
    assert.deepEqual(sent.map((e) => e.to[0]).sort(), ['guest@test.invalid', 'mgmt@test.invalid']);
    assert.doesNotMatch(JSON.stringify(sent), /TEST-CODE-0000/, 'entry code never in confirmation/management mail');
  });

  test('exact replay => acknowledged as duplicate, no extra email', async () => {
    const r = await t.webhook(sessionEvent('checkout.session.completed', b, {}, 'evt_success_1'));
    assert.equal(r.data.duplicate, true);
    assert.equal(t.emails().length, 2);
  });

  test('different event for the same paid session => no-op', async () => {
    const r = await t.webhook(sessionEvent('checkout.session.async_payment_succeeded', b, {}, 'evt_success_2'));
    assert.equal(r.data.result.action, 'noop');
    assert.equal(t.emails().length, 2);
    assert.equal(await count(t.db, 'SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?', b.id), 1);
  });

  test('confirmed booking pay link does not create another charge', async () => {
    const u = new URL(b.pay_url);
    const before = t.stripeCalls().length;
    const p = await t.api('GET', u.pathname + u.search);
    assert.equal(p.status, 200);
    assert.match(p.data, /already paid/);
    assert.equal(t.stripeCalls().length, before);
  });

  test('refund made manually in Stripe is only recorded', async () => {
    const r = await t.webhook({ id: 'evt_refund', type: 'charge.refunded', livemode: false, data: { object: { payment_intent: 'pi_test_1', metadata: { booking_id: b.id } } } });
    assert.equal(r.data.result.action, 'recorded');
    const bk = await t.admin('GET', `/admin/bookings/${b.id}`);
    assert.equal(bk.data.payments[0].status, 'refunded_externally');
    assert.equal(t.stripeCalls().filter((c) => /refund/.test(c.url)).length, 0);
  });
});

describe('processing failure and Stripe retry', () => {
  test('crash mid-processing => 500, then retry confirms exactly once', async () => {
    const t = await start();
    try {
      await ready(t);
      const { booking: b } = await holdAndCheckout(t);
      const ev = sessionEvent('checkout.session.completed', b, {}, 'evt_retry');
      const r1 = await t.webhook(ev, { headers: { 'x-test-fault': 'throw' } });
      assert.equal(r1.status, 500);
      assert.equal((await t.db.prepare("SELECT status FROM stripe_events WHERE event_id = 'evt_retry'").first()).status, 'failed');
      assert.equal((await t.admin('GET', `/admin/bookings/${b.id}`)).data.booking.status, 'pending_payment');
      const r2 = await t.webhook(ev);
      assert.equal(r2.data.result.action, 'confirmed');
      const r3 = await t.webhook(ev);
      assert.equal(r3.data.duplicate, true);
      assert.equal(t.emails().length, 2);
      assert.equal((await t.db.prepare("SELECT attempts FROM stripe_events WHERE event_id = 'evt_retry'").first()).attempts, 2);
    } finally { await t.stop(); }
  });
});

describe('failed and abandoned payments', () => {
  let t;
  before(async () => { t = await start(); await ready(t); });
  after(() => t.stop());

  test('declined card is recorded; hold kept so guest can retry', async () => {
    const { booking: b } = await holdAndCheckout(t, { arrival: '2028-01-10', departure: '2028-01-12' });
    const r = await t.webhook({ id: 'evt_decl', type: 'payment_intent.payment_failed', livemode: false,
      data: { object: { id: 'pi_x', metadata: { booking_id: b.id }, last_payment_error: { code: 'card_declined' } } } });
    assert.equal(r.data.result.action, 'recorded');
    assert.equal((await t.admin('GET', `/admin/bookings/${b.id}`)).data.booking.status, 'pending_payment');
    assert.equal(t.emails().length, 0);
  });

  test('session expired within hold => back to hold, guest can pay again; no email', async () => {
    const { booking: b } = await holdAndCheckout(t, { arrival: '2028-02-10', departure: '2028-02-12' });
    const sid = `cs_test_${t.world.stripeSessions}`;
    const r = await t.webhook(sessionEvent('checkout.session.expired', b, { id: sid, payment_status: 'unpaid' }));
    assert.equal(r.data.result.action, 'returned_to_hold');
    assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2028-02-10', departure: '2028-02-12' }))).status, 409);
    const u = new URL(b.pay_url);
    const p = await t.api('GET', u.pathname + u.search);
    assert.equal(p.status, 303);
    assert.notEqual(p.headers.get('location'), `https://checkout.stripe.com/c/pay/${sid}`, 'fresh session');
    assert.equal(t.emails().length, 0);
  });

  test('session expired after hold ended => released, dates rebookable', async () => {
    const { booking: b } = await holdAndCheckout(t, { arrival: '2028-03-10', departure: '2028-03-12' });
    const sid = `cs_test_${t.world.stripeSessions}`;
    const later = new Date(Date.now() + 48.1 * 3600_000).toISOString();
    const r = await t.webhook(sessionEvent('checkout.session.async_payment_failed', b, { id: sid, payment_status: 'unpaid' }), { headers: { 'x-test-now': later } });
    assert.equal(r.data.result.action, 'released');
    assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2028-03-10', departure: '2028-03-12' }))).status, 201);
  });

  test('payment arriving after the booking returned to hold still confirms', async () => {
    const { booking: b } = await holdAndCheckout(t, { arrival: '2028-07-10', departure: '2028-07-12' });
    const sid = `cs_test_${t.world.stripeSessions}`;
    await t.webhook(sessionEvent('checkout.session.expired', b, { id: sid, payment_status: 'unpaid' }));
    const r = await t.webhook(sessionEvent('checkout.session.async_payment_succeeded', b, { id: sid, payment_intent: 'pi_after_hold' }));
    assert.equal(r.data.result.action, 'confirmed');
    assert.equal((await t.admin('GET', `/admin/bookings/${b.id}`)).data.booking.status, 'confirmed');
  });

  test('amount mismatch => not confirmed, flagged for owner', async () => {
    const { booking: b } = await holdAndCheckout(t, { arrival: '2028-04-10', departure: '2028-04-12' });
    const sid = `cs_test_${t.world.stripeSessions}`;
    const r = await t.webhook(sessionEvent('checkout.session.completed', b, { id: sid, amount_total: 100 }));
    assert.equal(r.data.result.action, 'flagged');
    assert.equal((await t.admin('GET', `/admin/bookings/${b.id}`)).data.booking.status, 'pending_payment');
    const d = await t.admin('POST', '/admin/run', { job: 'daily' });
    assert.ok(d.data.issues.some((i) => /amount_mismatch/.test(i)));
  });

  test('late payment after expiry: confirmed if dates free, flagged (no refund) if taken', async () => {
    const { booking: b1 } = await holdAndCheckout(t, { arrival: '2028-05-10', departure: '2028-05-12' });
    const s1 = `cs_test_${t.world.stripeSessions}`;
    const { booking: b2 } = await holdAndCheckout(t, { arrival: '2028-06-10', departure: '2028-06-12' });
    const s2 = `cs_test_${t.world.stripeSessions}`;
    await t.admin('POST', '/admin/run', { job: 'hourly', now: new Date(Date.now() + 50 * 3600_000).toISOString() });
    await t.admin('POST', '/admin/bookings', guest({ arrival: '2028-06-10', departure: '2028-06-11' }));
    const r1 = await t.webhook(sessionEvent('checkout.session.completed', b1, { id: s1, payment_intent: 'pi_late1' }));
    assert.equal(r1.data.result.action, 'confirmed');
    const r2 = await t.webhook(sessionEvent('checkout.session.completed', b2, { id: s2, payment_intent: 'pi_late2' }));
    assert.equal(r2.data.result.action, 'flagged');
    assert.equal(t.stripeCalls().filter((c) => /refund/.test(c.url)).length, 0);
  });
});

describe('email gating, delivery failure and retry', () => {
  test('non-allow-listed guest is never emailed while automation is off', async () => {
    const t = await start();
    try {
      await ready(t);
      const { booking: b } = await holdAndCheckout(t, { guest_email: 'real.person@example.com' });
      const r = await t.webhook(sessionEvent('checkout.session.completed', b));
      assert.equal(r.data.result.action, 'confirmed');
      assert.equal(r.data.result.emails.confirmation.status, 'blocked');
      assert.deepEqual(t.emails().map((e) => e.to[0]), ['mgmt@test.invalid']);
      assert.equal(await count(t.db, "SELECT COUNT(*) AS n FROM email_log WHERE recipient = 'real.person@example.com'"), 0);
    } finally { await t.stop(); }
  });

  test('Resend outage => failed, retried by hourly job, delivered exactly once', async () => {
    const t = await start();
    try {
      await ready(t);
      const { booking: b } = await holdAndCheckout(t);
      t.world.resendStatus = 500;
      const r = await t.webhook(sessionEvent('checkout.session.completed', b));
      assert.equal(r.status, 200, 'email failure does not fail the webhook');
      assert.equal(r.data.result.emails.confirmation.status, 'failed');
      assert.equal(await count(t.db, "SELECT COUNT(*) AS n FROM email_log WHERE status = 'failed'"), 2);
      t.world.resendStatus = 200;
      await t.admin('POST', '/admin/run', { job: 'hourly' });
      await t.admin('POST', '/admin/run', { job: 'hourly' });
      const ok = t.emails();
      // 2 failed attempts + 2 successful sends; reruns add nothing.
      assert.equal(ok.length, 4);
      assert.equal(await count(t.db, "SELECT COUNT(*) AS n FROM email_log WHERE status = 'sent'"), 2);
      // Provider-side idempotency key is the dedupe key.
      const keys = t.world.calls.filter((c) => c.url.includes('resend')).map((c) => c.headers['idempotency-key']);
      assert.deepEqual([...new Set(keys)].sort(), [`confirmation:${b.id}`, `management_new_booking:${b.id}`]);
    } finally { await t.stop(); }
  });

  test('gives up after 5 attempts and reports it', async () => {
    const t = await start();
    try {
      await ready(t);
      const { booking: b } = await holdAndCheckout(t);
      t.world.resendStatus = 500;
      await t.webhook(sessionEvent('checkout.session.completed', b));
      for (let i = 0; i < 6; i++) await t.admin('POST', '/admin/run', { job: 'hourly' });
      const attempts = t.world.calls.filter((c) => c.url.includes('resend')).length;
      assert.equal(attempts, 10, '5 attempts x 2 emails');
      t.world.resendStatus = 200;
      const d = await t.admin('POST', '/admin/run', { job: 'daily' });
      assert.ok(d.data.issues.some((i) => /gave up after 5 attempts/.test(i)));
    } finally { await t.stop(); }
  });
});

describe('two-day pre-arrival welcome email (mocked clock)', () => {
  let t, b;
  before(async () => {
    t = await start(); await ready(t);
    ({ booking: b } = await holdAndCheckout(t, { arrival: '2027-03-10', departure: '2027-03-14' }));
    await t.webhook(sessionEvent('checkout.session.completed', b));
  });
  after(() => t.stop());

  const welcomes = () => t.emails().filter((e) => /^TEST welcome/.test(e.subject));

  test('3 days before: nothing', async () => {
    await t.admin('POST', '/admin/run', { job: 'daily', now: '2027-03-07T06:45:00Z' });
    assert.equal(welcomes().length, 0);
  });

  test('2 days before: sent once with surname, dates, nights, entry code', async () => {
    const r = await t.admin('POST', '/admin/run', { job: 'daily', now: '2027-03-08T06:45:00Z' });
    assert.equal(r.data.welcome[0].status, 'sent');
    const [w] = welcomes();
    assert.equal(w.to[0], 'guest@test.invalid');
    assert.match(w.text, /Dear Guest party, 4 nights from Wednesday 10 March 2027 to Sunday 14 March 2027\. Check-in 3pm\. Code TEST-CODE-0000/);
  });

  test('re-run same day and next day: no duplicate', async () => {
    await t.admin('POST', '/admin/run', { job: 'daily', now: '2027-03-08T18:00:00Z' });
    await t.admin('POST', '/admin/run', { job: 'daily', now: '2027-03-09T06:45:00Z' });
    assert.equal(welcomes().length, 1);
  });

  test('London date is used across BST (late-evening UTC run)', async () => {
    const { booking: b2 } = await holdAndCheckout(t, { arrival: '2027-07-03', departure: '2027-07-05' });
    await t.webhook(sessionEvent('checkout.session.completed', b2, { id: `cs_test_${t.world.stripeSessions}`, payment_intent: 'pi_bst' }));
    // 23:30 UTC on 30 June is 00:30 BST on 1 July => arrival-2.
    const r = await t.admin('POST', '/admin/run', { job: 'daily', now: '2027-06-30T23:30:00Z' });
    assert.ok(r.data.welcome.some((w) => w.booking === b2.id && w.status === 'sent'));
  });

  test('unapproved welcome template => not sent, maintenance flags it', async () => {
    const t2 = await start();
    try {
      await ready(t2);
      await t2.db.prepare("UPDATE email_templates SET approved = 0 WHERE name = 'welcome'").run();
      const { booking: b3 } = await holdAndCheckout(t2);
      await t2.webhook(sessionEvent('checkout.session.completed', b3));
      const r = await t2.admin('POST', '/admin/run', { job: 'daily', now: '2027-03-08T06:45:00Z' });
      assert.equal(r.data.welcome[0].status, 'failed');
      assert.ok(r.data.issues.some((i) => /Template 'welcome'/.test(i)));
      assert.ok(r.data.issues.some((i) => /no welcome email sent/.test(i)));
      assert.equal(r.data.alert.status, 'sent');
      assert.equal(t2.emails().filter((e) => /^TEST welcome/.test(e.subject)).length, 0);
    } finally { await t2.stop(); }
  });
});

describe('import and reconcile an existing paid booking', () => {
  let t;
  const existing = {
    booking: guest({ guest_name: 'Fixture Lead', guest_surname: 'Lead', guest_email: 'guest@test.invalid', payer_name: 'Fixture Payer',
      arrival: '2026-12-30', departure: '2027-01-03', party_size: 5, amount_pence: 90000 }),
    payment: { payment_intent_id: 'pi_fixtureReconcile', amount_pence: 90000, livemode: true },
    historical_emails: ['confirmation', 'management_new_booking'],
  };
  before(async () => { t = await start(); await ready(t, { now: '2026-10-11T10:00:00Z' }); });
  after(() => t.stop());

  test('dry run (default) writes nothing and calls nothing', async () => {
    const r = await t.admin('POST', '/admin/import', existing);
    assert.equal(r.data.result, 'dry_run');
    assert.ok(r.data.actions.some((a) => /no Stripe call/.test(a)));
    assert.equal(await count(t.db, 'SELECT COUNT(*) AS n FROM bookings'), 0);
    assert.equal(t.stripeCalls().length + t.emails().length, 0);
  });

  test('apply: confirmed, payment linked, no charge, no confirmation email', async () => {
    const r = await t.admin('POST', '/admin/import', { ...existing, apply: true });
    assert.equal(r.data.result, 'imported');
    assert.equal(r.data.booking.status, 'confirmed');
    assert.equal(r.data.booking.nights, 4);
    const d = await t.admin('GET', `/admin/bookings/${r.data.booking.id}`);
    assert.equal(d.data.payments[0].source, 'reconciled');
    assert.equal(d.data.payments[0].stripe_payment_intent_id, 'pi_fixtureReconcile');
    assert.deepEqual(d.data.emails.map((e) => e.status), ['historical', 'historical']);
    assert.equal(t.stripeCalls().length + t.emails().length, 0);
  });

  test('re-running the import creates nothing new', async () => {
    const r = await t.admin('POST', '/admin/import', { ...existing, apply: true });
    assert.equal(r.data.result, 'already_imported');
    assert.equal(await count(t.db, 'SELECT COUNT(*) AS n FROM bookings'), 1);
    assert.equal(await count(t.db, 'SELECT COUNT(*) AS n FROM payments'), 1);
  });

  test('a late webhook for the reconciled payment does not re-confirm or email', async () => {
    const b = (await t.db.prepare('SELECT * FROM bookings').first());
    const r = await t.webhook(sessionEvent('checkout.session.completed', b, { id: 'cs_unknown', payment_intent: 'pi_fixtureReconcile' }));
    assert.equal(r.data.result.action, 'noop');
    assert.equal(t.emails().length, 0);
  });

  test('daily runs before 28 Dec send nothing; on 28 Dec only the welcome is sent', async () => {
    await t.admin('POST', '/admin/run', { job: 'daily', now: '2026-12-27T06:45:00Z' });
    assert.equal(t.emails().filter((e) => /welcome/.test(e.subject)).length, 0);
    await t.admin('POST', '/admin/run', { job: 'daily', now: '2026-12-28T06:45:00Z' });
    const subjects = t.emails().map((e) => e.subject);
    assert.equal(subjects.filter((s) => /welcome/.test(s)).length, 1);
    assert.equal(subjects.filter((s) => /confirmed|New confirmed/i.test(s)).length, 0);
  });

  test('amount mismatch and conflicting dates are refused', async () => {
    const bad = await t.admin('POST', '/admin/import', { ...existing, payment: { ...existing.payment, payment_intent_id: 'pi_other', amount_pence: 1 }, apply: true });
    assert.equal(bad.status, 409);
    const clash = await t.admin('POST', '/admin/import', {
      booking: { ...existing.booking, guest_email: 'other@test.invalid' }, apply: true,
    });
    assert.equal(clash.status, 409);
    assert.match(clash.data.error, /conflicts with an existing booking/);
  });
});

describe('kill switch', () => {
  test('setting AUTOMATION_ENABLED=false stops guest email immediately (rollback of automation)', async () => {
    const on = await start({ AUTOMATION_ENABLED: 'true', EMAIL_ALLOWLIST: '' });
    let b;
    try {
      await ready(on);
      ({ booking: b } = await holdAndCheckout(on, { guest_email: 'someone@example.com' }));
      await on.webhook(sessionEvent('checkout.session.completed', b));
      assert.equal(on.emails().filter((e) => e.to[0] === 'someone@example.com').length, 1);
    } finally { await on.stop(); }

    const off = await start({ AUTOMATION_ENABLED: 'false', EMAIL_ALLOWLIST: '' });
    try {
      await ready(off);
      const { booking: b2 } = await holdAndCheckout(off, { guest_email: 'someone@example.com' });
      await off.webhook(sessionEvent('checkout.session.completed', b2));
      await off.admin('POST', '/admin/run', { job: 'daily', now: '2027-03-08T06:45:00Z' });
      assert.equal(off.emails().length, 0);
    } finally { await off.stop(); }
  });
});
