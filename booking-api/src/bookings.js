// Booking lifecycle: holds, Stripe Checkout, webhook-driven confirmation, import/reconciliation.

import { calendarStatus } from './calendar.js';
import { sendEmail } from './email.js';
import {
  HttpError, audit, automationEnabled, iso, isDate, newBookingId, nightsBetween, timingSafeEqual, uuid,
} from './util.js';

// Allowed state transitions. Anything else is refused.
export const TRANSITIONS = {
  hold: ['pending_payment', 'cancelled', 'expired', 'confirmed'],
  pending_payment: ['confirmed', 'cancelled', 'expired', 'hold'],
  expired: ['confirmed'], // only via a verified late payment when nights are still free
  confirmed: ['cancelled'],
  cancelled: [],
};

const ACTIVE = ['hold', 'pending_payment', 'confirmed'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getBooking(db, id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
}

async function transition(db, now, id, to, extraSql = '', extraBinds = []) {
  const from = Object.keys(TRANSITIONS).filter((s) => TRANSITIONS[s].includes(to));
  const res = await db.prepare(
    `UPDATE bookings SET status = ?, updated_at = ?${extraSql} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
  ).bind(to, iso(now), ...extraBinds, id, ...from).run();
  return res.meta.changes === 1;
}

async function releaseNights(db, id) {
  await db.prepare('DELETE FROM night_locks WHERE owner = ?').bind(`booking:${id}`).run();
}

function lockStatements(db, id, arrival, departure, now) {
  return nightsBetween(arrival, departure).map((n) =>
    db.prepare('INSERT INTO night_locks (night, owner, created_at) VALUES (?, ?, ?)').bind(n, `booking:${id}`, iso(now)));
}

async function conflictingNights(db, arrival, departure) {
  const nights = nightsBetween(arrival, departure);
  const { results } = await db.prepare(
    `SELECT night, owner FROM night_locks WHERE night IN (${nights.map(() => '?').join(',')}) ORDER BY night`,
  ).bind(...nights).all();
  return results;
}

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

// ---- Holds (created by the owner after agreeing dates/price with the guest) ----

export async function createHold(env, db, now, input) {
  validateBookingInput(input);
  const cal = await calendarStatus(env, db, now);
  if (!cal.reliable) throw new HttpError(409, 'availability unknown: calendar source not reliable', { problems: cal.problems });

  const id = newBookingId(input.arrival);
  const payToken = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  const holdHours = Number(env.HOLD_HOURS || 48);
  const expires = new Date(now.getTime() + holdHours * 3600_000);
  const nights = nightsBetween(input.arrival, input.departure).length;

  try {
    // D1 batch = one transaction: booking row + all night locks, or nothing.
    await db.batch([
      db.prepare(
        `INSERT INTO bookings (id, guest_name, guest_surname, guest_email, payer_name, party_size, arrival, departure, nights,
           amount_pence, currency, status, hold_expires_at, pay_token, source, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gbp', 'hold', ?, ?, 'direct', ?, ?, ?)`,
      ).bind(id, input.guest_name, input.guest_surname, input.guest_email, input.payer_name ?? null, input.party_size,
        input.arrival, input.departure, nights, input.amount_pence, iso(expires), payToken, input.notes ?? null, iso(now), iso(now)),
      ...lockStatements(db, id, input.arrival, input.departure, now),
    ]);
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err.message))) {
      throw new HttpError(409, 'dates unavailable', { conflicts: await conflictingNights(db, input.arrival, input.departure) });
    }
    throw err;
  }
  await audit(db, now, 'admin', 'hold_created', id, { arrival: input.arrival, departure: input.departure });
  return { ...(await getBooking(db, id)), pay_url: payUrl(env, id, payToken) };
}

export function payUrl(env, id, token) {
  return `${(env.API_BASE_URL || '').replace(/\/$/, '')}/pay/${encodeURIComponent(id)}?t=${token}`;
}

export async function cancelBooking(db, now, id, reason) {
  const ok = await transition(db, now, id, 'cancelled');
  if (!ok) throw new HttpError(409, 'booking cannot be cancelled from its current state');
  await releaseNights(db, id);
  // No refund is issued by this system; refunds are a manual owner decision in Stripe.
  await audit(db, now, 'admin', 'cancelled', id, { reason: reason ?? null, refund: 'not issued by system' });
  return getBooking(db, id);
}

export async function expireHolds(db, now) {
  const graceMs = 15 * 60_000; // allow webhook lag past Checkout expiry
  const cutoff = iso(new Date(now.getTime() - graceMs));
  const { results } = await db.prepare(
    "SELECT id FROM bookings WHERE status IN ('hold','pending_payment') AND hold_expires_at < ?",
  ).bind(cutoff).all();
  const expired = [];
  for (const { id } of results) {
    if (await transition(db, now, id, 'expired')) {
      await releaseNights(db, id);
      await audit(db, now, 'system', 'hold_expired', id);
      expired.push(id);
    }
  }
  return expired;
}

// ---- Stripe Checkout ----

export function stripeKeyIsLive(env) {
  return /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
}

function assertPaymentsAllowed(env) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'payments not configured');
  if (stripeKeyIsLive(env) && !(automationEnabled(env) && env.STRIPE_MODE === 'live')) {
    throw new HttpError(403, 'live payments are disabled (AUTOMATION_ENABLED/STRIPE_MODE)');
  }
  if (!stripeKeyIsLive(env) && env.STRIPE_MODE === 'live') throw new HttpError(500, 'STRIPE_MODE=live but key is not live');
  if (env.PAYMENT_POLICY !== 'full_upfront') {
    // Deposit/balance schemes are not approved by the owner; nothing else is implemented.
    throw new HttpError(409, 'PAYMENT_POLICY not approved/configured (only full_upfront is supported)');
  }
}

const fmtGBP = (p) => `£${(p / 100).toFixed(2)}`;

export async function checkoutForPayLink(env, db, now, id, token, fetcher = fetch) {
  const b = await getBooking(db, id);
  if (!b || !b.pay_token || !token || !timingSafeEqual(token, b.pay_token)) throw new HttpError(404, 'not found');
  if (b.status === 'confirmed') return { already_paid: true, booking: b };
  if (!['hold', 'pending_payment'].includes(b.status)) throw new HttpError(410, 'this booking hold is no longer active');
  assertPaymentsAllowed(env);

  // Re-use an open session rather than creating a second one.
  const open = await db.prepare(
    "SELECT * FROM payments WHERE booking_id = ? AND status = 'pending' AND checkout_expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(id, iso(new Date(now.getTime() + 5 * 60_000))).first();
  if (open?.checkout_url) return { url: open.checkout_url, reused: true };

  const holdEnd = new Date(b.hold_expires_at);
  const maxEnd = new Date(now.getTime() + 23.5 * 3600_000);
  const expiresAt = holdEnd < maxEnd ? holdEnd : maxEnd;
  if (expiresAt - now < 31 * 60_000) throw new HttpError(410, 'hold expires too soon to take payment; ask the owner to renew it');

  const site = (env.SITE_URL || 'https://www.littleslatehouse.co.uk').replace(/\/$/, '');
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': b.currency,
    'line_items[0][price_data][unit_amount]': String(b.amount_pence),
    'line_items[0][price_data][product_data][name]': `Little Slate House: ${b.arrival} to ${b.departure} (${b.nights} nights)`,
    customer_email: b.guest_email,
    client_reference_id: b.id,
    'metadata[booking_id]': b.id,
    'payment_intent_data[metadata][booking_id]': b.id,
    'payment_intent_data[description]': `Little Slate House booking ${b.id}`,
    expires_at: String(Math.floor(expiresAt.getTime() / 1000)),
    success_url: `${site}/availability/?booking=${encodeURIComponent(b.id)}&paid=1`,
    cancel_url: `${site}/availability/?booking=${encodeURIComponent(b.id)}&cancelled=1`,
  });
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM payments WHERE booking_id = ?').bind(id).first();
  const res = await fetcher('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `checkout-${id}-${count}`,
    },
    body: form,
  });
  const session = await res.json();
  if (!res.ok) throw new HttpError(502, `Stripe error: ${session?.error?.message || res.status}`);

  await db.batch([
    db.prepare(
      `INSERT INTO payments (id, booking_id, stripe_checkout_session_id, amount_pence, currency, status, livemode,
         checkout_url, checkout_expires_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'checkout', ?, ?)`,
    ).bind(uuid(), id, session.id, b.amount_pence, b.currency, session.livemode ? 1 : 0, session.url, iso(expiresAt), iso(now), iso(now)),
    db.prepare("UPDATE bookings SET status = 'pending_payment', updated_at = ? WHERE id = ? AND status IN ('hold','pending_payment')")
      .bind(iso(now), id),
  ]);
  await audit(db, now, 'guest', 'checkout_started', id, { session: session.id });
  return { url: session.url };
}

// ---- Webhook-driven state changes ----

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
  };
  // The entry code exists only as a Worker secret and only for the welcome email.
  if (template === 'welcome' && env.ENTRY_CODE) vars.entry_code = env.ENTRY_CODE;
  return vars;
}

export async function sendBookingConfirmedEmails(env, db, now, b, fetcher) {
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

async function markPaid(env, db, now, session, fetcher) {
  const id = session.metadata?.booking_id || session.client_reference_id;
  const b = id && (await getBooking(db, id));
  if (!b) return { action: 'ignored', reason: 'no matching booking' };

  const existing = await db.prepare('SELECT * FROM payments WHERE stripe_checkout_session_id = ?').bind(session.id).first();
  if (session.payment_intent) {
    const byPi = await db.prepare('SELECT * FROM payments WHERE stripe_payment_intent_id = ?').bind(session.payment_intent).first();
    if (byPi && byPi.source === 'reconciled') return { action: 'noop', reason: 'payment intent already reconciled' };
  }
  if (existing?.status === 'succeeded' && b.status === 'confirmed') return { action: 'noop', reason: 'payment already recorded' };
  if (session.amount_total !== b.amount_pence || session.currency !== b.currency) {
    await audit(db, now, 'stripe', 'amount_mismatch', b.id, { session: session.id, paid: session.amount_total, expected: b.amount_pence });
    return { action: 'flagged', reason: 'amount mismatch; not confirmed, needs owner review' };
  }

  if (existing?.status === 'succeeded') {
    // Recorded on an earlier, interrupted attempt; carry on to confirmation.
  } else if (existing) {
    await db.prepare(
      "UPDATE payments SET status = 'succeeded', stripe_payment_intent_id = ?, updated_at = ? WHERE id = ?",
    ).bind(session.payment_intent ?? null, iso(now), existing.id).run();
  } else {
    await db.prepare(
      `INSERT INTO payments (id, booking_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_pence, currency,
         status, livemode, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, 'checkout', ?, ?)`,
    ).bind(uuid(), b.id, session.id, session.payment_intent ?? null, session.amount_total, session.currency,
      session.livemode ? 1 : 0, iso(now), iso(now)).run();
  }

  if (b.status === 'confirmed') return { action: 'noop', reason: 'already confirmed' };
  if (b.status === 'cancelled') {
    await audit(db, now, 'stripe', 'paid_after_cancel', b.id, { session: session.id });
    return { action: 'flagged', reason: 'payment for cancelled booking; owner must decide (no automatic refund)' };
  }
  if (b.status === 'expired') {
    // Late payment: re-take the nights only if they are still free.
    try {
      await db.batch(lockStatements(db, b.id, b.arrival, b.departure, now));
    } catch {
      await audit(db, now, 'stripe', 'paid_after_expiry_conflict', b.id, { session: session.id });
      return { action: 'flagged', reason: 'late payment but dates taken; owner must resolve (no automatic refund)' };
    }
  }
  if (!(await transition(db, now, b.id, 'confirmed', ', hold_expires_at = NULL'))) {
    // State changed underneath us (e.g. cancelled concurrently): never email on an unconfirmed booking.
    await audit(db, now, 'stripe', 'confirm_transition_refused', b.id, { session: session.id });
    throw new Error(`booking ${b.id} could not be confirmed from its current state`);
  }
  await audit(db, now, 'stripe', 'confirmed', b.id, { session: session.id });
  const confirmed = await getBooking(db, b.id);
  const emails = await sendBookingConfirmedEmails(env, db, now, confirmed, fetcher);
  return { action: 'confirmed', booking: b.id, emails };
}

async function sessionEnded(db, now, session, why) {
  const id = session.metadata?.booking_id || session.client_reference_id;
  if (!id) return { action: 'ignored' };
  await db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE stripe_checkout_session_id = ? AND status = 'pending'")
    .bind(iso(now), session.id).run();
  // Release only if no other open session remains for the booking.
  const other = await db.prepare(
    "SELECT 1 FROM payments WHERE booking_id = ? AND status = 'pending' AND stripe_checkout_session_id != ? LIMIT 1",
  ).bind(id, session.id).first();
  if (other) return { action: 'noop', reason: 'another checkout session is open' };
  const b = await getBooking(db, id);
  if (b && b.hold_expires_at && new Date(b.hold_expires_at) > now && (await transition(db, now, id, 'hold'))) {
    // The owner's hold still has time left: keep the dates so the guest can use the pay link again.
    await audit(db, now, 'stripe', `returned_to_hold_${why}`, id, { session: session.id });
    return { action: 'returned_to_hold', booking: id };
  }
  if (await transition(db, now, id, 'expired')) {
    await releaseNights(db, id);
    await audit(db, now, 'stripe', `released_${why}`, id, { session: session.id });
    return { action: 'released', booking: id };
  }
  return { action: 'noop' };
}

export async function handleStripeEvent(env, db, now, event, fetcher) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.payment_status === 'paid') return markPaid(env, db, now, obj, fetcher);
      return { action: 'waiting', reason: `payment_status=${obj.payment_status}` };
    case 'checkout.session.async_payment_succeeded':
      return markPaid(env, db, now, obj, fetcher);
    case 'checkout.session.async_payment_failed':
      return sessionEnded(db, now, obj, 'payment_failed');
    case 'checkout.session.expired':
      return sessionEnded(db, now, obj, 'session_expired');
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

// ---- Import / reconciliation of existing bookings and payments ----
// Never calls Stripe. Never sends email. Dry-run unless apply === true.

export async function importBooking(env, db, now, body) {
  const { booking: input, payment, historical_emails: historical = [], apply = false, take_over_ical_nights = false } = body || {};
  validateBookingInput(input);
  const plan = { apply, actions: [], warnings: [] };

  if (payment) {
    if (!/^pi_[A-Za-z0-9]+$/.test(payment.payment_intent_id || '')) throw new HttpError(400, 'payment.payment_intent_id required (pi_...)');
    if (payment.amount_pence !== input.amount_pence) throw new HttpError(409, 'payment amount does not match agreed booking amount');
    const known = await db.prepare('SELECT booking_id FROM payments WHERE stripe_payment_intent_id = ?').bind(payment.payment_intent_id).first();
    if (known) return { ...plan, result: 'already_imported', booking_id: known.booking_id };
  }
  const dup = await db.prepare(
    "SELECT id FROM bookings WHERE arrival = ? AND departure = ? AND lower(guest_email) = lower(?) AND status IN ('hold','pending_payment','confirmed')",
  ).bind(input.arrival, input.departure, input.guest_email).first();
  if (dup) return { ...plan, result: 'already_imported', booking_id: dup.id };

  const conflicts = await conflictingNights(db, input.arrival, input.departure);
  const bookingConflicts = conflicts.filter((c) => c.owner.startsWith('booking:'));
  const icalConflicts = conflicts.filter((c) => c.owner.startsWith('ical:'));
  if (bookingConflicts.length) throw new HttpError(409, 'conflicts with an existing booking', { conflicts: bookingConflicts });
  if (icalConflicts.length && !take_over_ical_nights) {
    throw new HttpError(409, 'nights are blocked by an external calendar; confirm they are this same booking and pass take_over_ical_nights', { conflicts: icalConflicts });
  }

  const id = newBookingId(input.arrival);
  const nights = nightsBetween(input.arrival, input.departure).length;
  plan.booking_id = id;
  plan.actions.push(`create confirmed booking ${id} ${input.arrival}..${input.departure} (${nights} nights), source=import`);
  plan.actions.push(`lock ${nights} nights${icalConflicts.length ? ` (taking over ${icalConflicts.length} external-calendar nights)` : ''}`);
  if (payment) plan.actions.push(`record existing payment ${payment.payment_intent_id} (${fmtGBP(payment.amount_pence)}) as succeeded/reconciled; no Stripe call`);
  for (const t of historical) plan.actions.push(`mark '${t}' email as historical (already handled; will not be sent)`);
  plan.actions.push('welcome email remains scheduled for arrival minus 2 days (subject to AUTOMATION_ENABLED and approved template)');
  if (!payment) plan.warnings.push('no payment supplied: booking imported as confirmed without a payment record');

  if (!apply) return { ...plan, result: 'dry_run' };

  const stmts = [
    ...icalConflicts.map((c) => db.prepare('DELETE FROM night_locks WHERE night = ? AND owner = ?').bind(c.night, c.owner)),
    db.prepare(
      `INSERT INTO bookings (id, guest_name, guest_surname, guest_email, payer_name, party_size, arrival, departure, nights,
         amount_pence, currency, status, source, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gbp', 'confirmed', 'import', ?, ?, ?)`,
    ).bind(id, input.guest_name, input.guest_surname, input.guest_email, input.payer_name ?? null, input.party_size,
      input.arrival, input.departure, nights, input.amount_pence, input.notes ?? null, iso(now), iso(now)),
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
  stmts.push(db.prepare('INSERT INTO audit_log (at, actor, action, booking_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(iso(now), 'admin', 'imported', id, JSON.stringify({ payment: payment?.payment_intent_id ?? null, historical })));
  await db.batch(stmts);
  return { ...plan, result: 'imported', booking: await getBooking(db, id) };
}

export { ACTIVE };
