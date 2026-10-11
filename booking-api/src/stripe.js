// Stripe webhook signature verification and idempotent event processing.

import { handleStripeEvent } from './bookings.js';
import { HttpError, iso, testHooksAllowed } from './util.js';

const TOLERANCE_SECONDS = 300;

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Same scheme as Stripe's SDK: v1 = HMAC-SHA256(secret, `${t}.${rawBody}`).
export async function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new HttpError(503, 'webhook secret not configured');
  if (!header) throw new HttpError(400, 'missing Stripe-Signature');
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !v1s.length) throw new HttpError(400, 'malformed Stripe-Signature');
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) throw new HttpError(400, 'signature timestamp outside tolerance');
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  let match = false;
  for (const v of v1s) {
    if (v.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < v.length; i++) diff |= v.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff === 0) match = true;
  }
  if (!match) throw new HttpError(400, 'invalid signature');
}

export async function handleStripeWebhook(request, env, db, now, fetcher) {
  const raw = await request.text();
  await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  const event = JSON.parse(raw);

  const expectLive = env.STRIPE_MODE === 'live';
  if (Boolean(event.livemode) !== expectLive) {
    return { status: 200, body: { received: true, ignored: `livemode=${event.livemode} does not match STRIPE_MODE=${env.STRIPE_MODE}` } };
  }

  // Claim the event exactly once. Replays of processed events are acknowledged without re-processing.
  const ins = await db.prepare(
    "INSERT OR IGNORE INTO stripe_events (event_id, type, livemode, status, attempts, received_at) VALUES (?, ?, ?, 'processing', 1, ?)",
  ).bind(event.id, event.type, event.livemode ? 1 : 0, iso(now)).run();
  if (!ins.meta.changes) {
    const retry = await db.prepare(
      "UPDATE stripe_events SET status = 'processing', attempts = attempts + 1, error = NULL WHERE event_id = ? AND status = 'failed'",
    ).bind(event.id).run();
    if (!retry.meta.changes) return { status: 200, body: { received: true, duplicate: true } };
  }

  try {
    if (testHooksAllowed(env, 'ALLOW_TEST_FAULTS') && request.headers.get('x-test-fault') === 'throw') throw new Error('injected test fault');
    const result = await handleStripeEvent(env, db, now, event, fetcher);
    await db.prepare('UPDATE stripe_events SET status = ?, processed_at = ? WHERE event_id = ?')
      .bind(result.action === 'ignored' ? 'ignored' : 'processed', iso(now), event.id).run();
    return { status: 200, body: { received: true, result } };
  } catch (err) {
    await db.prepare("UPDATE stripe_events SET status = 'failed', error = ? WHERE event_id = ?")
      .bind(String(err.message || err).slice(0, 500), event.id).run();
    // Non-2xx makes Stripe retry with backoff; the 'failed' row lets the retry re-process.
    return { status: 500, body: { received: false, error: 'processing failed; will retry' } };
  }
}
