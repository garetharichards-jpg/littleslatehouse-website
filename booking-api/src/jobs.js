// Scheduled work.
// Hourly: expire unpublished holds, pull both feeds, propagation watch, retry email.
// Daily:  + welcome emails, full cross-channel reconciliation, owner alert.

import { bookingVars, expireHolds, getBooking } from './bookings.js';
import { calendarStatus, syncAll } from './calendar.js';
import { openChange, setChangeStatus } from './changes.js';
import { retryFailed, sendEmail } from './email.js';
import { eventExists } from './google.js';
import { addDays, automationEnabled, iso, londonDate } from './util.js';

async function varsForLogRow(env, db, row) {
  if (row.template === 'maintenance_alert') {
    const a = await db.prepare("SELECT detail FROM audit_log WHERE action = 'maintenance_issues' ORDER BY id DESC LIMIT 1").first();
    return JSON.parse(a?.detail || '{"date":"","issue_count":"0","issues":""}');
  }
  const b = row.booking_id && (await getBooking(db, row.booking_id));
  return b ? bookingVars(env, b, row.template) : {};
}

// Travel Chapter can take up to 24h to import our Google feed. Flag only once that window has passed.
export async function propagationWatch(env, db, now) {
  const slaMs = Number(env.PROPAGATION_SLA_HOURS || 26) * 3600_000;
  const { results } = await db.prepare(
    "SELECT * FROM bookings WHERE status IN ('authorized','confirmed') AND propagation = 'published' AND published_at < ?",
  ).bind(iso(new Date(now.getTime() - slaMs))).all();
  for (const b of results) {
    await db.prepare("UPDATE bookings SET propagation = 'overdue', updated_at = ? WHERE id = ?").bind(iso(now), b.id).run();
    await openChange(db, now, { kind: 'propagation_overdue', booking_id: b.id, start_date: b.arrival, end_date: b.departure,
      detail: { published_at: b.published_at, note: 'Travel Chapter feed does not yet show this block. Contact Travel Chapter before confirming.' } });
  }
  return results.map((b) => b.id);
}

// Coordinated cancellations done on our side: verified once the agent feed no longer shows the block.
async function verifyReleasedCancellations(db, now) {
  const { results } = await db.prepare("SELECT * FROM pending_changes WHERE kind = 'cancel_direct' AND status = 'released'").all();
  const stillShown = [];
  for (const c of results) {
    const echo = await db.prepare(
      `SELECT 1 FROM ical_events e JOIN calendar_sources s ON s.id = e.source_id
       WHERE s.kind = 'agent' AND e.linked_booking_id = ? AND e.state IN ('present','ghost') LIMIT 1`,
    ).bind(c.booking_id).first();
    if (!echo) await setChangeStatus(db, now, c.id, 'verified');
    else stillShown.push(c);
  }
  return stillShown;
}

export async function hourly(env, db, now, fetcher = fetch) {
  return {
    expired_holds: await expireHolds(db, now),
    calendars: await syncAll(env, db, now, fetcher),
    propagation_overdue: await propagationWatch(env, db, now),
    email_retries: await retryFailed(env, db, now, (r) => varsForLogRow(env, db, r), fetcher),
  };
}

// Welcome email two days before arrival (Europe/London dates). Catches up to arrival-1 if a run was missed.
export async function sendWelcomeEmails(env, db, now, fetcher = fetch) {
  const today = londonDate(now);
  const { results } = await db.prepare(
    "SELECT * FROM bookings WHERE status = 'confirmed' AND arrival > ? AND arrival <= ? ORDER BY arrival",
  ).bind(today, addDays(today, 2)).all();
  const out = [];
  for (const b of results) {
    const r = await sendEmail(env, db, now, {
      bookingId: b.id, template: 'welcome', recipient: b.guest_email,
      dedupeKey: `welcome:${b.id}`, vars: await bookingVars(env, b, 'welcome'),
    }, fetcher);
    out.push({ booking: b.id, arrival: b.arrival, ...r });
  }
  return out;
}

export async function reconcile(env, db, now, fetcher = fetch) {
  const issues = [];
  const today = londonDate(now);
  const hoursSince = (t) => Math.round((now - new Date(t)) / 3600_000);

  const cal = await calendarStatus(env, db, now);
  for (const p of cal.problems) issues.push(`Calendar: ${p} — availability is UNKNOWN; do not quote`);

  // Open coordinated changes, oldest first.
  const { results: changes } = await db.prepare(
    "SELECT * FROM pending_changes WHERE status IN ('open','coordinated','released') ORDER BY created_at",
  ).all();
  for (const c of changes) {
    const what = `${c.kind} ${c.start_date ?? ''}→${c.end_date ?? ''}${c.booking_id ? ` (${c.booking_id})` : ''}`;
    if (c.kind === 'overlap') issues.push(`CRITICAL possible double booking: ${what}`);
    else if (c.status !== 'released') issues.push(`Pending coordinated change [${c.status}] ${what}, open ${hoursSince(c.created_at)}h`);
  }

  for (const c of await verifyReleasedCancellations(db, now)) {
    if (now - new Date(c.updated_at) > 26 * 3600_000) {
      issues.push(`Travel Chapter still shows cancelled booking ${c.booking_id} (${c.start_date}→${c.end_date}) ${hoursSince(c.updated_at)}h after release`);
    }
  }

  const { results: active } = await db.prepare(
    "SELECT * FROM bookings WHERE status IN ('authorized','confirmed','cancellation_pending') AND departure >= ?",
  ).bind(today).all();
  for (const b of active) {
    if (b.propagation === 'publish_failed') issues.push(`Booking ${b.id} could not be published to the Google calendar: Travel Chapter cannot see it`);
    if (b.propagation === 'published') issues.push(`Booking ${b.id}: waiting for Travel Chapter to import the block (published ${hoursSince(b.published_at)}h ago; can take 24h)`);
    if (b.propagation === 'overdue') issues.push(`Booking ${b.id}: Travel Chapter has NOT shown the block ${hoursSince(b.published_at)}h after publishing`);
    if (['published', 'agent_confirmed', 'overdue'].includes(b.propagation) && b.status !== 'cancellation_pending') {
      const exists = await eventExists(env, b.id, fetcher);
      if (exists === false) issues.push(`Booking ${b.id}: its block is missing from the Google calendar`);
    }
    if (b.status === 'authorized') {
      const age = hoursSince(b.updated_at);
      issues.push(`Booking ${b.id} is authorised, awaiting owner confirmation (${age}h)${age > 5 * 24 ? ' — card authorisation lapses after ~7 days' : ''}`);
    }
  }

  // Duplicate or overlapping blocks inside the agent feed.
  const { results: dupes } = await db.prepare(
    `SELECT a.uid AS a_uid, b.uid AS b_uid, a.start_date, a.end_date FROM ical_events a JOIN ical_events b
       ON a.source_id = b.source_id AND a.uid < b.uid AND a.start_date < b.end_date AND b.start_date < a.end_date
     JOIN calendar_sources s ON s.id = a.source_id
     WHERE s.kind = 'agent' AND a.state IN ('present','ghost') AND b.state IN ('present','ghost') AND a.end_date >= ?`,
  ).bind(today).all();
  for (const d of dupes) issues.push(`Duplicate/overlapping Travel Chapter blocks around ${d.start_date}→${d.end_date}`);

  const tpl = await db.prepare('SELECT name FROM email_templates WHERE approved = 1').all();
  const approved = new Set(tpl.results.map((t) => t.name));
  for (const n of ['confirmation', 'management_new_booking', 'welcome', 'authorization_received']) {
    if (!approved.has(n)) issues.push(`Template '${n}' is missing or not approved`);
  }

  const failedEvents = await db.prepare("SELECT event_id, type, error FROM stripe_events WHERE status = 'failed'").all();
  for (const e of failedEvents.results) issues.push(`Stripe event ${e.event_id} (${e.type}) failed: ${e.error}`);

  const deadEmails = await db.prepare("SELECT dedupe_key, last_error FROM email_log WHERE status = 'failed' AND attempts >= 5").all();
  for (const e of deadEmails.results) issues.push(`Email ${e.dedupe_key} gave up after 5 attempts: ${e.last_error}`);

  const flagged = await db.prepare(
    "SELECT booking_id, action FROM audit_log WHERE action IN ('amount_mismatch','paid_after_cancel','paid_after_expiry_conflict') AND at >= ?",
  ).bind(iso(new Date(now.getTime() - 7 * 86400_000))).all();
  for (const f of flagged.results) issues.push(`Payment needs owner review: ${f.action} on ${f.booking_id}`);

  const noWelcome = await db.prepare(
    `SELECT id, arrival FROM bookings b WHERE status = 'confirmed' AND arrival > ? AND arrival <= ?
     AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.dedupe_key = 'welcome:' || b.id AND e.status IN ('sent','historical'))`,
  ).bind(today, addDays(today, 2)).all();
  for (const b of noWelcome.results) {
    issues.push(`Booking ${b.id} arrives ${b.arrival} and has no welcome email sent${automationEnabled(env) ? '' : ' (automation disabled)'}`);
  }
  return issues;
}

export async function daily(env, db, now, fetcher = fetch) {
  const h = await hourly(env, db, now, fetcher);
  const welcome = await sendWelcomeEmails(env, db, now, fetcher);
  const issues = await reconcile(env, db, now, fetcher);
  let alert = null;
  if (issues.length && env.MAINTENANCE_EMAIL) {
    const date = londonDate(now);
    const vars = { date, issue_count: String(issues.length), issues: issues.map((i) => `- ${i}`).join('\n') };
    await db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .bind(iso(now), 'system', 'maintenance_issues', JSON.stringify(vars)).run();
    alert = await sendEmail(env, db, now, {
      template: 'maintenance_alert', recipient: env.MAINTENANCE_EMAIL, dedupeKey: `maintenance:${date}`, vars,
    }, fetcher);
  }
  return { ...h, welcome, issues, alert };
}
