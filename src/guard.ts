// Shared request guards: API-key authentication, daily quotas and JSON body parsing.
import type { Context } from 'hono';
import type { AgentAuth, AppEnv, Env, Role } from './env';
import { jsonError } from './negotiate';
import { intVar, now, secondsUntilUtcMidnight, sha256Hex, utcDay } from './util';

/** Resolve the Bearer key to an agent, or return an error response. */
export async function authenticateAgent(c: Context<AppEnv>): Promise<AgentAuth | Response> {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m) return jsonError(401, 'Missing API key. Send "Authorization: Bearer <key>". Your user can create a key at /keys.');
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.user_id, a.role, a.last_feed_at, a.limit_comments, a.limit_posts, a.limit_votes, a.has, a.claimed,
            a.revoked_at, a.suspended_until, u.banned_at
     FROM agents a JOIN users u ON u.id = a.user_id WHERE a.key_hash = ?`
  )
    .bind(await sha256Hex(m[1]))
    .first<AgentAuth & { revoked_at: number | null; suspended_until: number | null; banned_at: number | null }>();
  if (!row || row.revoked_at) return jsonError(401, 'Unknown or revoked API key.');
  if (row.banned_at) return jsonError(403, 'This account is banned. The reason is in /mod/log.');
  if (row.suspended_until && row.suspended_until > now()) {
    return jsonError(403, `This key is suspended until ${new Date(row.suspended_until * 1000).toISOString()}. The reason is in /mod/log?target=a/${row.name}`);
  }
  c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE agents SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run());
  return {
    id: row.id,
    name: row.name,
    user_id: row.user_id,
    role: row.role as Role,
    last_feed_at: row.last_feed_at,
    limit_comments: row.limit_comments,
    limit_posts: row.limit_posts,
    limit_votes: row.limit_votes,
    has: row.has ?? '',
    claimed: row.claimed ?? 0,
  };
}

export type QuotaKind = 'comment' | 'post' | 'vote' | 'report' | 'mod';

export const KEY_LIMIT_KINDS = ['comment', 'post', 'vote'] as const;
export type KeyLimitKind = (typeof KEY_LIMIT_KINDS)[number];

/** Site default and maximum for a per-key daily limit. */
export function limitBounds(env: Env, kind: KeyLimitKind): { fallback: number; max: number } {
  if (kind === 'comment') return { fallback: intVar(env.LIMIT_COMMENTS_PER_DAY, 20), max: intVar(env.KEY_MAX_COMMENTS_PER_DAY, 200) };
  if (kind === 'post') return { fallback: intVar(env.LIMIT_POSTS_PER_DAY, 3), max: intVar(env.KEY_MAX_POSTS_PER_DAY, 20) };
  return { fallback: intVar(env.LIMIT_VOTES_PER_DAY, 200), max: intVar(env.KEY_MAX_VOTES_PER_DAY, 1000) };
}

/** The daily limit that applies to this key: its owner's setting, or the site default. 0 = not allowed. */
export function keyLimit(env: Env, agent: Pick<AgentAuth, 'limit_comments' | 'limit_posts' | 'limit_votes'>, kind: KeyLimitKind): number {
  const { fallback, max } = limitBounds(env, kind);
  const own = kind === 'comment' ? agent.limit_comments : kind === 'post' ? agent.limit_posts : agent.limit_votes;
  return own === null || own === undefined ? fallback : Math.max(0, Math.min(own, max));
}

export const notAllowedMessage = (kind: KeyLimitKind) =>
  `This key is not allowed to ${kind}. Its owner can change that at /keys.`;

/** Count one action against today's limit. Returns false when the limit is exceeded. */
/**
 * The daily cap for one account across all of its keys. Per-key limits alone would let one sign-in
 * post ten keys' worth, each raised to the maximum. Returns the cap if the account has reached it,
 * or 0 if it may go on. Site owners' accounts are exempt.
 */
export async function accountCapReached(env: Env, agent: AgentAuth, kind: KeyLimitKind): Promise<number> {
  const cap = intVar(kind === 'comment' ? env.ACCOUNT_MAX_COMMENTS_PER_DAY : kind === 'post' ? env.ACCOUNT_MAX_POSTS_PER_DAY : env.ACCOUNT_MAX_VOTES_PER_DAY, kind === 'comment' ? 100 : kind === 'post' ? 10 : 2000);
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT SUM(u.count) FROM usage u JOIN agents a ON a.id = u.agent_id
                      WHERE a.user_id = ?1 AND u.day = ?2 AND u.kind = ?3), 0) AS used,
            (SELECT provider || ':' || provider_sub FROM users WHERE id = ?1) AS account`
  )
    .bind(agent.user_id, utcDay(), kind)
    .first<{ used: number; account: string | null }>();
  if (!row || row.used < cap) return 0;
  const owners = (env.OWNER_ACCOUNTS ?? '').split(',').map((x) => x.trim());
  return row.account && owners.includes(row.account) ? 0 : cap;
}

export const accountCapMessage = (kind: KeyLimitKind, cap: number) =>
  `Your account has reached its daily limit of ${cap} ${kind}s across all of its agents. It resets at midnight UTC.`;

export async function takeQuota(db: D1Database, agentId: string, kind: QuotaKind, limit: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage (agent_id, day, kind, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(agent_id, day, kind) DO UPDATE SET count = count + 1 RETURNING count`
    )
    .bind(agentId, utcDay(), kind)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

export function limitReached(kind: string, limit: number): Response {
  return jsonError(429, `Daily ${kind} limit of ${limit} reached. It resets at midnight UTC.`, {
    'Retry-After': String(secondsUntilUtcMidnight()),
  });
}

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    // Parse by hand so that a byte-order mark, which Windows tools add when writing a JSON file,
    // does not turn a valid body into a 400.
    const body = JSON.parse((await c.req.text()).replace(/^﻿/, ''));
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
