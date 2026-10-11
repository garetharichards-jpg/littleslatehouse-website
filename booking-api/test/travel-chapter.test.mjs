// Travel Chapter two-way iCal scenarios + deferred authorisation. Fictional data only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { guest, holdAndCheckout, ics, ready, sessionEvent, start } from './harness.mjs';

const H = 3600_000;
const at = (base, hours) => new Date(base.getTime() + hours * H).toISOString();
const run = (t, job, now) => t.admin('POST', '/admin/run', { job, ...(now ? { now } : {}) });
const changes = async (t) => (await t.admin('GET', '/admin/changes')).data;
const booking = async (t, id) => (await t.admin('GET', `/admin/bookings/${id}`)).data.booking;
const tcFeed = (t, events) => { t.world.tc = ics([{ start: '2027-06-01', end: '2027-06-03', uid: 'tc-2027-06-01-0@tabs.test' }, ...events]); };

// Manual-capture authorisation as Stripe reports it: session completed, nothing captured yet.
function authorizedEvent(b, sid, over = {}) {
  return sessionEvent('checkout.session.completed', b, {
    id: sid, payment_status: 'unpaid', payment_intent: `pi_auth_${b.id}`, metadata: { booking_id: b.id, capture_mode: 'manual' }, ...over,
  });
}

async function manual(over = {}) {
  const t = await start({ CAPTURE_MODE: 'manual', ...over });
  await ready(t);
  return t;
}

async function authorize(t, over = {}) {
  const { booking: b } = await holdAndCheckout(t, over);
  const r = await t.webhook(authorizedEvent(b, `cs_test_${t.world.stripeSessions}`));
  return { b, r };
}

describe('deferred authorisation: nothing is charged until dates are confirmed across channels', () => {
  test('authorise -> publish -> agent echo -> owner confirm -> capture', async () => {
    const t = await manual();
    try {
      const { booking: b } = await holdAndCheckout(t);
      const form = new URLSearchParams(t.stripeCalls()[0].body);
      assert.equal(form.get('payment_intent_data[capture_method]'), 'manual');
      assert.equal(form.get('metadata[capture_mode]'), 'manual');

      const r = await t.webhook(authorizedEvent(b, 'cs_test_1'));
      assert.equal(r.data.result.action, 'authorized');
      assert.equal(r.data.result.published, true);
      let bk = await booking(t, b.id);
      assert.equal(bk.status, 'authorized');
      assert.equal(bk.propagation, 'published');
      assert.equal(t.world.google.size, 1, 'one block on the owner Google calendar');
      const subjects = t.emails().map((e) => e.subject);
      assert.ok(subjects.some((s) => /Action needed: card authorised/.test(s)), 'owner told to act');
      assert.ok(!subjects.some((s) => /Booking confirmed/.test(s)), 'guest NOT told the booking is confirmed');

      // Stripe also sends amount_capturable_updated: same outcome, no duplicate effects.
      const r2 = await t.webhook({ id: 'evt_cap', type: 'payment_intent.amount_capturable_updated', livemode: false,
        data: { object: { id: `pi_auth_${b.id}`, status: 'requires_capture', amount_capturable: b.amount_pence, currency: 'gbp', metadata: { booking_id: b.id } } } });
      assert.equal(r2.data.result.action, 'noop');

      // Owner cannot confirm before Travel Chapter shows the block.
      const early = await t.admin('POST', `/admin/bookings/${b.id}/confirm`, {});
      assert.equal(early.status, 409);
      assert.equal(t.stripeCalls().filter((c) => /capture/.test(c.url)).length, 0);

      // Travel Chapter imports our Google feed and re-exports the dates under its own UID.
      tcFeed(t, [{ uid: 'tc-own-echo@tabs.test', start: b.arrival, end: b.departure }]);
      const h = await run(t, 'hourly');
      assert.deepEqual(h.data.calendars.find((c) => c.id === 'travel_chapter').anomalies, [], 'echo is not a conflict');
      bk = await booking(t, b.id);
      assert.equal(bk.propagation, 'agent_confirmed');

      const ok = await t.admin('POST', `/admin/bookings/${b.id}/confirm`, {});
      assert.equal(ok.data.action, 'confirmed');
      const cap = t.stripeCalls().filter((c) => /capture/.test(c.url));
      assert.equal(cap.length, 1);
      assert.equal(cap[0].headers['idempotency-key'], `capture-${b.id}`);
      assert.equal(t.emails().filter((e) => /Booking confirmed/.test(e.subject)).length, 1);

      // Stripe's payment_intent.succeeded afterwards changes nothing.
      const r3 = await t.webhook({ id: 'evt_pis', type: 'payment_intent.succeeded', livemode: false, data: { object: { id: `pi_auth_${b.id}`, metadata: { booking_id: b.id } } } });
      assert.equal(r3.data.result.action, 'noop');
      assert.equal(t.emails().filter((e) => /Booking confirmed/.test(e.subject)).length, 1);
    } finally { await t.stop(); }
  });

  test('live immediate capture is refused even with automation on', async () => {
    const t = await start({ ENVIRONMENT: 'live', STRIPE_SECRET_KEY: 'sk_live_fixture', STRIPE_MODE: 'live', AUTOMATION_ENABLED: 'true', CAPTURE_MODE: 'automatic' });
    try {
      await ready(t);
      const { pay } = await holdAndCheckout(t);
      assert.equal(pay.status, 403);
      assert.match(pay.data.error, /immediate capture is disabled/);
    } finally { await t.stop(); }
  });

  test('authorisation lapses: published dates go to coordinated release, not silently freed', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t);
      const r = await t.webhook({ id: 'evt_lapse', type: 'payment_intent.canceled', livemode: false,
        data: { object: { id: `pi_auth_${b.id}`, cancellation_reason: 'automatic', metadata: { booking_id: b.id } } } });
      assert.equal(r.data.result.action, 'cancellation_pending');
      assert.equal((await t.admin('POST', '/admin/bookings', guest())).status, 409, 'dates still blocked');
      assert.ok((await changes(t)).some((c) => c.kind === 'cancel_direct' && c.booking_id === b.id));
    } finally { await t.stop(); }
  });
});

describe('24-hour propagation lag', () => {
  test('pending inside the window, flagged after it, cleared when the agent shows the block', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t);
      const t0 = new Date((await booking(t, b.id)).published_at);
      let d = await run(t, 'daily', at(t0, 23));
      assert.equal((await booking(t, b.id)).propagation, 'published');
      assert.ok(d.data.issues.some((i) => /waiting for Travel Chapter to import/.test(i)));
      assert.ok(!(await changes(t)).some((c) => c.kind === 'propagation_overdue'));

      d = await run(t, 'daily', at(t0, 27));
      assert.equal((await booking(t, b.id)).propagation, 'overdue');
      assert.ok(d.data.issues.some((i) => /has NOT shown the block/.test(i)));
      assert.ok((await changes(t)).some((c) => c.kind === 'propagation_overdue'));

      tcFeed(t, [{ start: b.arrival, end: b.departure }]);
      await run(t, 'hourly', at(t0, 30));
      assert.equal((await booking(t, b.id)).propagation, 'agent_confirmed');
    } finally { await t.stop(); }
  });

  test('owner may confirm early only by stating they verified dates with the agent', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t);
      const r = await t.admin('POST', `/admin/bookings/${b.id}/confirm`, { owner_verified_with_agent: true, note: 'TC phoned, dates blocked' });
      assert.equal(r.data.action, 'confirmed');
    } finally { await t.stop(); }
  });
});

describe('bookings created on either channel', () => {
  test('agent booking blocks a direct quote', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ start: '2027-08-07', end: '2027-08-14' }]);
      await run(t, 'hourly');
      const a = await t.api('GET', '/api/availability?from=2027-08-01&to=2027-08-20');
      assert.deepEqual(a.data.unavailable.filter((n) => n.startsWith('2027-08')), ['2027-08-07', '2027-08-08', '2027-08-09', '2027-08-10', '2027-08-11', '2027-08-12', '2027-08-13']);
      const h = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-08-10', departure: '2027-08-12' }));
      assert.equal(h.status, 409);
      assert.equal(h.data.conflicts.external[0].kind, 'agent');
    } finally { await t.stop(); }
  });

  test('overlap race: agent booking lands after our quote but before payment -> checkout refused', async () => {
    const t = await manual();
    try {
      const h = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-09-01', departure: '2027-09-05' }));
      tcFeed(t, [{ start: '2027-09-03', end: '2027-09-10' }]);   // agent sells overlapping dates
      const u = new URL(h.data.pay_url);
      const p = await t.api('GET', u.pathname + u.search);         // pay link re-pulls the feed first
      assert.equal(p.status, 409);
      assert.equal(t.stripeCalls().length, 0, 'no Checkout created');
      assert.ok((await changes(t)).some((c) => c.kind === 'overlap' && c.booking_id === h.data.id));
    } finally { await t.stop(); }
  });

  test('overlap race after authorisation: critical alert, owner confirmation blocked', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t, { arrival: '2027-10-01', departure: '2027-10-05' });
      tcFeed(t, [{ start: '2027-10-04', end: '2027-10-08' }]);
      await run(t, 'hourly');
      const d = await run(t, 'daily');
      assert.ok(d.data.issues.some((i) => /CRITICAL possible double booking/.test(i)));
      const c = await t.admin('POST', `/admin/bookings/${b.id}/confirm`, { owner_verified_with_agent: true });
      assert.equal(c.status, 409);
      assert.match(c.data.error, /unresolved overlap/);
    } finally { await t.stop(); }
  });

  test('back-to-back with an agent booking is allowed (checkout-exclusive DTEND)', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ start: '2027-12-16', end: '2027-12-30' }]);
      await run(t, 'hourly');
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-12-30', departure: '2028-01-03' }))).status, 201);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-12-12', departure: '2027-12-16' }))).status, 201);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-12-29', departure: '2027-12-30' }))).status, 409);
    } finally { await t.stop(); }
  });
});

describe('feed failures fail closed', () => {
  test('missed fetch keeps blocks; empty agent feed is unverified; empty owner feed is allowed', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ start: '2027-11-01', end: '2027-11-08' }]);
      await run(t, 'hourly');
      t.world.tcStatus = 503;
      const r = await run(t, 'hourly');
      assert.equal(r.data.calendars.find((c) => c.id === 'travel_chapter').ok, false);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-11-02', departure: '2027-11-04' }))).status, 409);
      t.world.tcStatus = 200; t.world.tc = ics([]);
      const e = await run(t, 'hourly');
      assert.match(e.data.calendars.find((c) => c.id === 'travel_chapter').error, /zero events/);
      assert.equal(e.data.calendars.find((c) => c.id === 'owner_google').ok, true);
      const blocks = (await t.admin('GET', '/admin/external-blocks')).data;
      assert.ok(blocks.some((x) => x.start_date === '2027-11-01' && x.state === 'present'), 'empty feed did not wipe blocks');
    } finally { await t.stop(); }
  });

  test('feed URLs never appear in status, errors or source config', async () => {
    const t = await manual();
    try {
      t.world.tcStatus = 500;
      await run(t, 'hourly');
      const s = await t.admin('GET', '/admin/status');
      assert.doesNotMatch(JSON.stringify(s.data), /private-feed-token/);
      const rows = await t.db.prepare('SELECT * FROM calendar_sources').all();
      assert.doesNotMatch(JSON.stringify(rows.results), /private-feed-token/);
      const bad = await t.admin('PUT', '/admin/calendar-sources/x', { kind: 'agent', url_secret: 'https://calendar.test/leak.ics' });
      assert.equal(bad.status, 400);
    } finally { await t.stop(); }
  });

  test('timed DTSTART/DTEND are converted to Europe/London property dates', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ uid: 'timed@tabs.test', dtstart: '20270630T230000Z', dtend: '20270703T090000Z' }]);
      await run(t, 'hourly');
      const ev = (await t.admin('GET', '/admin/external-blocks')).data.find((x) => x.uid === 'timed@tabs.test');
      assert.deepEqual([ev.start_date, ev.end_date], ['2027-07-01', '2027-07-03']);
    } finally { await t.stop(); }
  });
});

describe('disappearing blocks, ghosts and amendments are never auto-released', () => {
  test('missing block stays blocked until the owner records a coordinated release', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ uid: 'agent-1@tabs.test', start: '2027-04-03', end: '2027-04-10' }]);
      await run(t, 'hourly');
      tcFeed(t, []);
      const r = await run(t, 'hourly');
      assert.deepEqual(r.data.calendars.find((c) => c.id === 'travel_chapter').anomalies.map((a) => a.type), ['missing']);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-04-05', departure: '2027-04-07' }))).status, 409);
      const ch = (await changes(t)).find((c) => c.kind === 'external_missing');
      assert.equal((await t.admin('POST', `/admin/changes/${ch.id}/complete`, {})).status, 400, 'acknowledgment required');
      const done = await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'TC portal shows cancelled; confirmed by agent' });
      assert.equal(done.data.change.status, 'closed');
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-04-05', departure: '2027-04-07' }))).status, 201);
    } finally { await t.stop(); }
  });

  test('transient omission: block returns before anyone acts -> item closes itself', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ uid: 'agent-2@tabs.test', start: '2027-05-01', end: '2027-05-08' }]);
      await run(t, 'hourly');
      tcFeed(t, []); await run(t, 'hourly');
      tcFeed(t, [{ uid: 'agent-2@tabs.test', start: '2027-05-01', end: '2027-05-08' }]); await run(t, 'hourly');
      assert.ok(!(await changes(t)).some((c) => c.kind === 'external_missing'));
      const ev = (await t.admin('GET', '/admin/external-blocks')).data.find((x) => x.uid === 'agent-2@tabs.test');
      assert.equal(ev.state, 'present');
    } finally { await t.stop(); }
  });

  test('released block reappearing (same or new UID) is a ghost: blocked and flagged, not a new booking', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ uid: 'agent-3@tabs.test', start: '2027-02-06', end: '2027-02-13' }]);
      await run(t, 'hourly');
      tcFeed(t, []); await run(t, 'hourly');
      const ch = (await changes(t)).find((c) => c.kind === 'external_missing');
      await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'cancellation confirmed with agent' });
      tcFeed(t, [{ uid: 'agent-3@tabs.test', start: '2027-02-06', end: '2027-02-13' }]);
      let r = await run(t, 'hourly');
      assert.deepEqual(r.data.calendars.find((c) => c.id === 'travel_chapter').anomalies.map((a) => a.type), ['ghost']);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-02-07', departure: '2027-02-09' }))).status, 409);
      const g = (await changes(t)).find((c) => c.kind === 'ghost_block');
      assert.equal((await t.admin('POST', `/admin/changes/${g.id}/complete`, { acknowledgment: 'agent removing stale block' })).status, 400, 'resolution required');
      await t.admin('POST', `/admin/changes/${g.id}/complete`, { acknowledgment: 'agent removed stale block at agreed time', resolution: 'remove_ghost' });
      // The same dates under a NEW uid are also a ghost.
      tcFeed(t, [{ uid: 'agent-3-reissued@tabs.test', start: '2027-02-06', end: '2027-02-13' }]);
      r = await run(t, 'hourly');
      assert.deepEqual(r.data.calendars.find((c) => c.id === 'travel_chapter').anomalies.map((a) => a.type), ['ghost']);
    } finally { await t.stop(); }
  });

  test('agent amendment keeps the old dates blocked until coordinated', async () => {
    const t = await manual();
    try {
      tcFeed(t, [{ uid: 'agent-4@tabs.test', start: '2027-03-06', end: '2027-03-13' }]);
      await run(t, 'hourly');
      tcFeed(t, [{ uid: 'agent-4@tabs.test', start: '2027-03-20', end: '2027-03-27' }]);
      await run(t, 'hourly');
      const a = await t.api('GET', '/api/availability?from=2027-03-01&to=2027-03-31');
      assert.ok(a.data.unavailable.includes('2027-03-08'), 'old dates still blocked');
      assert.ok(a.data.unavailable.includes('2027-03-22'), 'new dates blocked');
      assert.ok((await changes(t)).some((c) => c.kind === 'external_amended' && c.start_date === '2027-03-06'));
    } finally { await t.stop(); }
  });
});

describe('coordinated cancellation of a direct booking', () => {
  test('cancel -> pending (still blocked) -> agreed time -> release -> verified when the agent drops it', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t, { arrival: '2027-06-10', departure: '2027-06-14' });
      tcFeed(t, [{ uid: 'echo@tabs.test', start: b.arrival, end: b.departure }]);
      await run(t, 'hourly');
      await t.admin('POST', `/admin/bookings/${b.id}/confirm`, {});

      const c = await t.admin('POST', `/admin/bookings/${b.id}/cancel`, { reason: 'guest request' });
      assert.equal(c.data.action, 'cancellation_pending');
      assert.equal(c.data.booking.status, 'cancellation_pending');
      assert.equal(t.world.google.size, 1, 'Google block kept until the agreed time');
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-06-11', departure: '2027-06-12' }))).status, 409);
      const ch = (await changes(t)).find((x) => x.kind === 'cancel_direct');
      assert.match(ch.draft_message, /00000/);
      assert.match(ch.draft_message, /2027-06-10 – 2027-06-14/);
      assert.doesNotMatch(ch.draft_message, /Test Guest|guest@test/);
      assert.equal(t.emails().filter((e) => /travelchapter/i.test(e.to[0])).length, 0, 'nothing sent to the agent automatically');
      assert.equal(t.stripeCalls().filter((x) => /refund/.test(x.url)).length, 0);

      const agreed = new Date().toISOString();
      await t.admin('POST', `/admin/changes/${ch.id}/coordinate`, { agreed_at: agreed });
      const done = await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'agent removed block same hour, call confirmed' });
      assert.equal(done.data.change.status, 'released');
      assert.equal(t.world.google.size, 0, 'Google block withdrawn');
      assert.equal((await booking(t, b.id)).status, 'cancelled');
      // The agent's copy is still in their feed: dates remain blocked until it goes.
      await run(t, 'hourly');
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-06-11', departure: '2027-06-12' }))).status, 409);
      tcFeed(t, []);
      await run(t, 'hourly');
      const d = await run(t, 'daily');
      assert.ok(!d.data.issues.some((i) => /still shows cancelled/.test(i)));
      assert.equal((await t.db.prepare('SELECT status FROM pending_changes WHERE id = ?').bind(ch.id).first()).status, 'verified');
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-06-11', departure: '2027-06-12' }))).status, 201);

      // A later reappearance of the cancelled booking's dates is a ghost, not a new booking.
      tcFeed(t, [{ uid: 'echo-again@tabs.test', start: b.arrival, end: b.departure }]);
      const g = await run(t, 'hourly');
      assert.deepEqual(g.data.calendars.find((x) => x.id === 'travel_chapter').anomalies.map((a) => a.type).sort(), ['ghost', 'overlap']);
    } finally { await t.stop(); }
  });

  test('agent still showing a cancelled booking >26h after release is reported', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t, { arrival: '2027-07-10', departure: '2027-07-14' });
      tcFeed(t, [{ uid: 'echo2@tabs.test', start: b.arrival, end: b.departure }]);
      await run(t, 'hourly');
      await t.admin('POST', `/admin/bookings/${b.id}/cancel`, { reason: 'x' });
      const ch = (await changes(t)).find((x) => x.kind === 'cancel_direct');
      await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'agreed by phone with agent' });
      const d = await run(t, 'daily', at(new Date(), 30));
      assert.ok(d.data.issues.some((i) => /still shows cancelled booking/.test(i)));
    } finally { await t.stop(); }
  });

  test('Google outage during release: nothing is released', async () => {
    const t = await manual();
    try {
      const { b } = await authorize(t, { arrival: '2027-08-20', departure: '2027-08-22' });
      await t.admin('POST', `/admin/bookings/${b.id}/cancel`, {});
      const ch = (await changes(t)).find((x) => x.kind === 'cancel_direct');
      t.world.googleStatus = 500;
      const r = await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'agreed with agent' });
      assert.equal(r.status, 502);
      assert.equal((await booking(t, b.id)).status, 'cancellation_pending');
    } finally { await t.stop(); }
  });
});

describe('reconciling the existing owner booking held by Travel Chapter', () => {
  const existing = {
    booking: guest({ guest_name: 'Fixture Lead', guest_surname: 'Lead', guest_email: 'guest@test.invalid', payer_name: 'Fixture Payer',
      arrival: '2026-12-30', departure: '2027-01-03', party_size: 5, amount_pence: 90000 }),
    payment: { payment_intent_id: 'pi_fixtureReconcile', amount_pence: 90000, livemode: true },
    historical_emails: ['confirmation', 'management_new_booking'],
    agent_ref: 'TCREF-FIXTURE',
  };

  test('links to the matching agent block; no Google publish, no email, no Stripe; re-run and re-sync are no-ops', async () => {
    const t = await start({ CAPTURE_MODE: 'manual' });
    try {
      t.world.tc = ics([
        { uid: 'agent-dec@tabs.test', start: '2026-12-16', end: '2026-12-30' },   // adjacent agent booking
        { uid: 'owner-ny@tabs.test', start: '2026-12-30', end: '2027-01-03' },    // owner booking as TC records it
      ]);
      await ready(t, { now: '2026-10-11T10:00:00Z' });
      const dry = await t.admin('POST', '/admin/import', existing, { 'x-test-now': '2026-10-11T10:05:00Z' });
      assert.equal(dry.data.result, 'dry_run');
      assert.ok(dry.data.actions.some((a) => /link 1 matching Travel Chapter block/.test(a)));
      const r = await t.admin('POST', '/admin/import', { ...existing, apply: true }, { 'x-test-now': '2026-10-11T10:06:00Z' });
      assert.equal(r.data.result, 'imported');
      assert.equal(r.data.booking.propagation, 'agent_confirmed');
      assert.equal(r.data.booking.agent_ref, 'TCREF-FIXTURE');
      assert.equal(t.world.google.size, 0, 'not re-published (agent already has it)');
      assert.equal(t.emails().length + t.stripeCalls().length, 0);

      const again = await t.admin('POST', '/admin/import', { ...existing, apply: true });
      assert.equal(again.data.result, 'already_imported');
      const s = await run(t, 'hourly', '2026-10-11T11:00:00Z');
      assert.deepEqual(s.data.calendars.flatMap((c) => c.anomalies), []);
      assert.equal((await changes(t)).length, 0);
    } finally { await t.stop(); }
  });

  test('a partial overlap with another agent block is refused', async () => {
    const t = await start({ CAPTURE_MODE: 'manual' });
    try {
      t.world.tc = ics([{ uid: 'agent-x@tabs.test', start: '2026-12-29', end: '2027-01-01' }]);
      await ready(t, { now: '2026-10-11T10:00:00Z' });
      const r = await t.admin('POST', '/admin/import', { ...existing, apply: true }, { 'x-test-now': '2026-10-11T10:05:00Z' });
      assert.equal(r.status, 409);
      assert.match(r.data.error, /not this booking/);
    } finally { await t.stop(); }
  });
});
