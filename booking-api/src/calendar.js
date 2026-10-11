// Availability: night locks in D1 plus external iCal feeds.
// Rule: an empty, failed or stale feed is UNKNOWN availability, never "free".

import { addDays, flag, iso, isDate, nightsBetween } from './util.js';

const OWN_UID_SUFFIX = '@littleslatehouse.co.uk';

export async function calendarStatus(env, db, now) {
  const requireExternal = env.REQUIRE_EXTERNAL_CALENDAR === undefined || flag(env.REQUIRE_EXTERNAL_CALENDAR);
  const maxAgeMs = Number(env.CALENDAR_MAX_STALENESS_HOURS || 3) * 3600_000;
  const { results: sources } = await db.prepare(
    'SELECT id, last_ok_at, last_attempt_at, last_error FROM calendar_sources WHERE enabled = 1',
  ).all();

  const problems = [];
  if (requireExternal && sources.length === 0) problems.push('no external calendar source configured');
  for (const s of sources) {
    if (!s.last_ok_at) problems.push(`${s.id}: never synced successfully${s.last_error ? ` (${s.last_error})` : ''}`);
    else if (now - new Date(s.last_ok_at) > maxAgeMs) problems.push(`${s.id}: stale since ${s.last_ok_at}${s.last_error ? ` (${s.last_error})` : ''}`);
  }
  return { reliable: problems.length === 0, problems, sources };
}

export async function availability(env, db, now, from, to) {
  if (!isDate(from) || !isDate(to) || to <= from) throw new Error('invalid range');
  const status = await calendarStatus(env, db, now);
  const { results } = await db.prepare(
    'SELECT night FROM night_locks WHERE night >= ? AND night < ? ORDER BY night',
  ).bind(from, to).all();
  return {
    status: status.reliable ? 'ok' : 'unknown',
    problems: status.problems,
    unavailable: results.map((r) => r.night),
  };
}

// ---- iCal parsing (RFC 5545 subset: VEVENT DTSTART/DTEND/UID/STATUS) ----

function toDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
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
      const name = line.slice(0, idx).split(';')[0].toUpperCase();
      const value = line.slice(idx + 1).trim();
      if (name === 'DTSTART') cur.start = toDate(value);
      else if (name === 'DTEND') cur.end = toDate(value);
      else if (name === 'UID') cur.uid = value;
      else if (name === 'STATUS') cur.status = value.toUpperCase();
    }
  }
  return events
    .filter((e) => e.start && e.status !== 'CANCELLED' && !(e.uid || '').endsWith(OWN_UID_SUFFIX))
    .map((e) => ({ uid: e.uid, start: e.start, end: e.end && e.end > e.start ? e.end : addDays(e.start, 1) }));
}

export async function syncSource(env, db, source, now, fetcher = fetch) {
  const at = iso(now);
  try {
    const res = await fetcher(source.url, { headers: { 'user-agent': 'lsh-booking-api' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = parseIcal(await res.text());
    if (events.length === 0 && !flag(env.CALENDAR_ALLOW_EMPTY)) {
      throw new Error('feed returned zero events; treated as unverified');
    }
    const owner = `ical:${source.id}`;
    const nights = [...new Set(events.flatMap((e) => nightsBetween(e.start, e.end)))];

    // Nights already held by our own bookings overlapping external events = conflict to report.
    const conflicts = [];
    if (nights.length) {
      const { results } = await db.prepare(
        `SELECT night, owner FROM night_locks WHERE owner LIKE 'booking:%' AND night IN (${nights.map(() => '?').join(',')})`,
      ).bind(...nights).all();
      conflicts.push(...results);
    }

    await db.batch([
      db.prepare('DELETE FROM night_locks WHERE owner = ?').bind(owner),
      ...nights.map((n) => db.prepare('INSERT OR IGNORE INTO night_locks (night, owner, created_at) VALUES (?, ?, ?)').bind(n, owner, at)),
      db.prepare('UPDATE calendar_sources SET last_ok_at = ?, last_attempt_at = ?, last_error = NULL, last_event_count = ? WHERE id = ?')
        .bind(at, at, events.length, source.id),
    ]);
    if (conflicts.length) {
      await db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
        .bind(at, 'system', 'calendar_conflict', JSON.stringify({ source: source.id, nights: conflicts })).run();
    }
    return { id: source.id, ok: true, events: events.length, nights: nights.length, conflicts };
  } catch (err) {
    // Keep previous locks; mark the attempt so availability reports UNKNOWN once stale.
    await db.prepare('UPDATE calendar_sources SET last_attempt_at = ?, last_error = ? WHERE id = ?')
      .bind(at, String(err.message || err).slice(0, 500), source.id).run();
    return { id: source.id, ok: false, error: String(err.message || err) };
  }
}

export async function syncAll(env, db, now, fetcher) {
  const { results } = await db.prepare('SELECT id, url FROM calendar_sources WHERE enabled = 1').all();
  const out = [];
  for (const s of results) out.push(await syncSource(env, db, s, now, fetcher));
  return out;
}

// Export confirmed/pending bookings as iCal (no guest details) for OTAs to import.
export async function exportIcal(db) {
  const { results } = await db.prepare(
    "SELECT id, arrival, departure FROM bookings WHERE status IN ('hold','pending_payment','confirmed') ORDER BY arrival",
  ).all();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const d = (s) => s.replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Little Slate House//Booking API//EN', 'CALSCALE:GREGORIAN'];
  for (const b of results) {
    lines.push('BEGIN:VEVENT', `UID:${b.id}${OWN_UID_SUFFIX}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d(b.arrival)}`, `DTEND;VALUE=DATE:${d(b.departure)}`, 'SUMMARY:Booked', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
