// "Pending coordinated change" queue. Anything that might release dates waits here until the owner
// has coordinated it with Travel Chapter (simultaneous change on both systems) and recorded the acknowledgment.

import { audit, iso, uuid } from './util.js';

export async function openChange(db, now, c) {
  // One open item per subject: no duplicate alerts for the same thing.
  const existing = await db.prepare(
    `SELECT id FROM pending_changes WHERE kind = ? AND status IN ('open','coordinated','released')
       AND IFNULL(booking_id,'') = IFNULL(?, '') AND IFNULL(source_id,'') = IFNULL(?, '') AND IFNULL(uid,'') = IFNULL(?, '')`,
  ).bind(c.kind, c.booking_id ?? null, c.source_id ?? null, c.uid ?? null).first();
  if (existing) return existing.id;
  const id = uuid();
  await db.prepare(
    `INSERT INTO pending_changes (id, kind, booking_id, source_id, uid, start_date, end_date, status, draft_message, detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).bind(id, c.kind, c.booking_id ?? null, c.source_id ?? null, c.uid ?? null, c.start_date ?? null, c.end_date ?? null,
    c.draft_message ?? null, c.detail ? JSON.stringify(c.detail) : null, iso(now), iso(now)).run();
  await audit(db, now, 'system', `change_opened_${c.kind}`, c.booking_id ?? null, { change: id, uid: c.uid ?? null, start: c.start_date, end: c.end_date });
  return id;
}

export async function getChange(db, id) {
  return db.prepare('SELECT * FROM pending_changes WHERE id = ?').bind(id).first();
}

export async function setChangeStatus(db, now, id, status, fields = {}) {
  const sets = ['status = ?', 'updated_at = ?'];
  const binds = [status, iso(now)];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); binds.push(v); }
  if (status === 'closed' || status === 'verified') { sets.push('closed_at = ?'); binds.push(iso(now)); }
  await db.prepare(`UPDATE pending_changes SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
}

export function tcCancellationDraft(env, b) {
  const code = env.TC_PROPERTY_CODE || '<property code>';
  return [
    'To: Travel Chapter owner iCal cancellations team',
    `Subject: Owner booking change – property ${code} – ${b.arrival} to ${b.departure}`,
    '',
    `Property: Little Slate House (${code})`,
    `Owner booking dates (arrival – departure): ${b.arrival} – ${b.departure} (${b.nights} nights)`,
    b.agent_ref ? `Travel Chapter reference: ${b.agent_ref}` : 'Travel Chapter reference: (if any)',
    'Requested change: cancel/release these owner-booked dates.',
    'Please propose a time so we can remove the block on both calendars within the same hour.',
  ].join('\n');
}
