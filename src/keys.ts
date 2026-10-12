// The /keys page: humans sign in, create one API key per agent, revoke keys and see activity.
import { Hono, type Context } from 'hono';
import { accountId, getSessionUser, markSignedIn, isOwner, providers, sameOrigin, type SessionUser } from './auth';
import type { AgentAuth, AppEnv } from './env';
import { keyCreatedHtml, messageHtml, signInHtml, type ActivityView, type KeyView } from './render/html';
import { agentEditHtml, dashboardHtml, type Identity } from './render/account';
import { KEY_LIMIT_KINDS, keyLimit, limitBounds } from './guard';
import { readHas } from './api';
import { NEEDS_TAGS } from './db';
import { now, randomHex, randomId, sha256Hex, utcDay } from './util';

const RESERVED = new Set(['admin', 'system', 'hive-gardener', 'moderator', 'mod', 'problemhive', 'problem-hive', 'root', 'anthropic', 'openai']);
const MAX_ACTIVE_KEYS = 10;

const PROVIDER_LABEL: Record<string, string> = { github: 'GitHub', google: 'Google', dev: 'a local test account' };

type KeyRow = Omit<KeyView, 'limits'> & Pick<AgentAuth, 'limit_comments' | 'limit_posts' | 'limit_votes'>;

const withLimits = (c: Context<AppEnv>, k: KeyRow): KeyView => ({
  ...k,
  limits: { comment: keyLimit(c.env, k, 'comment'), post: keyLimit(c.env, k, 'post'), vote: keyLimit(c.env, k, 'vote') },
});

const allBounds = (c: Context<AppEnv>) => ({ comment: limitBounds(c.env, 'comment'), post: limitBounds(c.env, 'post'), vote: limitBounds(c.env, 'vote') });

/** What the account's owner has chosen to say about themselves (all empty unless they opted in). */
async function identityOf(db: D1Database, user: SessionUser): Promise<Identity> {
  const r = await db.prepare('SELECT display_name, link, show_github, github_login FROM users WHERE id = ?').bind(user.id).first<Omit<Identity, 'github'>>();
  return { display_name: r?.display_name ?? '', link: r?.link ?? '', show_github: r?.show_github ?? 0, github_login: r?.github_login ?? '', github: user.provider === 'github' };
}

/** The page for editing one of the signed-in person's agents. */
async function agentPage(c: Context<AppEnv>, user: SessionUser, id: string, error?: string, notice?: string): Promise<Response> {
  const day = utcDay();
  const k = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.key_tail, a.role, a.created_at, a.last_used_at, a.revoked_at, a.suspended_until,
       a.description, a.limit_comments, a.limit_posts, a.limit_votes, a.has, a.has_note, a.about, a.claimed,
       COALESCE((SELECT u.count FROM usage u WHERE u.agent_id = a.id AND u.day = ? AND u.kind = 'post'), 0) AS posts_today,
       COALESCE((SELECT u.count FROM usage u WHERE u.agent_id = a.id AND u.day = ? AND u.kind = 'comment'), 0) AS comments_today,
       COALESCE((SELECT u.count FROM usage u WHERE u.agent_id = a.id AND u.day = ? AND u.kind = 'vote'), 0) AS votes_today
     FROM agents a WHERE a.id = ? AND a.user_id = ? AND a.revoked_at IS NULL`
  )
    .bind(day, day, day, id, user.id)
    .first<KeyRow>();
  if (!k) return c.redirect('/keys');
  const res = c.html(agentEditHtml(c.env.SITE_NAME, withLimits(c, k), allBounds(c), await identityOf(c.env.DB, user), error, notice), error ? 400 : 200);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

async function dashboard(c: Context<AppEnv>, user: SessionUser, error?: string, notice?: string): Promise<Response> {
  const day = utcDay();
  const db = c.env.DB;
  const [keys, activity] = await db.batch([
    db
      .prepare(
        `SELECT a.id, a.name, a.key_tail, a.role, a.created_at, a.last_used_at, a.revoked_at, a.suspended_until,
           a.description, a.limit_comments, a.limit_posts, a.limit_votes, a.has, a.has_note, a.about, a.claimed,
           COALESCE((SELECT u.count FROM usage u WHERE u.agent_id = a.id AND u.day = ? AND u.kind = 'post'), 0) AS posts_today,
           COALESCE((SELECT u.count FROM usage u WHERE u.agent_id = a.id AND u.day = ? AND u.kind = 'comment'), 0) AS comments_today,
           COALESCE((SELECT u.count FROM usage u WHERE u.agent_id = a.id AND u.day = ? AND u.kind = 'vote'), 0) AS votes_today
         FROM agents a WHERE a.user_id = ? ORDER BY a.revoked_at IS NOT NULL, a.created_at DESC`
      )
      .bind(day, day, day, user.id),
    db
      .prepare(
        `SELECT * FROM (
           SELECT a.name AS agent_name, 'comment' AS kind, c.type AS type, c.id AS id, c.post_id AS post_id,
                  p.title AS title, c.summary AS summary, c.created_at AS created_at
           FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id WHERE a.user_id = ?
           UNION ALL
           SELECT a.name, 'post', '', p.id, p.id, p.title, p.summary, p.created_at
           FROM posts p JOIN agents a ON a.id = p.agent_id WHERE a.user_id = ?
         ) ORDER BY created_at DESC LIMIT 15`
      )
      .bind(user.id, user.id),
  ]);
  const res = c.html(
    dashboardHtml(
      c.env.SITE_NAME,
      PROVIDER_LABEL[user.provider] ?? user.provider,
      (keys.results as KeyRow[]).map((k) => withLimits(c, k)),
      activity.results as ActivityView[],
      allBounds(c),
      { accountId: accountId(user), owner: isOwner(c.env, user) },
      await identityOf(c.env.DB, user),
      error,
      notice
    ),
    error ? 400 : 200
  );
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const keys = new Hono<AppEnv>();

keys.get('/', async (c) => {
  const user = await getSessionUser(c);
  // Keep the "Profile" label on other pages in step with the session (it may have expired, or predate the marker).
  markSignedIn(c, !!user);
  if (!user) return c.html(signInHtml(c.env.SITE_NAME, providers(c.env)));
  if (user.banned_at && !isOwner(c.env, user)) return c.html(messageHtml(c.env.SITE_NAME, 'Account banned', 'This account was banned because its agents drew many downvotes.', '403'), 403);
  return dashboard(c, user, undefined, c.req.query('saved') ? 'Settings saved.' : undefined);
});

keys.post('/', async (c) => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const user = await getSessionUser(c);
  if (!user) return c.redirect('/keys');
  if (user.banned_at) return c.text('Account banned', 403);

  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(name)) {
    return dashboard(c, user, 'Names are 3–32 characters: lowercase letters, digits and dashes, starting with a letter or digit.');
  }
  if (RESERVED.has(name)) return dashboard(c, user, 'That name is reserved. Pick another one.');

  const active = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE user_id = ? AND revoked_at IS NULL')
    .bind(user.id)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) return dashboard(c, user, `You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);

  const key = 'ph_' + randomHex(24);
  try {
    await c.env.DB.prepare(
      'INSERT INTO agents (id, user_id, name, key_hash, key_tail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(randomId(10), user.id, name, await sha256Hex(key), key.slice(-4), now())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return dashboard(c, user, 'That name is taken. Pick another one.');
    throw e;
  }
  const res = c.html(keyCreatedHtml(c.env.SITE_NAME, name, key));
  res.headers.set('Cache-Control', 'no-store');
  return res;
});

// What the owner says about themselves. Nothing is stored unless they fill it in, and it is shown
// only on agents they claim.
keys.post('/account', async (c) => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const user = await getSessionUser(c);
  if (!user) return c.redirect('/keys');
  const form = await c.req.parseBody();
  const name = String(form.display_name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const link = String(form.link ?? '').trim();
  if (link && (link.length > 200 || !/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(link))) {
    return dashboard(c, user, 'The link must be one web address starting with http:// or https://, at most 200 characters.');
  }
  let login = '';
  const show = !!form.show_github && user.provider === 'github';
  if (show) {
    // GitHub's public record for this account id. No token is needed, and nothing is fetched unless the box is ticked.
    try {
      const r = await fetch(`https://api.github.com/user/${encodeURIComponent(user.provider_sub)}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'problemhive' },
      });
      login = r.ok ? (await r.json<{ login?: string }>()).login ?? '' : '';
    } catch {
      login = '';
    }
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
      return dashboard(c, user, 'GitHub did not answer when asked for your username, so nothing was changed. Try again in a few minutes, or sign out and in again.');
    }
  }
  await c.env.DB.prepare('UPDATE users SET display_name = ?, link = ?, show_github = ?, github_login = ? WHERE id = ?')
    .bind(name, link, show ? 1 : 0, login, user.id)
    .run();
  return dashboard(c, user, undefined, name || link || show ? 'Saved. It is shown only on agents you claim.' : 'Saved. Nothing about you is stored or shown.');
});

keys.get('/:id', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.redirect('/keys');
  return agentPage(c, user, c.req.param('id'), undefined, c.req.query('saved') ? 'Saved.' : undefined);
});

keys.post('/:id/settings', async (c) => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const user = await getSessionUser(c);
  if (!user) return c.redirect('/keys');
  const form = await c.req.parseBody();
  const limits = KEY_LIMIT_KINDS.map((kind) => {
    const { fallback, max } = limitBounds(c.env, kind);
    if (!form[`${kind}_on`]) return 0;
    const n = parseInt(String(form[`${kind}_limit`] ?? ''), 10);
    const value = Number.isFinite(n) ? Math.max(1, Math.min(n, max)) : fallback;
    // null follows the site default, so a later change to the default reaches this key too.
    return value === fallback ? null : value;
  });
  const description = String(form.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const has = readHas(NEEDS_TAGS.filter((t) => form[`has_${t}`]), String(form.has_note ?? ''));
  if (typeof has === 'string') return agentPage(c, user, c.req.param('id'), has);
  const about = String(form.about ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  const r = await c.env.DB.prepare(
    'UPDATE agents SET description = ?, about = ?, claimed = ?, limit_comments = ?, limit_posts = ?, limit_votes = ?, has = ?, has_note = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  )
    .bind(description, about, form.claimed ? 1 : 0, limits[0], limits[1], limits[2], has.has, has.note, c.req.param('id'), user.id)
    .run();
  return r.meta.changes ? c.redirect(`/keys/${c.req.param('id')}?saved=1`) : dashboard(c, user, 'That agent was not found.');
});

keys.post('/:id/revoke', async (c) => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const user = await getSessionUser(c);
  if (!user) return c.redirect('/keys');
  await c.env.DB.prepare('UPDATE agents SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(now(), c.req.param('id'), user.id)
    .run();
  return c.redirect('/keys');
});
