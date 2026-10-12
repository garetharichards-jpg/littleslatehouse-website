// Little Slate House booking API (Cloudflare Worker + D1).
// Production safety: AUTOMATION_ENABLED=false blocks live payments and all non-allow-listed email.

import {
  cancelBooking, checkoutForPayLink, confirmAuthorized, createHold, getBooking, importBooking,
} from './bookings.js';
import {
  adminHome, handleAuth, loginRedirect, sessionEmail, wantsHtml,
} from './auth.js';
import { availability, calendarStatus } from './calendar.js';
import { completeChange, coordinateChange } from './coordination.js';
import { daily, hourly } from './jobs.js';
import { handleStripeWebhook } from './stripe.js';
import {
  HttpError, automationEnabled, isAdmin, iso, json, nowFrom,
} from './util.js';

function cors(env, request) {
  const origin = request.headers.get('origin');
  const allowed = String(env.SITE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'invalid JSON'); }
}

async function route(request, env) {
  const url = new URL(request.url);
  const db = env.DB;
  const now = nowFrom(env, request.headers.get('x-test-now'));
  const { pathname: p } = url;
  const m = request.method;

  if (m === 'GET' && p === '/') {
    return wantsHtml(request) ? Response.redirect(new URL('/admin', url), 302) : json({ service: 'Little Slate House booking API' });
  }
  if (m === 'GET' && p === '/health') return json({ ok: true, environment: env.ENVIRONMENT, automation_enabled: automationEnabled(env) });

  if (m === 'GET' && p === '/api/availability') {
    const res = await availability(env, db, now, url.searchParams.get('from'), url.searchParams.get('to'))
      .catch((e) => { throw new HttpError(400, e.message); });
    return json(res, 200, cors(env, request));
  }

  if (m === 'GET' && p.startsWith('/pay/')) {
    const id = decodeURIComponent(p.slice(5));
    const r = await checkoutForPayLink(env, db, now, id, url.searchParams.get('t'));
    if (r.already_paid) return new Response('This booking is already paid. Thank you.', { status: 200 });
    return Response.redirect(r.url, 303);
  }

  if (m === 'POST' && p === '/webhooks/stripe') {
    const r = await handleStripeWebhook(request, env, db, now);
    return json(r.body, r.status);
  }

  if (m === 'GET' && p.startsWith('/auth/')) return handleAuth(request, env, now, url);

  // ---- Admin (Bearer ADMIN_TOKEN; the owner's Google session may read with GET) ----
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!isAdmin(request, env)) {
      const email = m === 'GET' ? await sessionEmail(request, env, now) : null;
      if (!email) {
        if (wantsHtml(request)) return loginRedirect(url);
        throw new HttpError(401, 'unauthorised');
      }
      if (p === '/admin' || p === '/admin/') return adminHome(email);
    }

    if (m === 'GET' && p === '/admin/status') {
      const counts = await db.prepare('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status').all();
      const emails = await db.prepare('SELECT status, COUNT(*) AS n FROM email_log GROUP BY status').all();
      return json({
        environment: env.ENVIRONMENT,
        automation_enabled: automationEnabled(env),
        stripe_mode: env.STRIPE_MODE,
        payment_policy: env.PAYMENT_POLICY || null,
        capture_mode: env.CAPTURE_MODE === 'automatic' ? 'automatic' : 'manual',
        calendar: await calendarStatus(env, db, now),
        bookings: counts.results,
        emails: emails.results,
      });
    }
    if (m === 'POST' && p === '/admin/bookings') return json(await createHold(env, db, now, await readJson(request)), 201);
    if (m === 'GET' && p === '/admin/changes') {
      const { results } = await db.prepare(
        "SELECT * FROM pending_changes WHERE status IN ('open','coordinated','released') ORDER BY created_at",
      ).all();
      return json(results);
    }
    if (m === 'GET' && p === '/admin/external-blocks') {
      const { results } = await db.prepare(
        `SELECT source_id, uid, start_date, end_date, summary, state, linked_booking_id, agent_ref, first_seen_at, last_seen_at, missing_since
         FROM ical_events WHERE end_date >= ? ORDER BY start_date`,
      ).bind(url.searchParams.get('from') || '0000-01-01').all();
      return json(results);
    }
    if (m === 'PUT' && p === '/admin/external-blocks') {
      // Annotate an agent block with its Travel Chapter booking reference (from the agent's booking email).
      const b = await readJson(request);
      if (!b.source_id || !b.uid || !/^[A-Za-z0-9-]{3,32}$/.test(b.agent_ref || '')) throw new HttpError(400, 'source_id, uid and agent_ref required');
      const r = await db.prepare('UPDATE ical_events SET agent_ref = ? WHERE source_id = ? AND uid = ?').bind(b.agent_ref, b.source_id, b.uid).run();
      if (!r.meta.changes) throw new HttpError(404, 'block not found');
      return json({ ok: true });
    }
    if (m === 'GET' && p === '/admin/bookings') {
      const { results } = await db.prepare(
        'SELECT id, guest_name, arrival, departure, nights, party_size, amount_pence, status, source FROM bookings WHERE departure >= ? ORDER BY arrival',
      ).bind(url.searchParams.get('from') || '0000-01-01').all();
      return json(results);
    }
    let mm;
    if (m === 'GET' && (mm = p.match(/^\/admin\/bookings\/([^/]+)$/))) {
      const b = await getBooking(db, mm[1]);
      if (!b) throw new HttpError(404, 'not found');
      const payments = await db.prepare('SELECT * FROM payments WHERE booking_id = ?').bind(b.id).all();
      const emails = await db.prepare('SELECT template, recipient, status, attempts, sent_at, last_error FROM email_log WHERE booking_id = ?').bind(b.id).all();
      return json({ booking: b, payments: payments.results, emails: emails.results });
    }
    if (m === 'POST' && (mm = p.match(/^\/admin\/bookings\/([^/]+)\/cancel$/))) {
      return json(await cancelBooking(env, db, now, mm[1], await readJson(request)));
    }
    if (m === 'POST' && (mm = p.match(/^\/admin\/bookings\/([^/]+)\/confirm$/))) {
      return json(await confirmAuthorized(env, db, now, mm[1], await readJson(request)));
    }
    if (m === 'POST' && (mm = p.match(/^\/admin\/changes\/([^/]+)\/coordinate$/))) {
      return json(await coordinateChange(db, now, mm[1], await readJson(request)));
    }
    if (m === 'POST' && (mm = p.match(/^\/admin\/changes\/([^/]+)\/complete$/))) {
      return json(await completeChange(env, db, now, mm[1], await readJson(request)));
    }
    if (m === 'POST' && p === '/admin/import') return json(await importBooking(env, db, now, await readJson(request)));
    if (m === 'PUT' && (mm = p.match(/^\/admin\/templates\/([a-z_]+)$/))) {
      const t = await readJson(request);
      if (!t.subject || !t.html || !t.text) throw new HttpError(400, 'subject, html and text required');
      await db.prepare(
        `INSERT INTO email_templates (name, subject, html, text, approved, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, html = excluded.html, text = excluded.text,
           approved = excluded.approved, updated_at = excluded.updated_at`,
      ).bind(mm[1], t.subject, t.html, t.text, t.approved ? 1 : 0, iso(now)).run();
      return json({ ok: true, name: mm[1], approved: !!t.approved });
    }
    if (m === 'PUT' && (mm = p.match(/^\/admin\/calendar-sources\/([a-z0-9_-]+)$/))) {
      // Feed URLs are credentials: register the NAME of the Worker secret that holds the URL, never the URL.
      const s = await readJson(request);
      if (!['agent', 'owner_publisher'].includes(s.kind)) throw new HttpError(400, "kind must be 'agent' or 'owner_publisher'");
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(s.url_secret || '')) throw new HttpError(400, 'url_secret must be the name of a Worker secret, e.g. ICAL_TC_URL');
      await db.prepare(
        `INSERT INTO calendar_sources (id, kind, url_secret, enabled, allow_empty) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, url_secret = excluded.url_secret, enabled = excluded.enabled, allow_empty = excluded.allow_empty`,
      ).bind(mm[1], s.kind, s.url_secret, s.enabled === false ? 0 : 1, s.allow_empty ? 1 : 0).run();
      return json({ ok: true, secret_present: !!env[s.url_secret] });
    }
    if (m === 'POST' && p === '/admin/run') {
      const body = await readJson(request);
      const runNow = nowFrom(env, body.now);
      if (body.job === 'hourly') return json(await hourly(env, db, runNow));
      if (body.job === 'daily') return json(await daily(env, db, runNow));
      throw new HttpError(400, "job must be 'hourly' or 'daily'");
    }
  }
  // Deliberately no refund endpoint: refunds are a manual owner action in the Stripe dashboard.
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error('unhandled', err && err.stack);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    const job = event.cron === env.DAILY_CRON ? daily : hourly;
    ctx.waitUntil(job(env, env.DB, now).then((r) => console.log(JSON.stringify({ cron: event.cron, result: r }))));
  },
};
