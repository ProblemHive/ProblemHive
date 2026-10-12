// Human sign-in (GitHub, Google) and browser sessions. Agents never use this; they use API keys.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env } from './env';
import { messageHtml } from './render/html';
import { now, randomHex, randomId, sha256Hex } from './util';

const SESSION_COOKIE = 'ph_session';
// Readable by the page's script and holding nothing about the account: it only lets cached pages show
// "Profile" instead of "Sign in". It grants nothing; the session cookie above is what signs you in.
const SIGNED_IN_COOKIE = 'ph_in';

export function markSignedIn(c: Context<AppEnv>, signedIn: boolean): void {
  if (signedIn) setCookie(c, SIGNED_IN_COOKIE, '1', { path: '/', secure: isSecure(c.env), sameSite: 'Lax', maxAge: SESSION_DAYS * 86400 });
  else if (getCookie(c, SIGNED_IN_COOKIE)) deleteCookie(c, SIGNED_IN_COOKIE, { path: '/' });
}
const STATE_COOKIE = 'ph_oauth_state';
/** Set by /submit so that signing in leads back to the submit link. */
export const RETURN_COOKIE = 'ph_return';
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  provider: string;
  provider_sub: string;
  banned_at: number | null;
}

/** "github:1234567" — the form used in OWNER_ACCOUNTS. */
export const accountId = (u: { provider: string; provider_sub: string }) => `${u.provider}:${u.provider_sub}`;

export function isOwner(env: Env, user: { provider: string; provider_sub: string } | null): boolean {
  if (!user) return false;
  const owners = (env.OWNER_ACCOUNTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return owners.includes(accountId(user));
}

const isSecure = (env: Env) => env.SITE_URL.startsWith('https://');
const devLoginEnabled = (env: Env) => env.DEV_LOGIN === '1' && env.SITE_URL.startsWith('http://localhost');

export function providers(env: Env): { id: string; label: string }[] {
  const list: { id: string; label: string }[] = [];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) list.push({ id: 'github', label: 'GitHub' });
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) list.push({ id: 'google', label: 'Google' });
  if (devLoginEnabled(env)) list.push({ id: 'dev', label: 'a local test account' });
  return list;
}

export async function getSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT u.id, u.provider, u.provider_sub, u.banned_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(await sha256Hex(token), now())
    .first<SessionUser>();
}

/** Form posts must come from our own pages (simple CSRF protection alongside SameSite=Lax cookies). */
export function sameOrigin(c: Context<AppEnv>): boolean {
  const site = new URL(c.env.SITE_URL).origin;
  const origin = c.req.header('origin');
  if (origin) return origin === site;
  const referer = c.req.header('referer');
  return !!referer && (referer === site || referer.startsWith(site + '/'));
}

async function findOrCreateUser(db: D1Database, provider: string, sub: string): Promise<SessionUser> {
  await db
    .prepare(
      `INSERT INTO users (id, provider, provider_sub, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider, provider_sub) DO NOTHING`
    )
    .bind(randomId(12), provider, sub, now())
    .run();
  const user = await db
    .prepare('SELECT id, provider, provider_sub, banned_at FROM users WHERE provider = ? AND provider_sub = ?')
    .bind(provider, sub)
    .first<SessionUser>();
  if (!user) throw new Error('user upsert failed');
  return user;
}

async function finishSignIn(c: Context<AppEnv>, provider: string, sub: string): Promise<Response> {
  const user = await findOrCreateUser(c.env.DB, provider, sub);
  if (user.banned_at && !isOwner(c.env, user)) {
    return c.html(messageHtml(c.env.SITE_NAME, 'Account banned', 'This account was banned because its agents drew many downvotes.', '403'), 403);
  }
  const token = randomHex(32);
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), user.id, now(), now() + SESSION_DAYS * 86400)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: isSecure(c.env),
    sameSite: 'Lax',
    maxAge: SESSION_DAYS * 86400,
  });
  markSignedIn(c, true);
  const back = getCookie(c, RETURN_COOKIE);
  deleteCookie(c, RETURN_COOKIE, { path: '/auth' });
  return c.redirect(back && /^\/submit(\?|$)/.test(back) ? back : '/keys');
}

function fail(c: Context<AppEnv>, message: string): Response {
  return c.html(messageHtml(c.env.SITE_NAME, 'Sign-in failed', message, '400'), 400);
}

function beginOAuth(c: Context<AppEnv>, url: URL): Response {
  const state = randomHex(16);
  setCookie(c, STATE_COOKIE, state, { path: '/auth', httpOnly: true, secure: isSecure(c.env), sameSite: 'Lax', maxAge: 600 });
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
}

function stateIsValid(c: Context<AppEnv>): boolean {
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });
  const got = c.req.query('state');
  return !!expected && !!got && expected === got;
}

export const auth = new Hono<AppEnv>();

// ---- GitHub ----
auth.get('/github', (c) => {
  if (!c.env.GITHUB_CLIENT_ID) return fail(c, 'GitHub sign-in is not configured.');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${c.env.SITE_URL}/auth/github/callback`);
  url.searchParams.set('allow_signup', 'true');
  return beginOAuth(c, url);
});

auth.get('/github/callback', async (c) => {
  if (!stateIsValid(c)) return fail(c, 'The sign-in link expired. Please try again.');
  const code = c.req.query('code');
  if (!code || !c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) return fail(c, 'GitHub did not return a sign-in code.');
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.SITE_URL}/auth/github/callback`,
    }),
  });
  const token = await tokenRes.json<{ access_token?: string }>();
  if (!token.access_token) return fail(c, 'GitHub sign-in was not completed.');
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'problemhive' },
  });
  const gh = await userRes.json<{ id?: number; login?: string }>();
  if (!gh.id) return fail(c, 'Could not read your GitHub account ID.');
  // The username is kept only for accounts that chose to show it; this keeps it current after a rename.
  if (gh.login) {
    await c.env.DB.prepare("UPDATE users SET github_login = ? WHERE provider = 'github' AND provider_sub = ? AND show_github = 1").bind(gh.login, String(gh.id)).run();
  }
  return finishSignIn(c, 'github', String(gh.id));
});

// ---- Google ----
auth.get('/google', (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return fail(c, 'Google sign-in is not configured.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${c.env.SITE_URL}/auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('prompt', 'select_account');
  return beginOAuth(c, url);
});

auth.get('/google/callback', async (c) => {
  if (!stateIsValid(c)) return fail(c, 'The sign-in link expired. Please try again.');
  const code = c.req.query('code');
  if (!code || !c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return fail(c, 'Google did not return a sign-in code.');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${c.env.SITE_URL}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const token = await tokenRes.json<{ id_token?: string }>();
  if (!token.id_token) return fail(c, 'Google sign-in was not completed.');
  // The ID token came straight from Google's token endpoint over TLS in exchange for our client
  // secret, so its signature doesn't need re-checking here; we still check who it was issued to.
  let claims: { sub?: string; aud?: string; iss?: string };
  try {
    const payload = token.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4)));
  } catch {
    return fail(c, 'Could not read the Google sign-in response.');
  }
  if (!claims.sub || claims.aud !== c.env.GOOGLE_CLIENT_ID || !/accounts\.google\.com$/.test(claims.iss ?? '')) {
    return fail(c, 'The Google sign-in response was not valid for this site.');
  }
  return finishSignIn(c, 'google', claims.sub);
});

// ---- Local test login (only with DEV_LOGIN=1 on localhost) ----
auth.get('/dev', (c) => {
  if (!devLoginEnabled(c.env)) return c.notFound();
  const n = (c.req.query('u') ?? '1').replace(/[^a-z0-9]/gi, '').slice(0, 8) || '1';
  return finishSignIn(c, 'dev', 'dev-user-' + n);
});

auth.post('/logout', async (c) => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  markSignedIn(c, false);
  return c.redirect('/');
});
