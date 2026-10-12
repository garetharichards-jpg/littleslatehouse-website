// Google sign-in for the owner's browser view of /admin.
// Only ADMIN_EMAIL may sign in. A session grants read-only (GET) admin access; every change still needs the
// Bearer ADMIN_TOKEN, so a signed-in browser cannot be tricked into mutating anything (no CSRF surface).
// Secrets: LOGIN_GOOGLE_CLIENT_ID, LOGIN_GOOGLE_CLIENT_SECRET, SESSION_SECRET. Vars: ADMIN_EMAIL, LOGIN_BASE_URL.

import { HttpError } from './util.js';

const SESSION_COOKIE = 'lsh_session';
const STATE_COOKIE = 'lsh_oauth';
const SESSION_SECONDS = 12 * 3600;
const STATE_SECONDS = 600;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export function loginConfigured(env) {
  return !!(env.LOGIN_GOOGLE_CLIENT_ID && env.LOGIN_GOOGLE_CLIENT_SECRET && env.ADMIN_EMAIL && env.LOGIN_BASE_URL
    && String(env.SESSION_SECRET || '').length >= 32);
}

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env, obj) {
  const body = b64url(enc.encode(JSON.stringify(obj)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verify(env, value, nowSec) {
  const [body, sig] = String(value || '').split('.');
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(body)))) return null;
    const obj = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return typeof obj.exp === 'number' && obj.exp > nowSec ? obj : null;
  } catch { return null; }
}

function cookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const setCookie = (name, value, maxAge, path = '/') => `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
const sameEmail = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const safeNext = (n) => (typeof n === 'string' && /^\/admin(\/[A-Za-z0-9_\-/.]*)?$/.test(n) ? n : '/admin');
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });
const html = (body, status = 200, headers = {}) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Slate House admin</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5">${body}</body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } },
);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Signed-in owner's email, or null.
export async function sessionEmail(request, env, now) {
  if (!loginConfigured(env)) return null;
  const s = await verify(env, cookie(request, SESSION_COOKIE), Math.floor(now.getTime() / 1000));
  return s && sameEmail(s.email, env.ADMIN_EMAIL) ? s.email : null;
}

export const wantsHtml = (request) => request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');

export function loginRedirect(url) {
  return redirect(`/auth/login?next=${encodeURIComponent(url.pathname)}`);
}

export function adminHome(email) {
  const links = ['status', 'bookings', 'changes', 'external-blocks']
    .map((p) => `<li><a href="/admin/${p}">${p}</a></li>`).join('');
  return html(`<h1>Little Slate House — booking admin</h1><p>Signed in as ${esc(email)}. Read-only view; changes need the admin token.</p><ul>${links}</ul><p><a href="/auth/logout">Sign out</a></p>`);
}

export async function handleAuth(request, env, now, url) {
  const p = url.pathname;
  if (p === '/auth/logout') {
    return html('<p>Signed out. <a href="/admin">Sign in again</a></p>', 200, { 'set-cookie': setCookie(SESSION_COOKIE, '', 0) });
  }
  if (!loginConfigured(env)) {
    return html('<h1>Little Slate House — booking admin</h1><p>Google sign-in is not set up yet. Guests are unaffected; the website is at <a href="https://www.littleslatehouse.co.uk">www.littleslatehouse.co.uk</a>.</p>', 503);
  }
  const base = env.LOGIN_BASE_URL.replace(/\/$/, '');
  const redirectUri = `${base}/auth/callback`;
  const nowSec = Math.floor(now.getTime() / 1000);

  if (p === '/auth/login') {
    const next = safeNext(url.searchParams.get('next'));
    // The OAuth state cookie must be set on the host Google redirects back to.
    if (url.origin !== new URL(base).origin) return redirect(`${base}/auth/login?next=${encodeURIComponent(next)}`);
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const q = new URLSearchParams({
      client_id: env.LOGIN_GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email', state, login_hint: env.ADMIN_EMAIL, prompt: 'select_account',
    });
    return redirect(`${GOOGLE_AUTH}?${q}`, {
      'set-cookie': setCookie(STATE_COOKIE, await sign(env, { state, next, exp: nowSec + STATE_SECONDS }), STATE_SECONDS, '/auth'),
    });
  }

  if (p === '/auth/callback') {
    const st = await verify(env, cookie(request, STATE_COOKIE), nowSec);
    const code = url.searchParams.get('code');
    if (!st || !code || url.searchParams.get('state') !== st.state) {
      return html('<p>Sign-in expired or was interrupted. <a href="/admin">Try again</a></p>', 400);
    }
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.LOGIN_GOOGLE_CLIENT_ID, client_secret: env.LOGIN_GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    const tok = await r.json().catch(() => ({}));
    // The ID token comes straight from Google's token endpoint over TLS, so its claims are trusted
    // without a signature check (OpenID Connect Core 3.1.3.7); issuer, audience and expiry are still checked.
    let claims = null;
    try { claims = JSON.parse(new TextDecoder().decode(unb64url(String(tok.id_token).split('.')[1]))); } catch { /* invalid */ }
    const valid = r.ok && claims && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
      && claims.aud === env.LOGIN_GOOGLE_CLIENT_ID && claims.exp > nowSec && claims.email_verified === true;
    const clear = setCookie(STATE_COOKIE, '', 0, '/auth');
    if (!valid) return html('<p>Google sign-in failed. <a href="/admin">Try again</a></p>', 401, { 'set-cookie': clear });
    if (!sameEmail(claims.email, env.ADMIN_EMAIL)) {
      return html(`<p>${esc(claims.email)} is not allowed here. <a href="/auth/login">Use another account</a></p>`, 403, { 'set-cookie': clear });
    }
    const session = await sign(env, { email: claims.email, exp: nowSec + SESSION_SECONDS });
    const headers = new Headers({ location: safeNext(st.next), 'cache-control': 'no-store' });
    headers.append('set-cookie', clear);
    headers.append('set-cookie', setCookie(SESSION_COOKIE, session, SESSION_SECONDS));
    return new Response(null, { status: 302, headers });
  }
  throw new HttpError(404, 'not found');
}
