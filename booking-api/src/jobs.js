// Scheduled work. Hourly: expire holds, sync calendars, retry email. Daily: + welcome emails, maintenance.

import { bookingVars, expireHolds, getBooking } from './bookings.js';
import { calendarStatus, syncAll } from './calendar.js';
import { retryFailed, sendEmail } from './email.js';
import { addDays, automationEnabled, iso, londonDate } from './util.js';

async function varsForLogRow(env, db, row) {
  if (row.template === 'maintenance_alert') {
    const a = await db.prepare("SELECT detail FROM audit_log WHERE action = 'maintenance_issues' ORDER BY id DESC LIMIT 1").first();
    return JSON.parse(a?.detail || '{"date":"","issue_count":"0","issues":""}');
  }
  const b = row.booking_id && (await getBooking(db, row.booking_id));
  return b ? bookingVars(env, b, row.template) : {};
}

export async function hourly(env, db, now, fetcher = fetch) {
  return {
    expired_holds: await expireHolds(db, now),
    calendars: await syncAll(env, db, now, fetcher),
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

export async function maintenanceChecks(env, db, now) {
  const issues = [];
  const today = londonDate(now);

  const cal = await calendarStatus(env, db, now);
  for (const p of cal.problems) issues.push(`Calendar: ${p}`);

  const conf = await db.prepare(
    "SELECT detail FROM audit_log WHERE action = 'calendar_conflict' AND at >= ? ORDER BY id DESC LIMIT 20",
  ).bind(iso(new Date(now.getTime() - 26 * 3600_000))).all();
  for (const r of conf.results) issues.push(`Calendar conflict (external booking overlaps ours): ${r.detail}`);

  const tpl = await db.prepare("SELECT name FROM email_templates WHERE approved = 1").all();
  const approved = new Set(tpl.results.map((t) => t.name));
  for (const n of ['confirmation', 'management_new_booking', 'welcome']) {
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
  const issues = await maintenanceChecks(env, db, now);
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
