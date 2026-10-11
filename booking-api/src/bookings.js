// Booking lifecycle.
//
// Safe default flow (CAPTURE_MODE=manual), because Travel Chapter's iCal import can lag up to 24 hours:
//   owner quote/hold -> guest pays via Checkout with card AUTHORISED only -> booking 'authorized'
//   -> block published to the owner's Google calendar (the feed Travel Chapter imports)
//   -> Travel Chapter feed shows the block (or the owner verifies dates with the agent)
//   -> owner confirms -> funds captured -> 'confirmed' + emails.
// Dates are never released by a feed disappearing; releases of published dates go through pending_changes.

import { blockingEventsOverlapping, calendarStatus, syncAll } from './calendar.js';
import { openChange, tcCancellationDraft } from './changes.js';
import { sendEmail } from './email.js';
import { publishBooking } from './google.js';
import {
  HttpError, audit, automationEnabled, flag, iso, isDate, newBookingId, nightsBetween, timingSafeEqual, uuid,
} from './util.js';

// Allowed state transitions. Anything else is refused.
export const TRANSITIONS = {
  hold: ['pending_payment', 'authorized', 'confirmed', 'cancelled', 'expired'],
  pending_payment: ['authorized', 'confirmed', 'hold', 'cancelled', 'expired'],
  authorized: ['confirmed', 'cancellation_pending', 'cancelled', 'expired'],
  expired: ['authorized', 'confirmed'], // only via a verified late payment when nights are still free
  confirmed: ['cancellation_pending'],
  cancellation_pending: ['cancelled'],
  cancelled: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLISHED = ['published', 'agent_confirmed', 'overdue'];

export async function getBooking(db, id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
}

export async function transition(db, now, id, to, extraSql = '', extraBinds = []) {
  const from = Object.keys(TRANSITIONS).filter((s) => TRANSITIONS[s].includes(to));
  const res = await db.prepare(
    `UPDATE bookings SET status = ?, updated_at = ?${extraSql} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
  ).bind(to, iso(now), ...extraBinds, id, ...from).run();
  return res.meta.changes === 1;
}

export async function releaseNights(db, id) {
  await db.prepare('DELETE FROM night_locks WHERE owner = ?').bind(`booking:${id}`).run();
}

function lockStatements(db, id, arrival, departure, now) {
  return nightsBetween(arrival, departure).map((n) =>
    db.prepare('INSERT INTO night_locks (night, owner, created_at) VALUES (?, ?, ?)').bind(n, `booking:${id}`, iso(now)));
}

async function conflictsFor(db, arrival, departure, exceptBooking) {
  const nights = nightsBetween(arrival, departure);
  const { results } = await db.prepare(
    `SELECT night, owner FROM night_locks WHERE night IN (${nights.map(() => '?').join(',')}) ORDER BY night`,
  ).bind(...nights).all();
  const external = (await blockingEventsOverlapping(db, arrival, departure))
    .filter((e) => e.linked_booking_id !== exceptBooking)
    .map((e) => ({ source: e.source_id, kind: e.kind, start: e.start_date, end: e.end_date, state: e.state }));
  return { direct: results.filter((r) => r.owner !== `booking:${exceptBooking}`), external };
}

const isLockFailure = (err) => /UNIQUE|PRIMARY KEY|constraint|EXTERNAL_BLOCK/i.test(String(err?.message));

function validateBookingInput(b) {
  const errs = [];
  if (!b || typeof b !== 'object') throw new HttpError(400, 'body required');
  if (!b.guest_name || typeof b.guest_name !== 'string') errs.push('guest_name');
  if (!b.guest_surname || typeof b.guest_surname !== 'string') errs.push('guest_surname');
  if (!EMAIL_RE.test(b.guest_email || '')) errs.push('guest_email');
  if (!isDate(b.arrival)) errs.push('arrival');
  if (!isDate(b.departure) || !(b.departure > b.arrival)) errs.push('departure');
  if (!Number.isInteger(b.party_size) || b.party_size < 1 || b.party_size > 6) errs.push('party_size (1-6)');
  // The price is whatever the owner agreed with the guest; the API never invents rates.
  if (!Number.isInteger(b.amount_pence) || b.amount_pence <= 0) errs.push('amount_pence (agreed total, integer pence)');
  if (errs.length) throw new HttpError(400, 'invalid fields', { fields: errs });
}

// Direct damage deposits/waivers are not approved for direct bookings; the agent's scheme does not apply here.
function refuseDamageDeposit(b) {
  if (b.damage_deposit_pence || b.damage_waiver_pence) {
    throw new HttpError(400, 'damage deposit/waiver collection is not approved for direct bookings');
  }
}

// Discounts apply only through an owner-approved rule (APPROVED_DISCOUNT_RULES, JSON {"name": percent}).
// With no approved rules (the default), any discount is refused. The agreed total must match exactly.
export function validatePricing(env, b) {
  refuseDamageDeposit(b);
  if (!b.discount_rule && b.list_price_pence === undefined) return { list_price_pence: null, discount_rule: null };
  let rules = {};
  try { rules = JSON.parse(env.APPROVED_DISCOUNT_RULES || '{}'); } catch { rules = {}; }
  if (!b.discount_rule || !(b.discount_rule in rules)) {
    throw new HttpError(409, 'discount rule not approved', { rule: b.discount_rule ?? null, approved: Object.keys(rules) });
  }
  if (!Number.isInteger(b.list_price_pence) || b.list_price_pence <= 0) throw new HttpError(400, 'list_price_pence required with a discount');
  const pct = Number(rules[b.discount_rule]);
  const expected = b.list_price_pence - Math.round((b.list_price_pence * pct) / 100);
  if (b.amount_pence !== expected) {
    throw new HttpError(409, 'agreed total does not match the approved discount rule', { expected_amount_pence: expected, pct });
  }
  return { list_price_pence: b.list_price_pence, discount_rule: b.discount_rule };
}

// ---- Holds (created by the owner after agreeing dates/price with the guest) ----

async function requireFreshCalendars(env, db, now, fetcher) {
  // Check immediately before quoting/checkout: re-pull the agent feed rather than trusting the last cron run.
  if (flag(env.SYNC_BEFORE_QUOTE ?? 'true')) await syncAll(env, db, now, fetcher, { kind: 'agent' });
  const cal = await calendarStatus(env, db, now);
  if (!cal.reliable) throw new HttpError(409, 'availability unknown: calendar source not reliable', { problems: cal.problems });
}

export async function createHold(env, db, now, input, fetcher = fetch) {
  validateBookingInput(input);
  const pricing = validatePricing(env, input);
  await requireFreshCalendars(env, db, now, fetcher);

  const id = newBookingId(input.arrival);
  const payToken = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(now.getTime() + Number(env.HOLD_HOURS || 48) * 3600_000);
  const nights = nightsBetween(input.arrival, input.departure).length;

  try {
    // One transaction: booking row + all night locks. The trigger refuses nights under an external block.
    await db.batch([
      db.prepare(
        `INSERT INTO bookings (id, guest_name, guest_surname, guest_email, payer_name, party_size, arrival, departure, nights,
           amount_pence, list_price_pence, discount_rule, currency, status, hold_expires_at, pay_token, source, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gbp', 'hold', ?, ?, 'direct', ?, ?, ?)`,
      ).bind(id, input.guest_name, input.guest_surname, input.guest_email, input.payer_name ?? null, input.party_size,
        input.arrival, input.departure, nights, input.amount_pence, pricing.list_price_pence, pricing.discount_rule,
        iso(expires), payToken, input.notes ?? null, iso(now), iso(now)),
      ...lockStatements(db, id, input.arrival, input.departure, now),
    ]);
  } catch (err) {
    if (isLockFailure(err)) throw new HttpError(409, 'dates unavailable', { conflicts: await conflictsFor(db, input.arrival, input.departure) });
    throw err;
  }
  await audit(db, now, 'admin', 'hold_created', id, { arrival: input.arrival, departure: input.departure });
  return { ...(await getBooking(db, id)), pay_url: payUrl(env, id, payToken) };
}

export function payUrl(env, id, token) {
  return `${(env.API_BASE_URL || '').replace(/\/$/, '')}/pay/${encodeURIComponent(id)}?t=${token}`;
}

export async function expireHolds(db, now) {
  const cutoff = iso(new Date(now.getTime() - 15 * 60_000)); // allow webhook lag past Checkout expiry
  const { results } = await db.prepare(
    "SELECT id FROM bookings WHERE status IN ('hold','pending_payment') AND hold_expires_at < ?",
  ).bind(cutoff).all();
  const expired = [];
  for (const { id } of results) {
    // Holds are never published externally, so releasing them needs no coordination.
    if (await transition(db, now, id, 'expired')) {
      await releaseNights(db, id);
      await audit(db, now, 'system', 'hold_expired', id);
      expired.push(id);
    }
  }
  return expired;
}

// Release dates directly if they never left this system; otherwise queue a coordinated change.
async function releaseOrQueue(env, db, now, b, endStatus, reason) {
  if (PUBLISHED.includes(b.propagation)) {
    if (await transition(db, now, b.id, 'cancellation_pending')) {
      const change = await openChange(db, now, {
        kind: 'cancel_direct', booking_id: b.id, start_date: b.arrival, end_date: b.departure,
        draft_message: tcCancellationDraft(env, b), detail: { reason },
      });
      return { action: 'cancellation_pending', booking: b.id, change };
    }
    return { action: 'noop' };
  }
  if (await transition(db, now, b.id, endStatus)) {
    await releaseNights(db, b.id);
    await audit(db, now, 'system', `released_${reason}`, b.id);
    return { action: 'released', booking: b.id };
  }
  return { action: 'noop' };
}

// ---- Stripe ----

export function stripeKeyIsLive(env) {
  return /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
}

export function captureMode(env) {
  return env.CAPTURE_MODE === 'automatic' ? 'automatic' : 'manual';
}

export function assertPaymentsAllowed(env) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'payments not configured');
  if (stripeKeyIsLive(env)) {
    if (!(automationEnabled(env) && env.STRIPE_MODE === 'live')) throw new HttpError(403, 'live payments are disabled (AUTOMATION_ENABLED/STRIPE_MODE)');
    if (captureMode(env) === 'automatic' && !flag(env.ALLOW_IMMEDIATE_CAPTURE_LIVE)) {
      throw new HttpError(403, 'immediate capture is disabled in live until cross-channel availability is confirmed');
    }
  }
  if (!stripeKeyIsLive(env) && env.STRIPE_MODE === 'live') throw new HttpError(500, 'STRIPE_MODE=live but key is not live');
  if (env.PAYMENT_POLICY !== 'full_upfront') {
    // Deposit/balance schemes are not approved by the owner; nothing else is implemented.
    throw new HttpError(409, 'PAYMENT_POLICY not approved/configured (only full_upfront is supported)');
  }
}

async function stripePost(env, path, form, idempotencyKey, fetcher) {
  const res = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': idempotencyKey,
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Stripe error: ${body?.error?.message || res.status}`);
  return body;
}

const fmtGBP = (p) => `£${(p / 100).toFixed(2)}`;

export async function checkoutForPayLink(env, db, now, id, token, fetcher = fetch) {
  const b = await getBooking(db, id);
  if (!b || !b.pay_token || !token || !timingSafeEqual(token, b.pay_token)) throw new HttpError(404, 'not found');
  if (b.status === 'confirmed' || b.status === 'authorized') return { already_paid: true, booking: b };
  if (!['hold', 'pending_payment'].includes(b.status)) throw new HttpError(410, 'this booking hold is no longer active');
  assertPaymentsAllowed(env);

  // Re-use an open session rather than creating a second one.
  const open = await db.prepare(
    "SELECT * FROM payments WHERE booking_id = ? AND status = 'pending' AND checkout_expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(id, iso(new Date(now.getTime() + 5 * 60_000))).first();
  if (open?.checkout_url) return { url: open.checkout_url, reused: true };

  // Last check before money moves: fresh agent feed, and nothing new over these dates.
  await requireFreshCalendars(env, db, now, fetcher);
  const { external } = await conflictsFor(db, b.arrival, b.departure, b.id);
  if (external.length) {
    await openChange(db, now, { kind: 'overlap', booking_id: b.id, start_date: b.arrival, end_date: b.departure,
      detail: { stage: 'before checkout', external } });
    throw new HttpError(409, 'these dates have just been blocked on another channel; the owner has been alerted', { external });
  }

  const holdEnd = new Date(b.hold_expires_at);
  const maxEnd = new Date(now.getTime() + 23.5 * 3600_000);
  const expiresAt = holdEnd < maxEnd ? holdEnd : maxEnd;
  if (expiresAt - now < 31 * 60_000) throw new HttpError(410, 'hold expires too soon to take payment; ask the owner to renew it');

  const mode = captureMode(env);
  const site = (env.SITE_URL || 'https://www.littleslatehouse.co.uk').replace(/\/$/, '');
  const form = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': b.currency,
    'line_items[0][price_data][unit_amount]': String(b.amount_pence),
    'line_items[0][price_data][product_data][name]': `Little Slate House: ${b.arrival} to ${b.departure} (${b.nights} nights)`,
    customer_email: b.guest_email,
    client_reference_id: b.id,
    'metadata[booking_id]': b.id,
    'metadata[capture_mode]': mode,
    'payment_intent_data[metadata][booking_id]': b.id,
    'payment_intent_data[description]': `Little Slate House booking ${b.id}`,
    expires_at: String(Math.floor(expiresAt.getTime() / 1000)),
    success_url: `${site}/availability/?booking=${encodeURIComponent(b.id)}&paid=1`,
    cancel_url: `${site}/availability/?booking=${encodeURIComponent(b.id)}&cancelled=1`,
  };
  if (mode === 'manual') {
    // Deferred authorisation: hold the funds, capture only after the dates are confirmed across channels.
    form['payment_intent_data[capture_method]'] = 'manual';
    form['payment_method_types[0]'] = 'card';
  }
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM payments WHERE booking_id = ?').bind(id).first();
  const session = await stripePost(env, 'checkout/sessions', form, `checkout-${id}-${count}`, fetcher);

  await db.batch([
    db.prepare(
      `INSERT INTO payments (id, booking_id, stripe_checkout_session_id, amount_pence, currency, status, livemode,
         checkout_url, checkout_expires_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'checkout', ?, ?)`,
    ).bind(uuid(), id, session.id, b.amount_pence, b.currency, session.livemode ? 1 : 0, session.url, iso(expiresAt), iso(now), iso(now)),
    db.prepare("UPDATE bookings SET status = 'pending_payment', updated_at = ? WHERE id = ? AND status IN ('hold','pending_payment')")
      .bind(iso(now), id),
  ]);
  await audit(db, now, 'guest', 'checkout_started', id, { session: session.id, capture: mode });
  return { url: session.url };
}

// ---- Emails ----

export async function bookingVars(env, b, template) {
  const fmt = (d) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).formatToParts(new Date(d + 'T00:00:00Z')).map((x) => [x.type, x.value]));
    return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`; // e.g. Wednesday 30 December 2026
  };
  const vars = {
    booking_id: b.id,
    guest_name: b.guest_name,
    guest_surname: b.guest_surname,
    arrival_date: fmt(b.arrival),
    departure_date: fmt(b.departure),
    nights: String(b.nights),
    party_size: String(b.party_size),
    amount: fmtGBP(b.amount_pence),
    management_contact: env.MANAGEMENT_CONTACT_TEXT || '',
    propagation: b.propagation,
  };
  // The entry code exists only as a Worker secret and only for the welcome email.
  if (template === 'welcome' && env.ENTRY_CODE) vars.entry_code = env.ENTRY_CODE;
  return vars;
}

async function sendBookingConfirmedEmails(env, db, now, b, fetcher) {
  const out = {};
  out.confirmation = await sendEmail(env, db, now, {
    bookingId: b.id, template: 'confirmation', recipient: b.guest_email,
    dedupeKey: `confirmation:${b.id}`, vars: await bookingVars(env, b, 'confirmation'),
  }, fetcher);
  if (env.MANAGEMENT_EMAIL) {
    out.management = await sendEmail(env, db, now, {
      bookingId: b.id, template: 'management_new_booking', recipient: env.MANAGEMENT_EMAIL,
      dedupeKey: `management_new_booking:${b.id}`, vars: await bookingVars(env, b, 'management_new_booking'),
    }, fetcher);
  }
  return out;
}

// Publish the block to the owner's Google calendar (idempotent) so Travel Chapter imports it.
async function publish(env, db, now, b, fetcher) {
  if (PUBLISHED.includes(b.propagation)) return { ok: true, already: true };
  const r = await publishBooking(env, b, fetcher);
  if (r.ok) {
    await db.prepare("UPDATE bookings SET google_event_id = ?, published_at = ?, propagation = 'published', updated_at = ? WHERE id = ?")
      .bind(r.event_id, iso(now), iso(now), b.id).run();
  } else {
    await db.prepare("UPDATE bookings SET propagation = 'publish_failed', updated_at = ? WHERE id = ?").bind(iso(now), b.id).run();
  }
  await audit(db, now, 'system', r.ok ? 'published_to_google' : 'publish_failed', b.id, r.ok ? null : { reason: r.reason });
  return r;
}

// Re-take nights for an expired booking that has just been paid/authorised. Returns false if taken.
async function relockIfExpired(db, now, b) {
  if (b.status !== 'expired') return true;
  try {
    await db.batch(lockStatements(db, b.id, b.arrival, b.departure, now));
    return true;
  } catch (err) {
    if (isLockFailure(err)) return false;
    throw err;
  }
}

async function finalizeConfirmed(env, db, now, b, fetcher, via) {
  if (!(await transition(db, now, b.id, 'confirmed', ', hold_expires_at = NULL'))) {
    // State changed underneath us (e.g. cancelled concurrently): never email on an unconfirmed booking.
    await audit(db, now, 'stripe', 'confirm_transition_refused', b.id, { via });
    throw new Error(`booking ${b.id} could not be confirmed from its current state`);
  }
  await audit(db, now, via === 'owner' ? 'admin' : 'stripe', 'confirmed', b.id, { via });
  const confirmed = await getBooking(db, b.id);
  const published = await publish(env, db, now, confirmed, fetcher);
  const emails = await sendBookingConfirmedEmails(env, db, now, confirmed, fetcher);
  return { action: 'confirmed', booking: b.id, emails, published: published.ok };
}

async function upsertPayment(db, now, b, p) {
  const existing = p.session ? await db.prepare('SELECT * FROM payments WHERE stripe_checkout_session_id = ?').bind(p.session).first()
    : await db.prepare('SELECT * FROM payments WHERE stripe_payment_intent_id = ?').bind(p.pi).first();
  if (existing) {
    await db.prepare('UPDATE payments SET status = ?, stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id), updated_at = ? WHERE id = ?')
      .bind(p.status, p.pi ?? null, iso(now), existing.id).run();
  } else {
    await db.prepare(
      `INSERT INTO payments (id, booking_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_pence, currency,
         status, livemode, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'checkout', ?, ?)`,
    ).bind(uuid(), b.id, p.session ?? null, p.pi ?? null, p.amount, p.currency, p.status, p.livemode ? 1 : 0, iso(now), iso(now)).run();
  }
}

async function guardPayment(db, now, b, p) {
  if (p.pi) {
    const byPi = await db.prepare('SELECT source FROM payments WHERE stripe_payment_intent_id = ?').bind(p.pi).first();
    if (byPi?.source === 'reconciled') return { action: 'noop', reason: 'payment intent already reconciled' };
  }
  if (p.amount !== b.amount_pence || p.currency !== b.currency) {
    await audit(db, now, 'stripe', 'amount_mismatch', b.id, { paid: p.amount, expected: b.amount_pence });
    return { action: 'flagged', reason: 'amount mismatch; not confirmed, needs owner review' };
  }
  if (b.status === 'cancelled' || b.status === 'cancellation_pending') {
    await audit(db, now, 'stripe', 'paid_after_cancel', b.id, { pi: p.pi ?? null });
    return { action: 'flagged', reason: 'payment for cancelled booking; owner must decide (no automatic refund)' };
  }
  return null;
}

// Automatic capture: money has moved. Confirm (still publishing to Google for the agent).
async function markPaid(env, db, now, p, fetcher) {
  const b = p.bookingId && (await getBooking(db, p.bookingId));
  if (!b) return { action: 'ignored', reason: 'no matching booking' };
  if (b.status === 'confirmed') return { action: 'noop', reason: 'already confirmed' };
  const stop = await guardPayment(db, now, b, p);
  if (stop) return stop;
  await upsertPayment(db, now, b, { ...p, status: 'succeeded' });
  if (!(await relockIfExpired(db, now, b))) {
    await audit(db, now, 'stripe', 'paid_after_expiry_conflict', b.id, { pi: p.pi ?? null });
    return { action: 'flagged', reason: 'late payment but dates taken; owner must resolve (no automatic refund)' };
  }
  return finalizeConfirmed(env, db, now, b, fetcher, 'stripe');
}

// Manual capture: card authorised, nothing charged yet. Publish the block and wait for cross-channel confirmation.
async function markAuthorized(env, db, now, p, fetcher) {
  const b = p.bookingId && (await getBooking(db, p.bookingId));
  if (!b) return { action: 'ignored', reason: 'no matching booking' };
  if (['authorized', 'confirmed'].includes(b.status)) return { action: 'noop', reason: `already ${b.status}` };
  const stop = await guardPayment(db, now, b, p);
  if (stop) return stop;
  await upsertPayment(db, now, b, { ...p, status: 'authorized' });
  if (!(await relockIfExpired(db, now, b))) {
    await audit(db, now, 'stripe', 'paid_after_expiry_conflict', b.id, { pi: p.pi ?? null });
    return { action: 'flagged', reason: 'authorised after expiry but dates taken; owner should cancel the authorisation' };
  }
  if (!(await transition(db, now, b.id, 'authorized', ', hold_expires_at = NULL'))) {
    throw new Error(`booking ${b.id} could not be authorised from its current state`);
  }
  await audit(db, now, 'stripe', 'authorized', b.id, { pi: p.pi ?? null });
  const auth = await getBooking(db, b.id);
  const published = await publish(env, db, now, auth, fetcher);

  // Anything external over these dates now is a potential double booking: tell the owner straight away.
  const { external } = await conflictsFor(db, b.arrival, b.departure, b.id);
  if (external.length) {
    await openChange(db, now, { kind: 'overlap', booking_id: b.id, start_date: b.arrival, end_date: b.departure, detail: { stage: 'after authorisation', external } });
  }
  const notify = env.MAINTENANCE_EMAIL ? await sendEmail(env, db, now, {
    bookingId: b.id, template: 'owner_authorization', recipient: env.MAINTENANCE_EMAIL,
    dedupeKey: `owner_authorization:${b.id}`, vars: await bookingVars(env, auth, 'owner_authorization'),
  }, fetcher) : null;
  const guest = await sendEmail(env, db, now, {
    bookingId: b.id, template: 'authorization_received', recipient: b.guest_email,
    dedupeKey: `authorization_received:${b.id}`, vars: await bookingVars(env, auth, 'authorization_received'),
  }, fetcher);
  return { action: 'authorized', booking: b.id, published: published.ok, overlap: external.length > 0, emails: { owner: notify, guest } };
}

// Owner confirms an authorised booking: capture the funds, then confirm.
export async function confirmAuthorized(env, db, now, id, body, fetcher = fetch) {
  const b = await getBooking(db, id);
  if (!b) throw new HttpError(404, 'not found');
  if (b.status === 'confirmed') return { action: 'noop', reason: 'already confirmed' };
  if (b.status !== 'authorized') throw new HttpError(409, `booking is ${b.status}, not authorized`);
  const overlap = await db.prepare(
    "SELECT id FROM pending_changes WHERE booking_id = ? AND kind = 'overlap' AND status IN ('open','coordinated') LIMIT 1",
  ).bind(id).first();
  if (overlap) throw new HttpError(409, 'an unresolved overlap with another channel exists for these dates', { change: overlap.id });
  if (b.propagation !== 'agent_confirmed' && body?.owner_verified_with_agent !== true) {
    throw new HttpError(409, 'Travel Chapter has not yet shown these dates as blocked; confirm with the agent and pass owner_verified_with_agent: true', { propagation: b.propagation });
  }
  assertPaymentsAllowed(env);
  const pay = await db.prepare("SELECT * FROM payments WHERE booking_id = ? AND status = 'authorized' ORDER BY created_at DESC LIMIT 1").bind(id).first();
  if (!pay?.stripe_payment_intent_id) throw new HttpError(409, 'no authorised payment found');
  const pi = await stripePost(env, `payment_intents/${encodeURIComponent(pay.stripe_payment_intent_id)}/capture`, {}, `capture-${id}`, fetcher);
  if (pi.status !== 'succeeded') throw new HttpError(502, `capture not completed (status ${pi.status})`);
  await db.prepare("UPDATE payments SET status = 'succeeded', updated_at = ? WHERE id = ?").bind(iso(now), pay.id).run();
  await audit(db, now, 'admin', 'captured', id, { pi: pay.stripe_payment_intent_id, owner_verified_with_agent: body?.owner_verified_with_agent === true, note: body?.note ?? null });
  return finalizeConfirmed(env, db, now, await getBooking(db, id), fetcher, 'owner');
}

async function sessionEnded(env, db, now, session, why) {
  const id = session.metadata?.booking_id || session.client_reference_id;
  if (!id) return { action: 'ignored' };
  await db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE stripe_checkout_session_id = ? AND status = 'pending'")
    .bind(iso(now), session.id).run();
  const other = await db.prepare(
    "SELECT 1 FROM payments WHERE booking_id = ? AND status = 'pending' AND stripe_checkout_session_id != ? LIMIT 1",
  ).bind(id, session.id).first();
  if (other) return { action: 'noop', reason: 'another checkout session is open' };
  const b = await getBooking(db, id);
  if (!b || !['hold', 'pending_payment'].includes(b.status)) return { action: 'noop' };
  if (b.hold_expires_at && new Date(b.hold_expires_at) > now && (await transition(db, now, id, 'hold'))) {
    // The owner's hold still has time left: keep the dates so the guest can use the pay link again.
    await audit(db, now, 'stripe', `returned_to_hold_${why}`, id, { session: session.id });
    return { action: 'returned_to_hold', booking: id };
  }
  return releaseOrQueue(env, db, now, b, 'expired', why);
}

async function authorizationEnded(env, db, now, pi) {
  await db.prepare("UPDATE payments SET status = 'canceled', updated_at = ? WHERE stripe_payment_intent_id = ? AND status IN ('pending','authorized')")
    .bind(iso(now), pi.id).run();
  const b = pi.metadata?.booking_id && (await getBooking(db, pi.metadata.booking_id));
  if (!b || b.status !== 'authorized') return { action: 'recorded' };
  await audit(db, now, 'stripe', 'authorization_ended', b.id, { pi: pi.id, reason: pi.cancellation_reason ?? null });
  return releaseOrQueue(env, db, now, b, 'expired', 'authorization_ended');
}

const fromSession = (s) => ({
  bookingId: s.metadata?.booking_id || s.client_reference_id, session: s.id, pi: s.payment_intent ?? null,
  amount: s.amount_total, currency: s.currency, livemode: s.livemode,
});
const fromIntent = (pi, amount) => ({
  bookingId: pi.metadata?.booking_id, session: null, pi: pi.id, amount, currency: pi.currency, livemode: pi.livemode,
});

export async function handleStripeEvent(env, db, now, event, fetcher) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.payment_status === 'paid') return markPaid(env, db, now, fromSession(obj), fetcher);
      if (obj.metadata?.capture_mode === 'manual' && obj.payment_intent) return markAuthorized(env, db, now, fromSession(obj), fetcher);
      return { action: 'waiting', reason: `payment_status=${obj.payment_status}` };
    case 'checkout.session.async_payment_succeeded':
      return markPaid(env, db, now, fromSession(obj), fetcher);
    case 'payment_intent.amount_capturable_updated':
      if (obj.status === 'requires_capture') return markAuthorized(env, db, now, fromIntent(obj, obj.amount_capturable), fetcher);
      return { action: 'ignored' };
    case 'payment_intent.succeeded': {
      // Captured (by the owner here, or in the Stripe dashboard).
      const b = obj.metadata?.booking_id && (await getBooking(db, obj.metadata.booking_id));
      if (b?.status === 'authorized') {
        await db.prepare("UPDATE payments SET status = 'succeeded', updated_at = ? WHERE stripe_payment_intent_id = ?").bind(iso(now), obj.id).run();
        return finalizeConfirmed(env, db, now, b, fetcher, 'stripe');
      }
      return { action: 'noop' };
    }
    case 'payment_intent.canceled':
      return authorizationEnded(env, db, now, obj);
    case 'checkout.session.async_payment_failed':
      return sessionEnded(env, db, now, obj, 'payment_failed');
    case 'checkout.session.expired':
      return sessionEnded(env, db, now, obj, 'session_expired');
    case 'payment_intent.payment_failed':
      // A declined card inside Checkout: the guest can retry in the same session. Record only.
      await audit(db, now, 'stripe', 'payment_attempt_failed', obj.metadata?.booking_id ?? null,
        { pi: obj.id, code: obj.last_payment_error?.code ?? null });
      return { action: 'recorded' };
    case 'charge.refunded':
      // Refunds are never initiated here; record one made manually in Stripe.
      await db.prepare("UPDATE payments SET status = 'refunded_externally', updated_at = ? WHERE stripe_payment_intent_id = ?")
        .bind(iso(now), obj.payment_intent ?? '').run();
      await audit(db, now, 'stripe', 'refund_observed', obj.metadata?.booking_id ?? null, { pi: obj.payment_intent });
      return { action: 'recorded' };
    default:
      return { action: 'ignored' };
  }
}

// ---- Owner cancellation: never instant once dates have been published ----

export async function cancelBooking(env, db, now, id, body, fetcher = fetch) {
  const b = await getBooking(db, id);
  if (!b) throw new HttpError(404, 'not found');
  if (['cancelled', 'expired', 'cancellation_pending'].includes(b.status)) throw new HttpError(409, `booking is already ${b.status}`);
  const notes = [];
  if (b.status === 'authorized') {
    // Releasing an uncaptured authorisation is not a refund; it still needs the payments gate.
    const pay = await db.prepare("SELECT * FROM payments WHERE booking_id = ? AND status = 'authorized' LIMIT 1").bind(id).first();
    if (pay?.stripe_payment_intent_id) {
      try {
        assertPaymentsAllowed(env);
        await stripePost(env, `payment_intents/${encodeURIComponent(pay.stripe_payment_intent_id)}/cancel`, {}, `cancel-auth-${id}`, fetcher);
        await db.prepare("UPDATE payments SET status = 'canceled', updated_at = ? WHERE id = ?").bind(iso(now), pay.id).run();
        notes.push('card authorisation released (no charge was made)');
      } catch (err) {
        notes.push(`authorisation NOT released automatically (${err.message}); release it in the Stripe dashboard`);
      }
    }
  }
  if (b.status === 'confirmed') notes.push('no refund issued by the system; refunds are a manual owner decision in Stripe');
  const r = await releaseOrQueue(env, db, now, b, 'cancelled', 'owner_cancelled');
  await audit(db, now, 'admin', 'cancel_requested', id, { reason: body?.reason ?? null, result: r.action, notes });
  return { ...r, notes, booking: await getBooking(db, id) };
}

// ---- Import / reconciliation of existing bookings and payments ----
// Never calls Stripe or Google. Never sends email. Dry-run unless apply === true.

export async function importBooking(env, db, now, body) {
  const {
    booking: input, payment, historical_emails: historical = [], external_emails: handledElsewhere = [],
    prior_correspondence: prior = [], apply = false, agent_ref: agentRef = null,
  } = body || {};
  validateBookingInput(input);
  for (const e of handledElsewhere) {
    if (!e?.template || !e?.note) throw new HttpError(400, 'external_emails entries need template and note');
    if (e.scheduled_for && !isDate(e.scheduled_for)) throw new HttpError(400, 'external_emails.scheduled_for must be YYYY-MM-DD');
  }
  const plan = { apply, actions: [], warnings: [] };

  if (payment) {
    if (!/^pi_[A-Za-z0-9]+$/.test(payment.payment_intent_id || '')) throw new HttpError(400, 'payment.payment_intent_id required (pi_...)');
    if (payment.amount_pence !== input.amount_pence) throw new HttpError(409, 'payment amount does not match agreed booking amount');
    const known = await db.prepare('SELECT booking_id FROM payments WHERE stripe_payment_intent_id = ?').bind(payment.payment_intent_id).first();
    if (known) return { ...plan, result: 'already_imported', booking_id: known.booking_id };
  }
  const dup = await db.prepare(
    `SELECT id FROM bookings WHERE arrival = ? AND departure = ? AND lower(guest_email) = lower(?)
     AND status IN ('hold','pending_payment','authorized','confirmed','cancellation_pending')`,
  ).bind(input.arrival, input.departure, input.guest_email).first();
  if (dup) return { ...plan, result: 'already_imported', booking_id: dup.id };

  const { direct, external } = await conflictsFor(db, input.arrival, input.departure);
  if (direct.length) throw new HttpError(409, 'conflicts with an existing booking', { conflicts: direct });
  // An agent block with EXACTLY these dates is this same booking as Travel Chapter records it: link it.
  const exact = external.filter((e) => e.kind === 'agent' && e.start === input.arrival && e.end === input.departure);
  const other = external.filter((e) => !exact.includes(e));
  if (other.length) throw new HttpError(409, 'overlaps an external block that is not this booking', { conflicts: other });

  const id = newBookingId(input.arrival);
  const nights = nightsBetween(input.arrival, input.departure).length;
  plan.booking_id = id;
  plan.actions.push(`create confirmed booking ${id} ${input.arrival}..${input.departure} (${nights} nights), source=import${agentRef ? `, agent ref ${agentRef}` : ''}`);
  plan.actions.push(`lock ${nights} nights`);
  if (exact.length) plan.actions.push(`link ${exact.length} matching Travel Chapter block(s) to this booking (propagation already confirmed)`);
  else plan.warnings.push('no matching Travel Chapter block found: check the agent calendar shows these dates');
  plan.actions.push('NOT published to Google automatically (the agent already holds this booking; publishing could duplicate it there)');
  if (payment) plan.actions.push(`record existing payment ${payment.payment_intent_id} (${fmtGBP(payment.amount_pence)}) as succeeded/reconciled; no Stripe call`);
  for (const t of historical) plan.actions.push(`mark '${t}' email as historical (already handled; will not be sent)`);
  for (const e of handledElsewhere) plan.actions.push(`mark '${e.template}' as handled outside this system${e.scheduled_for ? ` (scheduled for ${e.scheduled_for})` : ''}: this system will never send it`);
  for (const c of prior) plan.actions.push(`record prior correspondence in audit: ${c}`);
  if (!handledElsewhere.some((e) => e.template === 'welcome')) {
    plan.actions.push('welcome email remains scheduled for arrival minus 2 days (subject to AUTOMATION_ENABLED and approved template)');
  }
  if (!historical.includes('confirmation') && !handledElsewhere.some((e) => e.template === 'confirmation')) {
    plan.warnings.push('no post-payment confirmation recorded; this system will NOT send one for an imported booking (owner decision)');
  }
  if (!payment) plan.warnings.push('no payment supplied: booking imported as confirmed without a payment record');

  if (!apply) return { ...plan, result: 'dry_run' };

  const stmts = [
    db.prepare(
      `INSERT INTO bookings (id, guest_name, guest_surname, guest_email, payer_name, party_size, arrival, departure, nights,
         amount_pence, currency, status, source, notes, agent_ref, propagation, agent_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gbp', 'confirmed', 'import', ?, ?, ?, ?, ?, ?)`,
    ).bind(id, input.guest_name, input.guest_surname, input.guest_email, input.payer_name ?? null, input.party_size,
      input.arrival, input.departure, nights, input.amount_pence, input.notes ?? null, agentRef,
      exact.length ? 'agent_confirmed' : 'none', exact.length ? iso(now) : null, iso(now), iso(now)),
    // Link first, so the trigger lets this booking lock nights under its own agent echo.
    db.prepare(
      `UPDATE ical_events SET linked_booking_id = ?, agent_ref = COALESCE(?, agent_ref)
       WHERE start_date = ? AND end_date = ? AND state IN ('present','missing','ghost')
         AND source_id IN (SELECT id FROM calendar_sources WHERE kind = 'agent')`,
    ).bind(id, agentRef, input.arrival, input.departure),
    ...lockStatements(db, id, input.arrival, input.departure, now),
  ];
  if (payment) {
    stmts.push(db.prepare(
      `INSERT INTO payments (id, booking_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_pence, currency,
         status, livemode, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'gbp', 'succeeded', ?, 'reconciled', ?, ?)`,
    ).bind(uuid(), id, payment.checkout_session_id ?? null, payment.payment_intent_id, payment.amount_pence,
      payment.livemode ? 1 : 0, iso(now), iso(now)));
  }
  for (const t of historical) {
    const recipient = t === 'management_new_booking' ? (env.MANAGEMENT_EMAIL || 'management') : input.guest_email;
    stmts.push(db.prepare(
      `INSERT INTO email_log (id, booking_id, template, recipient, dedupe_key, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'historical', 0, ?)`,
    ).bind(uuid(), id, t, recipient, `${t}:${id}`, iso(now)));
  }
  for (const e of handledElsewhere) {
    stmts.push(db.prepare(
      `INSERT INTO email_log (id, booking_id, template, recipient, dedupe_key, status, attempts, note, created_at)
       VALUES (?, ?, ?, ?, ?, 'suppressed', 0, ?, ?)`,
    ).bind(uuid(), id, e.template, input.guest_email, `${e.template}:${id}`,
      `${e.note}${e.scheduled_for ? ` [scheduled_for=${e.scheduled_for}]` : ''}`, iso(now)));
  }
  stmts.push(db.prepare('INSERT INTO audit_log (at, actor, action, booking_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(iso(now), 'admin', 'imported', id, JSON.stringify({
      payment: payment?.payment_intent_id ?? null, historical, external_emails: handledElsewhere, prior_correspondence: prior, agent_ref: agentRef,
    })));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (isLockFailure(err)) throw new HttpError(409, 'dates became unavailable during import', { conflicts: await conflictsFor(db, input.arrival, input.departure) });
    throw err;
  }
  return { ...plan, result: 'imported', booking: await getBooking(db, id) };
}
