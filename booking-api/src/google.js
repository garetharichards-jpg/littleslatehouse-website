// Publishes direct bookings to the owner's dedicated Google calendar (the feed Travel Chapter subscribes to).
// Auth: OAuth refresh token for a Google account with WRITE access to that calendar (Worker secrets).
// Events carry no guest data: the calendar's private iCal feed is shared with the agent.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export function googleConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CALENDAR_ID);
}

// Stable event id per booking (Google allows base32hex: 0-9 a-v). 'lsh' + hex(booking id).
export function eventIdFor(bookingId) {
  return 'lsh' + Array.from(new TextEncoder().encode(bookingId), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Google exposes such an event in its iCal feed with UID '<eventId>@google.com'.
export function bookingIdFromUid(uid) {
  const m = /^lsh([0-9a-f]+)@google\.com$/.exec(uid || '');
  if (!m || m[1].length % 2) return null;
  const bytes = m[1].match(/../g).map((h) => parseInt(h, 16));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

async function accessToken(env, fetcher) {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google auth failed (HTTP ${res.status})`);
  return body.access_token;
}

function eventBody(b) {
  return {
    id: eventIdFor(b.id),
    summary: 'Little Slate House: owner booking',
    description: `Direct booking ${b.id}. Availability block only.`,
    start: { date: b.arrival },
    end: { date: b.departure }, // all-day end date is exclusive = checkout day
    transparency: 'opaque',
    extendedProperties: { private: { lsh_booking_id: b.id } },
  };
}

// Create or update exactly one event per booking (idempotent by event id).
export async function publishBooking(env, b, fetcher = fetch) {
  if (!googleConfigured(env)) return { ok: false, reason: 'Google Calendar write access not configured' };
  try {
    const token = await accessToken(env, fetcher);
    const cal = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const body = eventBody(b);
    let res = await fetcher(`${API}/calendars/${cal}/events`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 409) {
      res = await fetcher(`${API}/calendars/${cal}/events/${body.id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    }
    if (!res.ok) return { ok: false, reason: `Google Calendar HTTP ${res.status}` };
    return { ok: true, event_id: body.id };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

export async function withdrawBooking(env, bookingId, fetcher = fetch) {
  if (!googleConfigured(env)) return { ok: false, reason: 'Google Calendar write access not configured' };
  try {
    const token = await accessToken(env, fetcher);
    const cal = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
    const res = await fetcher(`${API}/calendars/${cal}/events/${eventIdFor(bookingId)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) return { ok: false, reason: `Google Calendar HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

export async function eventExists(env, bookingId, fetcher = fetch) {
  if (!googleConfigured(env)) return null;
  try {
    const token = await accessToken(env, fetcher);
    const cal = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
    const res = await fetcher(`${API}/calendars/${cal}/events/${eventIdFor(bookingId)}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) return null;
    const ev = await res.json();
    return ev.status !== 'cancelled';
  } catch {
    return null;
  }
}
