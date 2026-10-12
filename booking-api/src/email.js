// Transactional email via Resend, with at-most-once delivery per dedupe key.

import { automationEnabled, iso, uuid } from './util.js';

const MAX_ATTEMPTS = 5;
const RESEND_URL = 'https://api.resend.com/emails';

export function allowlist(env) {
  return String(env.EMAIL_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// A recipient may receive mail only when automation is on, or it is an allow-listed test address.
export function mayEmail(env, recipient) {
  return automationEnabled(env) || allowlist(env).includes(String(recipient).toLowerCase());
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function render(str, vars, html) {
  return str.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`template variable missing: ${k}`);
    return html ? escapeHtml(vars[k]) : String(vars[k]);
  });
}

/**
 * Queue-and-send. Returns { status } where status is one of:
 * blocked (gate closed, nothing recorded), duplicate (already handled), sent, failed.
 */
export async function sendEmail(env, db, now, { bookingId, template, recipient, dedupeKey, vars }, fetcher = fetch) {
  if (!mayEmail(env, recipient)) return { status: 'blocked', reason: 'automation disabled and recipient not allow-listed' };

  await db.prepare(
    `INSERT OR IGNORE INTO email_log (id, booking_id, template, recipient, dedupe_key, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).bind(uuid(), bookingId ?? null, template, recipient, dedupeKey, iso(now)).run();

  return attempt(env, db, now, dedupeKey, vars, fetcher);
}

async function attempt(env, db, now, dedupeKey, vars, fetcher) {
  // Atomic claim: only one worker may move pending/failed -> sending.
  const staleClaim = iso(new Date(now.getTime() - 30 * 60_000));
  const claim = await db.prepare(
    `UPDATE email_log SET status = 'sending', attempts = attempts + 1, claimed_at = ?
     WHERE dedupe_key = ? AND attempts < ? AND (status IN ('pending','failed') OR (status = 'sending' AND claimed_at < ?))`,
  ).bind(iso(now), dedupeKey, MAX_ATTEMPTS, staleClaim).run();
  if (!claim.meta.changes) return { status: 'duplicate' };

  const row = await db.prepare('SELECT * FROM email_log WHERE dedupe_key = ?').bind(dedupeKey).first();
  const fail = async (msg) => {
    await db.prepare("UPDATE email_log SET status = 'failed', last_error = ? WHERE dedupe_key = ?").bind(msg.slice(0, 500), dedupeKey).run();
    return { status: 'failed', error: msg };
  };

  if (!mayEmail(env, row.recipient)) return fail('gate closed at send time');
  const tpl = await db.prepare('SELECT * FROM email_templates WHERE name = ?').bind(row.template).first();
  if (!tpl || !tpl.approved) return fail(`template '${row.template}' missing or not approved`);
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return fail('RESEND_API_KEY / FROM_EMAIL not configured');

  let subject, html, text;
  try {
    subject = render(tpl.subject, vars, false);
    html = render(tpl.html, vars, true);
    text = render(tpl.text, vars, false);
  } catch (err) {
    return fail(err.message);
  }

  try {
    const res = await fetcher(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
        'idempotency-key': dedupeKey, // provider-side dedupe as a second guard
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [row.recipient],
        reply_to: env.REPLY_TO_EMAIL || undefined,
        subject, html, text,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return fail(`Resend HTTP ${res.status}: ${body.message || ''}`);
    await db.prepare("UPDATE email_log SET status = 'sent', provider_id = ?, sent_at = ?, last_error = NULL WHERE dedupe_key = ?")
      .bind(body.id || null, iso(now), dedupeKey).run();
    return { status: 'sent', id: body.id };
  } catch (err) {
    return fail(`network: ${err.message || err}`);
  }
}

// Retry failed sends; variables are rebuilt from the booking so retries render identically.
export async function retryFailed(env, db, now, buildVars, fetcher = fetch) {
  const { results } = await db.prepare(
    `SELECT dedupe_key, booking_id, template, recipient FROM email_log
     WHERE status IN ('failed','pending','sending') AND attempts < ? ORDER BY created_at LIMIT 50`,
  ).bind(MAX_ATTEMPTS).all();
  const out = [];
  for (const r of results) {
    if (!mayEmail(env, r.recipient)) { out.push({ key: r.dedupe_key, status: 'blocked' }); continue; }
    const vars = await buildVars(r);
    out.push({ key: r.dedupe_key, ...(await attempt(env, db, now, r.dedupe_key, vars, fetcher)) });
  }
  return out;
}
