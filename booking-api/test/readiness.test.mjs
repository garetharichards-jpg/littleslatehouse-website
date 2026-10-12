// Owner-policy checks added with the verified handoff. Fictional data only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { guest, holdAndCheckout, ics, ready, sessionEvent, start } from './harness.mjs';

describe('pricing: discounts only through an approved rule', () => {
  test('no approved rules (default): any discount is refused; plain agreed total is accepted', async () => {
    const t = await start();
    try {
      await ready(t);
      const d = await t.admin('POST', '/admin/bookings', guest({ list_price_pence: 100000, discount_rule: 'direct10', amount_pence: 90000 }));
      assert.equal(d.status, 409);
      assert.match(d.data.error, /not approved/);
      assert.equal((await t.admin('POST', '/admin/bookings', guest())).status, 201);
    } finally { await t.stop(); }
  });

  test('approved rule: total must equal list price minus the rule exactly', async () => {
    const t = await start({ APPROVED_DISCOUNT_RULES: '{"direct10":10,"returning12":12}' });
    try {
      await ready(t);
      const wrong = await t.admin('POST', '/admin/bookings', guest({ list_price_pence: 100000, discount_rule: 'returning12', amount_pence: 90000 }));
      assert.equal(wrong.status, 409);
      assert.equal(wrong.data.expected_amount_pence, 88000);
      const ok = await t.admin('POST', '/admin/bookings', guest({ list_price_pence: 100000, discount_rule: 'direct10', amount_pence: 90000 }));
      assert.equal(ok.status, 201);
      assert.equal(ok.data.discount_rule, 'direct10');
      assert.equal(ok.data.list_price_pence, 100000);
      const unknown = await t.admin('POST', '/admin/bookings', guest({ arrival: '2027-05-01', departure: '2027-05-03', list_price_pence: 100000, discount_rule: 'friends50', amount_pence: 50000 }));
      assert.equal(unknown.status, 409);
    } finally { await t.stop(); }
  });
});

describe('damage deposit: not collected, never refunded', () => {
  test('a direct booking cannot carry a damage deposit or waiver; Checkout has one accommodation line only', async () => {
    const t = await start();
    try {
      await ready(t);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ damage_deposit_pence: 30000 }))).status, 400);
      assert.equal((await t.admin('POST', '/admin/bookings', guest({ damage_waiver_pence: 3500 }))).status, 400);
      await holdAndCheckout(t);
      const form = new URLSearchParams(t.stripeCalls()[0].body);
      assert.equal(form.get('line_items[0][price_data][unit_amount]'), '50000');
      assert.equal(form.get('line_items[1][price_data][unit_amount]'), null, 'no second (deposit) line');
      for (const p of ['/admin/refund', '/admin/deposits/refund', '/admin/bookings/x/deposit']) {
        assert.equal((await t.admin('POST', p, {})).status, 404, p);
      }
    } finally { await t.stop(); }
  });
});

describe('New Year reconciliation with the welcome already scheduled in Gmail', () => {
  const payload = {
    booking: guest({ guest_name: 'Fixture Lead', guest_surname: 'Lead', guest_email: 'guest@test.invalid', payer_name: 'Fixture Payer',
      arrival: '2026-12-30', departure: '2027-01-03', party_size: 5, amount_pence: 90000 }),
    payment: { payment_intent_id: 'pi_fixtureReconcile', amount_pence: 90000, livemode: true },
    agent_ref: 'TCREF-FIXTURE',
    historical_emails: [],
    external_emails: [{ template: 'welcome', note: 'personalised welcome scheduled in owner Gmail', scheduled_for: '2026-12-27' }],
    prior_correspondence: ['payment-link email sent to guest 2026-10-04'],
  };

  test('nothing is ever sent by this system; the 27 vs 28 Dec discrepancy is flagged for approval', async () => {
    const t = await start({ CAPTURE_MODE: 'manual' });
    try {
      t.world.tc = ics([{ uid: 'owner-ny@tabs.test', start: '2026-12-30', end: '2027-01-03' }]);
      await ready(t, { now: '2026-10-11T10:00:00Z' });
      const dry = await t.admin('POST', '/admin/import', payload, { 'x-test-now': '2026-10-11T10:05:00Z' });
      assert.ok(dry.data.actions.some((a) => /'welcome' as handled outside this system \(scheduled for 2026-12-27\)/.test(a)));
      assert.ok(dry.data.warnings.some((w) => /no post-payment confirmation recorded/.test(w)));
      const r = await t.admin('POST', '/admin/import', { ...payload, apply: true }, { 'x-test-now': '2026-10-11T10:06:00Z' });
      assert.equal(r.data.result, 'imported');

      for (const day of ['2026-12-27', '2026-12-28', '2026-12-29']) {
        const d = await t.admin('POST', '/admin/run', { job: 'daily', now: `${day}T06:45:00Z` });
        assert.ok(!d.data.issues.some((i) => /has no welcome email sent/.test(i)), 'not reported as missing');
        if (day === '2026-12-28') {
          assert.ok(d.data.issues.some((i) => /scheduled outside this system for 2026-12-27; policy date is 2026-12-28/.test(i)));
        }
      }
      const guestMail = t.emails().filter((e) => e.to[0] === 'guest@test.invalid');
      assert.equal(guestMail.length, 0, 'no second welcome, no confirmation');
      const audit = await t.db.prepare("SELECT detail FROM audit_log WHERE action = 'imported'").first();
      assert.match(audit.detail, /payment-link email sent to guest 2026-10-04/);
      assert.match(audit.detail, /pi_fixtureReconcile/);
    } finally { await t.stop(); }
  });
});

describe('owner-approved external welcome date', () => {
  test('a Gmail-scheduled date marked [owner_approved] is not flagged', async () => {
    const t = await start({ CAPTURE_MODE: 'manual' });
    try {
      t.world.tc = ics([{ uid: 'owner-ny@tabs.test', start: '2026-12-30', end: '2027-01-03' }]);
      await ready(t, { now: '2026-10-11T10:00:00Z' });
      await t.admin('POST', '/admin/import', {
        booking: guest({ arrival: '2026-12-30', departure: '2027-01-03', party_size: 5, amount_pence: 90000 }),
        external_emails: [{ template: 'welcome', note: 'scheduled in Gmail [owner_approved]', scheduled_for: '2026-12-27' }],
        apply: true,
      }, { 'x-test-now': '2026-10-11T10:05:00Z' });
      const d = await t.admin('POST', '/admin/run', { job: 'daily', now: '2026-12-28T06:45:00Z' });
      assert.ok(!d.data.issues.some((i) => /scheduled outside this system/.test(i)));
      assert.equal(t.emails().filter((e) => e.to[0] === 'guest@test.invalid').length, 0);
    } finally { await t.stop(); }
  });
});

describe('cleaner / management notifications', () => {
  test('management gets new-booking and cancellation notices at the test address only', async () => {
    const t = await start({ CAPTURE_MODE: 'manual' });
    try {
      await ready(t);
      await t.admin('PUT', '/admin/templates/management_cancellation', {
        subject: 'TEST released {{booking_id}}', html: '<p>{{arrival_date}}</p>', text: '{{arrival_date}}', approved: true,
      });
      const { booking: b } = await holdAndCheckout(t, { arrival: '2027-06-10', departure: '2027-06-14' });
      await t.webhook(sessionEvent('checkout.session.completed', b, {
        id: 'cs_test_1', payment_status: 'unpaid', payment_intent: 'pi_m', metadata: { booking_id: b.id, capture_mode: 'manual' },
      }));
      await t.admin('POST', `/admin/bookings/${b.id}/confirm`, { owner_verified_with_agent: true });
      await t.admin('POST', `/admin/bookings/${b.id}/cancel`, { reason: 'test' });
      const ch = (await t.admin('GET', '/admin/changes')).data.find((c) => c.kind === 'cancel_direct');
      await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'agreed with agent (test)' });
      const mgmt = t.emails().filter((e) => e.to[0] === 'mgmt@test.invalid').map((e) => e.subject);
      assert.ok(mgmt.some((s) => /New confirmed booking/.test(s)));
      assert.ok(mgmt.some((s) => /TEST released/.test(s)));
      assert.ok(t.emails().every((e) => e.to[0].endsWith('@test.invalid')));
    } finally { await t.stop(); }
  });

  test('a real management address is blocked while automation is off', async () => {
    const t = await start({ MANAGEMENT_EMAIL: 'cleaner@example.com' });
    try {
      await ready(t);
      const { booking: b } = await holdAndCheckout(t);
      const r = await t.webhook(sessionEvent('checkout.session.completed', b));
      assert.equal(r.data.result.emails.management.status, 'blocked');
      assert.equal(t.emails().filter((e) => e.to[0] === 'cleaner@example.com').length, 0);
    } finally { await t.stop(); }
  });
});

describe('PUBLISH_MODE=tc_portal (live default): owner enters direct bookings in the Travel Chapter portal', () => {
  test('authorise -> no Google write -> owner told to enter it in the portal -> agent feed echo confirms -> coordinated cancel without Google', async () => {
    const t = await start({ CAPTURE_MODE: 'manual', PUBLISH_MODE: 'tc_portal' });
    try {
      await ready(t);
      const { booking: b } = await holdAndCheckout(t, { arrival: '2027-09-10', departure: '2027-09-14' });
      const r = await t.webhook(sessionEvent('checkout.session.completed', b, {
        id: 'cs_test_1', payment_status: 'unpaid', payment_intent: 'pi_p', metadata: { booking_id: b.id, capture_mode: 'manual' },
      }));
      assert.equal(r.data.result.action, 'authorized');
      assert.equal(t.world.google.size, 0, 'nothing written to Google');
      assert.equal(t.world.calls.filter((c) => c.url.includes('googleapis.com/calendar')).length, 0);
      const owner = t.emails().find((e) => /Action needed/.test(e.subject));
      assert.match(owner.text, /owner booking in the Travel Chapter owner portal/);

      let d = await t.admin('POST', '/admin/run', { job: 'daily' });
      assert.ok(d.data.issues.some((i) => /entered as an owner booking in the Travel Chapter portal\?/.test(i)));

      // Owner enters it in the portal; the agent feed now shows the block.
      t.world.tc = ics([{ uid: 'tc-2027-06-01-0@tabs.test', start: '2027-06-01', end: '2027-06-03' }, { uid: 'owner-entry@tabs.test', start: b.arrival, end: b.departure }]);
      await t.admin('POST', '/admin/run', { job: 'hourly' });
      assert.equal((await t.admin('GET', `/admin/bookings/${b.id}`)).data.booking.propagation, 'agent_confirmed');
      assert.equal((await t.admin('POST', `/admin/bookings/${b.id}/confirm`, {})).data.action, 'confirmed');

      await t.admin('POST', `/admin/bookings/${b.id}/cancel`, { reason: 'test' });
      const ch = (await t.admin('GET', '/admin/changes')).data.find((c) => c.kind === 'cancel_direct');
      assert.match(ch.draft_message, /cancel\/release this owner booking/);
      const done = await t.admin('POST', `/admin/changes/${ch.id}/complete`, { acknowledgment: 'cancelled in portal with agent, same hour' });
      assert.equal(done.data.change.status, 'released');
      assert.equal(t.world.calls.filter((c) => c.url.includes('googleapis.com/calendar')).length, 0, 'still no Google calls');
    } finally { await t.stop(); }
  });
});
