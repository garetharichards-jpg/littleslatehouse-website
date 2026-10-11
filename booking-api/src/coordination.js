// Owner actions on the pending-change queue. Every release of dates requires a recorded acknowledgment
// of the coordinated change with Travel Chapter (both systems changed within the same hour).

import { bookingVars, getBooking, releaseNights, transition } from './bookings.js';
import { getChange, setChangeStatus } from './changes.js';
import { sendEmail } from './email.js';
import { withdrawBooking } from './google.js';
import { HttpError, audit, iso } from './util.js';

export async function coordinateChange(db, now, id, body) {
  const c = await getChange(db, id);
  if (!c) throw new HttpError(404, 'not found');
  if (!['open', 'coordinated'].includes(c.status)) throw new HttpError(409, `change is ${c.status}`);
  const agreed = new Date(body?.agreed_at || '');
  if (Number.isNaN(agreed.getTime())) throw new HttpError(400, 'agreed_at (ISO time agreed with Travel Chapter) required');
  await setChangeStatus(db, now, id, 'coordinated', { agreed_at: iso(agreed), detail: JSON.stringify({ ...(JSON.parse(c.detail || '{}')), contact: body.contact ?? null }) });
  await audit(db, now, 'admin', 'change_coordinated', c.booking_id, { change: id, agreed_at: iso(agreed) });
  return getChange(db, id);
}

export async function completeChange(env, db, now, id, body, fetcher = fetch) {
  const c = await getChange(db, id);
  if (!c) throw new HttpError(404, 'not found');
  if (!['open', 'coordinated'].includes(c.status)) throw new HttpError(409, `change is ${c.status}`);
  const ack = typeof body?.acknowledgment === 'string' ? body.acknowledgment.trim() : '';
  if (ack.length < 5) throw new HttpError(400, 'acknowledgment required: who at Travel Chapter confirmed, and when');
  const warnings = [];
  if (c.agreed_at && Math.abs(now - new Date(c.agreed_at)) > 60 * 60_000) {
    warnings.push('completed more than an hour away from the agreed time; check both calendars carefully');
  }

  switch (c.kind) {
    case 'cancel_direct': {
      const b = await getBooking(db, c.booking_id);
      const w = await withdrawBooking(env, c.booking_id, fetcher);
      if (!w.ok) throw new HttpError(502, `could not remove the Google calendar block: ${w.reason}; nothing released`);
      await releaseNights(db, c.booking_id);
      await transition(db, now, c.booking_id, 'cancelled', ", propagation = 'withdrawn'");
      // 'released' = done on our side; the reconciler marks it 'verified' once Travel Chapter's feed drops the block.
      await setChangeStatus(db, now, id, 'released', { acknowledgment: ack });
      await audit(db, now, 'admin', 'coordinated_cancel_released', c.booking_id, { change: id, arrival: b?.arrival });
      if (env.MANAGEMENT_EMAIL && b) {
        // Cleaner/management coordination: only after the release is actually done.
        await sendEmail(env, db, now, {
          bookingId: b.id, template: 'management_cancellation', recipient: env.MANAGEMENT_EMAIL,
          dedupeKey: `management_cancellation:${b.id}`, vars: await bookingVars(env, b, 'management_cancellation'),
        }, fetcher);
      }
      break;
    }
    case 'external_missing':
    case 'external_amended':
      await db.prepare("UPDATE ical_events SET state = 'released' WHERE source_id = ? AND uid = ?").bind(c.source_id, c.uid).run();
      await setChangeStatus(db, now, id, 'closed', { acknowledgment: ack });
      await audit(db, now, 'admin', `${c.kind}_released`, c.booking_id, { change: id, start: c.start_date, end: c.end_date });
      break;
    case 'ghost_block': {
      const resolution = body?.resolution;
      if (!['genuine_booking', 'remove_ghost'].includes(resolution)) throw new HttpError(400, "resolution must be 'genuine_booking' or 'remove_ghost'");
      await db.prepare('UPDATE ical_events SET state = ? WHERE source_id = ? AND uid = ?')
        .bind(resolution === 'genuine_booking' ? 'present' : 'released', c.source_id, c.uid).run();
      await setChangeStatus(db, now, id, 'closed', { acknowledgment: `${resolution}: ${ack}` });
      await audit(db, now, 'admin', `ghost_${resolution}`, null, { change: id, uid: c.uid });
      break;
    }
    default:
      // overlap / propagation_overdue: information only; closing changes no dates.
      await setChangeStatus(db, now, id, 'closed', { acknowledgment: ack });
      await audit(db, now, 'admin', `${c.kind}_closed`, c.booking_id, { change: id });
  }
  return { change: await getChange(db, id), warnings };
}
