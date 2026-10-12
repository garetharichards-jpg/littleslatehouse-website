// Availability from two kinds of iCal source plus D1 direct bookings.
//  - agent:            Travel Chapter TABs feed. Authoritative BLOCKING input for agent reservations.
//  - owner_publisher:  the owner's dedicated Google calendar feed (the one Travel Chapter subscribes to).
// Rules: an empty, failed or stale feed means availability is UNKNOWN; disappearance never releases dates;
// a block that comes back after release is a ghost and stays blocked until the owner resolves it.

import { openChange } from './changes.js';
import { bookingIdFromUid } from './google.js';
import { addDays, flag, iso, isDate, londonDate, nightsBetween } from './util.js';

const BLOCKING = "('present','missing','ghost')";

// ---- feed health ----

export async function calendarStatus(env, db, now) {
  const requireAgent = env.REQUIRE_AGENT_FEED === undefined || flag(env.REQUIRE_AGENT_FEED);
  const maxAgeMs = Number(env.CALENDAR_MAX_STALENESS_HOURS || 3) * 3600_000;
  const { results: sources } = await db.prepare(
    'SELECT id, kind, last_ok_at, last_attempt_at, last_error, last_event_count FROM calendar_sources WHERE enabled = 1',
  ).all();
  const problems = [];
  if (requireAgent && !sources.some((s) => s.kind === 'agent')) problems.push('no Travel Chapter (agent) feed configured');
  for (const s of sources) {
    if (!s.last_ok_at) problems.push(`${s.id}: never synced successfully${s.last_error ? ` (${s.last_error})` : ''}`);
    else if (now - new Date(s.last_ok_at) > maxAgeMs) problems.push(`${s.id}: stale since ${s.last_ok_at}${s.last_error ? ` (${s.last_error})` : ''}`);
  }
  return { reliable: problems.length === 0, problems, sources };
}

export async function blockingEventsOverlapping(db, from, to) {
  const { results } = await db.prepare(
    `SELECT e.*, s.kind FROM ical_events e JOIN calendar_sources s ON s.id = e.source_id
     WHERE e.state IN ${BLOCKING} AND e.start_date < ? AND e.end_date > ? ORDER BY e.start_date`,
  ).bind(to, from).all();
  return results;
}

export async function availability(env, db, now, from, to) {
  if (!isDate(from) || !isDate(to) || to <= from) throw new Error('invalid range');
  const status = await calendarStatus(env, db, now);
  const nights = new Set();
  const { results: locks } = await db.prepare('SELECT night FROM night_locks WHERE night >= ? AND night < ?').bind(from, to).all();
  for (const l of locks) nights.add(l.night);
  for (const e of await blockingEventsOverlapping(db, from, to)) {
    for (const n of nightsBetween(e.start_date < from ? from : e.start_date, e.end_date > to ? to : e.end_date)) nights.add(n);
  }
  return { status: status.reliable ? 'ok' : 'unknown', problems: status.problems, unavailable: [...nights].sort() };
}

// ---- iCal parsing ----

function icalDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(value || '');
  if (!m) return null;
  if (m[4] && m[7]) {
    // UTC instant -> property-local (Europe/London) date.
    return londonDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
  }
  // VALUE=DATE, floating or TZID local time: the date part is already the local date.
  void params;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseIcal(text) {
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('not an iCalendar document');
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const [rawName, ...params] = line.slice(0, idx).split(';');
      const name = rawName.toUpperCase();
      const value = line.slice(idx + 1).trim();
      if (name === 'DTSTART') cur.start = icalDate(value, params);
      else if (name === 'DTEND') cur.end = icalDate(value, params);
      else if (name === 'UID') cur.uid = value;
      else if (name === 'STATUS') cur.status = value.toUpperCase();
      else if (name === 'SUMMARY') cur.summary = value.slice(0, 80); // limited titles only; never guest data
      else if (name === 'LAST-MODIFIED') cur.last_modified = value;
      else if (name === 'SEQUENCE') cur.sequence = Number(value) || 0;
    }
  }
  return events
    .filter((e) => e.start && e.status !== 'CANCELLED')
    .map((e) => {
      const end = e.end && e.end > e.start ? e.end : addDays(e.start, 1);
      return { ...e, end, uid: e.uid || `nouid:${e.start}:${end}` };
    });
}

// ---- sync ----

const sanitize = (msg, url) => (url ? String(msg).split(url).join('<feed-url>') : String(msg)).slice(0, 300);

async function directBookingMatching(db, start, end) {
  return db.prepare(
    `SELECT * FROM bookings WHERE arrival = ? AND departure = ?
     AND status IN ('authorized','confirmed','cancellation_pending','cancelled') ORDER BY created_at DESC LIMIT 1`,
  ).bind(start, end).first();
}

async function overlappingDirect(db, start, end, exceptBooking) {
  const nights = nightsBetween(start, end);
  const { results } = await db.prepare(
    `SELECT DISTINCT owner FROM night_locks WHERE night IN (${nights.map(() => '?').join(',')})`,
  ).bind(...nights).all();
  return results.map((r) => r.owner.slice(8)).filter((id) => id !== exceptBooking);
}

export async function syncSource(env, db, source, now, fetcher = fetch) {
  const at = iso(now);
  const url = env[source.url_secret];
  const report = { id: source.id, kind: source.kind, ok: false, anomalies: [] };
  try {
    if (!url) throw new Error(`feed URL secret ${source.url_secret} is not set`);
    let res;
    try {
      res = await fetcher(url, { headers: { 'user-agent': 'lsh-booking-api' } });
    } catch (e) {
      throw new Error(`network error: ${sanitize(e.message || e, url)}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = parseIcal(await res.text());
    if (events.length === 0 && !source.allow_empty) throw new Error('feed returned zero events; treated as unverified');

    const { results: stored } = await db.prepare('SELECT * FROM ical_events WHERE source_id = ?').bind(source.id).all();
    const byUid = new Map(stored.map((r) => [r.uid, r]));
    const seen = new Set();

    for (const e of events) {
      seen.add(e.uid);
      const prev = byUid.get(e.uid);
      let linked = prev?.linked_booking_id ?? null;
      const ownId = source.kind === 'owner_publisher' ? bookingIdFromUid(e.uid) : null;
      if (ownId) linked = ownId;

      if (!prev) {
        // New event. Is it a reappearance of something already released (ghost)?
        const released = await db.prepare(
          "SELECT uid FROM ical_events WHERE source_id = ? AND state = 'released' AND start_date = ? AND end_date = ? LIMIT 1",
        ).bind(source.id, e.start, e.end).first();
        let state = released ? 'ghost' : 'present';
        let matchCancelled = false;
        if (!linked && source.kind === 'agent') {
          const b = await directBookingMatching(db, e.start, e.end);
          if (b && b.status === 'cancelled') matchCancelled = true;
          else if (b) linked = b.id;
        }
        if (matchCancelled) state = 'ghost';
        await db.prepare(
          `INSERT INTO ical_events (source_id, uid, start_date, end_date, summary, last_modified, sequence, state, linked_booking_id,
             first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(source.id, e.uid, e.start, e.end, e.summary ?? null, e.last_modified ?? null, e.sequence ?? null, state, linked, at, at).run();
        if (state === 'ghost') {
          await openChange(db, now, { kind: 'ghost_block', source_id: source.id, uid: e.uid, start_date: e.start, end_date: e.end,
            detail: { reason: matchCancelled ? 'block matches a cancelled direct booking' : 'released block reappeared' } });
          report.anomalies.push({ type: 'ghost', uid: e.uid, start: e.start, end: e.end });
        }
      } else {
        // Known event: amended dates keep the OLD dates blocked until coordinated.
        if (prev.start_date !== e.start || prev.end_date !== e.end) {
          const prevUid = `${e.uid}#prev:${prev.start_date}:${prev.end_date}`;
          await db.prepare(
            `INSERT OR IGNORE INTO ical_events (source_id, uid, start_date, end_date, summary, state, linked_booking_id, first_seen_at, last_seen_at, missing_since)
             VALUES (?, ?, ?, ?, ?, 'missing', ?, ?, ?, ?)`,
          ).bind(source.id, prevUid, prev.start_date, prev.end_date, prev.summary, prev.linked_booking_id, prev.first_seen_at, at, at).run();
          await openChange(db, now, { kind: 'external_amended', source_id: source.id, uid: prevUid, start_date: prev.start_date, end_date: prev.end_date,
            detail: { new_start: e.start, new_end: e.end } });
          report.anomalies.push({ type: 'amended', uid: e.uid, from: [prev.start_date, prev.end_date], to: [e.start, e.end] });
        }
        let state = prev.state === 'released' ? 'ghost' : prev.state === 'ghost' ? 'ghost' : 'present';
        if (prev.state === 'released') {
          await openChange(db, now, { kind: 'ghost_block', source_id: source.id, uid: e.uid, start_date: e.start, end_date: e.end,
            detail: { reason: 'released block reappeared with the same UID' } });
          report.anomalies.push({ type: 'ghost', uid: e.uid, start: e.start, end: e.end });
        }
        if (prev.state === 'missing') {
          // Came back before anyone resolved it: close the 'missing' item, record the anomaly.
          await db.prepare(
            `UPDATE pending_changes SET status = 'closed', acknowledgment = 'reappeared in feed', updated_at = ?, closed_at = ?
             WHERE kind = 'external_missing' AND source_id = ? AND uid = ? AND status IN ('open','coordinated')`,
          ).bind(at, at, source.id, e.uid).run();
          report.anomalies.push({ type: 'reappeared', uid: e.uid });
        }
        await db.prepare(
          `UPDATE ical_events SET start_date = ?, end_date = ?, summary = ?, last_modified = ?, sequence = ?, state = ?,
             linked_booking_id = ?, last_seen_at = ?, missing_since = NULL WHERE source_id = ? AND uid = ?`,
        ).bind(e.start, e.end, e.summary ?? null, e.last_modified ?? null, e.sequence ?? null, state, linked, at, source.id, e.uid).run();
      }

      // Agent echo of one of our bookings = propagation confirmed.
      if (linked && source.kind === 'agent') {
        await db.prepare(
          `UPDATE bookings SET propagation = 'agent_confirmed', agent_confirmed_at = COALESCE(agent_confirmed_at, ?), updated_at = ?
           WHERE id = ? AND propagation IN ('none','published','overdue','publish_failed')`,
        ).bind(at, at, linked).run();
      }
      // Agent block over a direct booking that it is NOT an echo of = possible double booking.
      if (source.kind === 'agent') {
        const clash = await overlappingDirect(db, e.start, e.end, linked);
        for (const bid of clash) {
          await openChange(db, now, { kind: 'overlap', booking_id: bid, source_id: source.id, uid: e.uid, start_date: e.start, end_date: e.end,
            detail: { warning: 'Travel Chapter block overlaps a direct booking: possible double booking' } });
          report.anomalies.push({ type: 'overlap', booking: bid, uid: e.uid });
        }
      }
    }

    // Events no longer in the feed: keep blocking, ask the owner to verify. Never auto-release.
    for (const r of stored) {
      if (seen.has(r.uid) || r.state !== 'present' || r.uid.includes('#prev:')) continue;
      const expected = r.linked_booking_id && (await db.prepare(
        "SELECT 1 FROM pending_changes WHERE kind = 'cancel_direct' AND booking_id = ? AND status IN ('released','verified','closed') LIMIT 1",
      ).bind(r.linked_booking_id).first());
      if (expected) {
        // Our own coordinated cancellation has now propagated: this is the verification we waited for.
        await db.prepare("UPDATE ical_events SET state = 'released', missing_since = ?, last_seen_at = last_seen_at WHERE source_id = ? AND uid = ?")
          .bind(at, source.id, r.uid).run();
        continue;
      }
      await db.prepare("UPDATE ical_events SET state = 'missing', missing_since = ? WHERE source_id = ? AND uid = ?").bind(at, source.id, r.uid).run();
      await openChange(db, now, { kind: 'external_missing', booking_id: r.linked_booking_id, source_id: source.id, uid: r.uid,
        start_date: r.start_date, end_date: r.end_date, detail: { note: 'Block disappeared from feed. Dates stay blocked until verified with Travel Chapter.' } });
      report.anomalies.push({ type: 'missing', uid: r.uid, start: r.start_date, end: r.end_date });
    }

    await db.prepare('UPDATE calendar_sources SET last_ok_at = ?, last_attempt_at = ?, last_error = NULL, last_event_count = ? WHERE id = ?')
      .bind(at, at, events.length, source.id).run();
    return { ...report, ok: true, events: events.length };
  } catch (err) {
    const msg = sanitize(err.message || err, url);
    await db.prepare('UPDATE calendar_sources SET last_attempt_at = ?, last_error = ? WHERE id = ?').bind(at, msg, source.id).run();
    return { ...report, ok: false, error: msg };
  }
}

export async function syncAll(env, db, now, fetcher, { kind } = {}) {
  const { results } = await db.prepare(
    `SELECT * FROM calendar_sources WHERE enabled = 1 ${kind ? 'AND kind = ?' : ''} ORDER BY kind`,
  ).bind(...(kind ? [kind] : [])).all();
  const out = [];
  for (const s of results) out.push(await syncSource(env, db, s, now, fetcher));
  return out;
}
