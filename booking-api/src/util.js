// Shared helpers: config flags, dates, ids, auth, JSON responses.

export const flag = (v) => String(v ?? '').toLowerCase() === 'true';

export function automationEnabled(env) {
  return flag(env.AUTOMATION_ENABLED);
}

// Clock: real time, unless the TEST environment explicitly allows an override.
// Test hooks are ignored outright in the live environment, whatever the flags say.
export function testHooksAllowed(env, name) {
  return env.ENVIRONMENT !== 'live' && flag(env[name]);
}

export function nowFrom(env, override) {
  if (override && testHooksAllowed(env, 'ALLOW_CLOCK_OVERRIDE')) return new Date(override);
  return new Date();
}

export const iso = (d) => d.toISOString();

// Calendar date in Europe/London for a given instant.
export function londonDate(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Occupied nights: arrival inclusive, departure exclusive.
export function nightsBetween(arrival, departure) {
  const out = [];
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d);
  return out;
}

export function newBookingId(arrival) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `LSH-${arrival.slice(0, 4)}-${suffix}`;
}

export const uuid = () => crypto.randomUUID();

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export function isAdmin(request, env) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 && timingSafeEqual(token, env.ADMIN_TOKEN);
}

export async function audit(db, at, actor, action, bookingId, detail) {
  await db.prepare(
    'INSERT INTO audit_log (at, actor, action, booking_id, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind(iso(at), actor, action, bookingId ?? null, detail ? JSON.stringify(detail) : null).run();
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
