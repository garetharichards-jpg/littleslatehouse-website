// Google sign-in for the owner's read-only browser view of /admin. All identities here are fictional.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './harness.mjs';

const LOGIN = {
  ADMIN_EMAIL: 'Owner@test.invalid',
  LOGIN_BASE_URL: 'http://api.test',
  LOGIN_GOOGLE_CLIENT_ID: 'login-client.apps.test',
  LOGIN_GOOGLE_CLIENT_SECRET: 'login-secret',
  SESSION_SECRET: 'session-secret-fixture-0123456789abcdef',
};
const HTML = { accept: 'text/html' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (over = {}) => `${b64({ alg: 'none' })}.${b64({
  iss: 'https://accounts.google.com', aud: LOGIN.LOGIN_GOOGLE_CLIENT_ID, email: 'owner@test.invalid',
  email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, ...over,
})}.sig`;
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]).map((c) => c.split(';')[0]);

async function signIn(t, claims) {
  const login = await t.api('GET', '/auth/login?next=/admin/status', undefined, HTML);
  assert.equal(login.status, 302);
  const google = new URL(login.headers.get('location'));
  assert.equal(google.origin + google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(google.searchParams.get('login_hint'), LOGIN.ADMIN_EMAIL);
  assert.equal(google.searchParams.get('redirect_uri'), 'http://api.test/auth/callback');
  t.world.idToken = idToken(claims);
  const cb = await t.api('GET', `/auth/callback?code=c1&state=${google.searchParams.get('state')}`, undefined,
    { ...HTML, cookie: cookiesOf(login).join('; ') });
  return cb;
}

test('browser visit to /admin asks for Google sign-in; API clients still get 401', async () => {
  const t = await start(LOGIN);
  try {
    const r = await t.api('GET', '/admin/status', undefined, HTML);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/auth/login?next=%2Fadmin%2Fstatus');
    assert.equal((await t.api('GET', '/admin/status')).status, 401);
    const root = await t.api('GET', '/', undefined, HTML);
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), 'http://api.test/admin');
    assert.equal((await t.api('GET', '/')).status, 200);
  } finally { await t.stop(); }
});

test('the owner signs in and can read, but cannot change anything without the admin token', async () => {
  const t = await start(LOGIN);
  try {
    const cb = await signIn(t);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/admin/status');
    const session = cookiesOf(cb).find((c) => c.startsWith('lsh_session=') && c.length > 20);
    assert.ok(session);
    const st = await t.api('GET', '/admin/status', undefined, { cookie: session });
    assert.equal(st.status, 200);
    assert.equal(st.data.environment, 'test');
    const home = await t.api('GET', '/admin', undefined, { ...HTML, cookie: session });
    assert.match(home.data, /Signed in as owner@test.invalid/);
    assert.equal((await t.api('POST', '/admin/run', { job: 'hourly' }, { cookie: session })).status, 401);
    const forged = session.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await t.api('GET', '/admin/status', undefined, { cookie: forged })).status, 401);
  } finally { await t.stop(); }
});

test('other Google accounts, wrong audience, unverified email and bad state are refused', async () => {
  const t = await start(LOGIN);
  try {
    assert.equal((await signIn(t, { email: 'someone@test.invalid' })).status, 403);
    assert.equal((await signIn(t, { aud: 'other-client' })).status, 401);
    assert.equal((await signIn(t, { email_verified: false })).status, 401);
    assert.equal((await t.api('GET', '/auth/callback?code=c1&state=forged', undefined, HTML)).status, 400);
    const { results } = await t.db.prepare("SELECT action, detail FROM audit_log WHERE actor = 'google_signin' ORDER BY id").all();
    assert.deepEqual(results.map((r) => r.action), ['signin_refused', 'signin_failed', 'signin_failed']);
    assert.match(results[1].detail, /audience mismatch/);
  } finally { await t.stop(); }
});

test('sign-in is off unless configured, and never redirects outside /admin', async () => {
  const off = await start();
  try { assert.equal((await off.api('GET', '/auth/login', undefined, HTML)).status, 503); } finally { await off.stop(); }
  const t = await start(LOGIN);
  try {
    const login = await t.api('GET', '/auth/login?next=https://evil.test/admin', undefined, HTML);
    const google = new URL(login.headers.get('location'));
    t.world.idToken = idToken();
    const cb = await t.api('GET', `/auth/callback?code=c1&state=${google.searchParams.get('state')}`, undefined,
      { cookie: cookiesOf(login).join('; ') });
    assert.equal(cb.headers.get('location'), '/admin');
  } finally { await t.stop(); }
});
