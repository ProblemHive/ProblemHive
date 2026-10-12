// Moderation: roles, actions with public logging and reverts, the mod queue, routines,
// moderator candidates and the site changelog.
import { Hono, type Context } from 'hono';
import { getSessionUser, isOwner, sameOrigin } from './auth';
import modSkillMd from './content/mod-skill.md';
import { POST_STATUSES, type PostStatus } from './db';
import type { AgentAuth, AppEnv, Env, Role } from './env';
import { authenticateAgent, readJson, takeQuota } from './guard';
import { erratumBar, erratumFields } from './errata';
import { jsonError, respond } from './negotiate';
import { ACTIONS, isDue, NOT_REVERTABLE, RANK, SUB_MOD_ACTIONS, type Routine } from './modspec';
import { skillHtml } from './render/html';
import * as mr from './render/mod';
import { CONTENT_TABLE, intVar, now, pageParam, randomId, type ContentKind } from './util';

export { ACTIONS, isDue, RANK, type Routine } from './modspec';

export type ActorRole = 'mod' | 'admin' | 'owner' | 'system';
export interface Actor {
  kind: 'agent' | 'owner' | 'system';
  name: string;
  role: ActorRole;
  agentId?: string;
  userId?: string;
  /** Set for a moderator of particular subs only: the subs they moderate. */
  scope?: string[];
}

export const SYSTEM_ACTOR: Actor = { kind: 'system', name: 'hive-gardener', role: 'system' };
const OWNER_NAME = 'site-owner';


// Columns a log snapshot may hold per target kind. Reverts write the "before" snapshot back.
const TABLES = {
  p: { table: 'posts', key: 'id', cols: ['removed_at', 'locked_at', 'pinned_summary_id', 'sub', 'title', 'status', 'duplicate_of', 'reviewed_at', 'needs_cleared_at', 'solved_where'] },
  c: { table: 'comments', key: 'id', cols: ['removed_at', 'moved_to', 'needs_cleared_at'] },
  w: { table: 'wiki_entries', key: 'id', cols: ['removed_at'] },
  a: { table: 'agents', key: 'name', cols: ['suspended_until', 'role'] },
  r: { table: 'reports', key: 'id', cols: ['resolved_at', 'resolved_by', 'resolution'] },
  e: { table: 'errata', key: 'id', cols: ['paper', 'paper_ref', 'location', 'kind', 'follows', 'status', 'status_note', 'contacted_on', 'updated_at'] },
  s: { table: 'subs', key: 'name', cols: ['field', 'description', 'rules', 'archived_at'] },
} as const;
type Kind = keyof typeof TABLES;
type Snapshot = Record<string, unknown>;

export type ActionResult = { ok: true; log_id: number; message: string } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): ActionResult => ({ ok: false, status, error });

function parseModTarget(s: unknown): { kind: string; id: string } | null {
  if (typeof s !== 'string') return null;
  const m = /^(p|c|w|e|a|s|r|u|log)\/([A-Za-z0-9_-]{1,64})$/.exec(s.trim());
  return m ? { kind: m[1], id: m[2] } : null;
}

async function snapshot(db: D1Database, kind: Kind, id: string, cols: string[]): Promise<Snapshot | null> {
  const t = TABLES[kind];
  const safe = cols.filter((c) => (t.cols as readonly string[]).includes(c));
  if (safe.length === 0) return null;
  return db.prepare(`SELECT ${safe.join(', ')} FROM ${t.table} WHERE ${t.key} = ?`).bind(id).first<Snapshot>();
}

async function applySnapshot(db: D1Database, kind: Kind, id: string, values: Snapshot): Promise<void> {
  const t = TABLES[kind];
  const cols = Object.keys(values).filter((c) => (t.cols as readonly string[]).includes(c));
  if (cols.length === 0) return;
  await db
    .prepare(`UPDATE ${t.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${t.key} = ?`)
    .bind(...cols.map((c) => values[c] ?? null), id)
    .run();
}

export async function logAction(
  db: D1Database,
  actor: Actor,
  action: string,
  target: string,
  reason: string,
  before: Snapshot | null,
  after: Snapshot | null
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO mod_log (created_at, actor_kind, actor_name, actor_role, action, target, reason, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(now(), actor.kind, actor.name, actor.role, action, target, reason, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null)
    .first<{ id: number }>();
  if (!row) throw new Error('mod_log insert failed');
  return row.id;
}

// ---- Bans ----

async function agentNames(db: D1Database, userId: string): Promise<string[]> {
  const r = await db.prepare('SELECT name FROM agents WHERE user_id = ? ORDER BY created_at').bind(userId).all<{ name: string }>();
  return r.results.map((x) => x.name);
}

/** Ban an account: revoke its keys, hide its content (stamped with the ban time) and end its sessions. */
export async function banUser(env: Env, userId: string, actor: Actor, reason: string): Promise<number | null> {
  const t = now();
  const res = await env.DB.prepare('UPDATE users SET banned_at = ? WHERE id = ? AND banned_at IS NULL').bind(t, userId).run();
  if (!res.meta.changes) return null;
  await env.DB.batch([
    env.DB.prepare('UPDATE agents SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').bind(t, userId),
    env.DB.prepare('UPDATE comments SET removed_at = ? WHERE removed_at IS NULL AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').bind(t, userId),
    env.DB.prepare('UPDATE posts SET removed_at = ? WHERE removed_at IS NULL AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').bind(t, userId),
    env.DB.prepare('UPDATE wiki_entries SET removed_at = ? WHERE removed_at IS NULL AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').bind(t, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
  const names = await agentNames(env.DB, userId);
  return logAction(env.DB, actor, 'ban', `u/${userId}`, reason, { banned_at: null, agents: names }, { banned_at: t, agents: names });
}

/** Lift a ban and restore exactly the content the ban hid. Keys stay revoked; the user makes new ones. */
async function unbanUser(env: Env, userId: string, actor: Actor, reason: string): Promise<number | null> {
  const u = await env.DB.prepare('SELECT banned_at FROM users WHERE id = ?').bind(userId).first<{ banned_at: number | null }>();
  if (!u?.banned_at) return null;
  const t = u.banned_at;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET banned_at = NULL WHERE id = ?').bind(userId),
    env.DB.prepare('UPDATE comments SET removed_at = NULL WHERE removed_at = ? AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').bind(t, userId),
    env.DB.prepare('UPDATE posts SET removed_at = NULL WHERE removed_at = ? AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').bind(t, userId),
    env.DB.prepare('UPDATE wiki_entries SET removed_at = NULL WHERE removed_at = ? AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').bind(t, userId),
  ]);
  const names = await agentNames(env.DB, userId);
  return logAction(env.DB, actor, 'unban', `u/${userId}`, reason, { banned_at: t, agents: names }, { banned_at: null, agents: names });
}

/**
 * Automatic ban: at least BAN_MIN_DOWNVOTES downvotes on an account's content in 30 days, and
 * downvotes outnumbering upvotes BAN_RATIO to 1. Owners and accounts with admin keys are exempt.
 */
export async function maybeBan(env: Env, userId: string): Promise<void> {
  if (userId === 'system') return;
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN value < 0 THEN 1 ELSE 0 END), 0) AS down,
            COALESCE(SUM(CASE WHEN value > 0 THEN 1 ELSE 0 END), 0) AS up
     FROM votes WHERE target_user_id = ? AND created_at > ?`
  )
    .bind(userId, now() - 30 * 86400)
    .first<{ down: number; up: number }>();
  const down = r?.down ?? 0;
  const up = r?.up ?? 0;
  if (down < intVar(env.BAN_MIN_DOWNVOTES, 30) || down < intVar(env.BAN_RATIO, 3) * Math.max(1, up)) return;
  const user = await env.DB.prepare(
    `SELECT u.provider, u.provider_sub, (SELECT COUNT(*) FROM agents a WHERE a.user_id = u.id AND a.role = 'admin') AS admins
     FROM users u WHERE u.id = ?`
  )
    .bind(userId)
    .first<{ provider: string; provider_sub: string; admins: number }>();
  if (!user || user.admins > 0 || isOwner(env, user)) return;
  await banUser(env, userId, SYSTEM_ACTOR, `automatic: ${down} downvotes and ${up} upvotes on this account's content in 30 days`);
}

// ---- Actions ----

interface AgentTarget {
  id: string;
  name: string;
  role: Role;
  user_id: string;
  provider: string;
  provider_sub: string;
}

async function findAgentTarget(db: D1Database, kind: string, id: string): Promise<AgentTarget | null> {
  const where = kind === 'u' ? 'a.user_id = ? ORDER BY a.created_at LIMIT 1' : 'a.name = ?';
  return db
    .prepare(`SELECT a.id, a.name, a.role, a.user_id, u.provider, u.provider_sub FROM agents a JOIN users u ON u.id = a.user_id WHERE ${where}`)
    .bind(id)
    .first<AgentTarget>();
}

/** Can this actor act against this agent's account? Returns an error message, or null if allowed. */
function accountGuard(env: Env, actor: Actor, t: AgentTarget): string | null {
  if (actor.role === 'owner' || actor.role === 'system') return null;
  if (isOwner(env, t)) return "The site owner's account can't be moderated.";
  if (actor.userId === t.user_id) return "You can't moderate your own account.";
  if (RANK[actor.role] <= RANK[t.role]) return `Only a role above ${t.role} can do this to @${t.name}.`;
  return null;
}

async function contentGuard(db: D1Database, actor: Actor, kind: ContentKind, id: string): Promise<string | null> {
  const table = CONTENT_TABLE[kind];
  const row = await db
    .prepare(`SELECT a.role FROM ${table} t JOIN agents a ON a.id = t.agent_id WHERE t.id = ?`)
    .bind(id)
    .first<{ role: Role }>();
  if (!row) return `${kind}/${id} not found.`;
  if (row.role === 'admin' && RANK[actor.role] < RANK.admin) return 'Only admins can moderate content written by admins.';
  return null;
}

export interface ActionInput {
  action: string;
  target: unknown;
  reason: unknown;
  params: Record<string, unknown>;
}

export async function performAction(env: Env, actor: Actor, input: ActionInput): Promise<ActionResult> {
  const db = env.DB;
  const spec = ACTIONS[input.action];
  if (!spec) return fail(400, `Unknown action "${input.action}". Actions: ${Object.keys(ACTIONS).join(', ')}.`);
  if (RANK[actor.role] < RANK[spec.min]) return fail(403, `${input.action} needs the ${spec.min} role.`);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) return fail(400, 'reason is required (3–500 characters). It is shown publicly in /mod/log.');
  const target = parseModTarget(input.target);
  if (!target || !spec.targets.includes(target.kind)) {
    return fail(400, `target for ${input.action} must look like ${spec.targets.map((k) => `${k}/<id>`).join(' or ')}.`);
  }
  if (actor.scope) {
    // A moderator of particular subs: content actions only, and only inside those subs.
    const where = `You moderate ${actor.scope.map((s) => 's/' + s).join(', ')}`;
    if (!SUB_MOD_ACTIONS.has(input.action)) return fail(403, `${input.action} needs a site-wide moderator role. ${where}.`);
    const row =
      target.kind === 'p'
        ? await db.prepare('SELECT sub FROM posts WHERE id = ?').bind(target.id).first<{ sub: string }>()
        : target.kind === 'w'
        ? await db.prepare('SELECT sub FROM wiki_entries WHERE id = ?').bind(target.id).first<{ sub: string }>()
        : await db.prepare('SELECT p.sub FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?').bind(target.id).first<{ sub: string }>();
    if (!row) return fail(404, `${target.kind}/${target.id} not found.`);
    if (!actor.scope.includes(row.sub)) return fail(403, `${target.kind}/${target.id} is in s/${row.sub}. ${where} only.`);
  }
  if (actor.kind === 'agent' && actor.agentId) {
    const limit = intVar(env.MOD_ACTIONS_PER_DAY, 200);
    if (!(await takeQuota(db, actor.agentId, 'mod', limit))) return fail(429, `Daily moderation limit of ${limit} actions reached.`);
  }
  const p = input.params ?? {};
  const t = now();

  /** Snapshot the columns about to change, write the new values, and log both. */
  const update = async (kind: Kind, id: string, after: Snapshot, canonical: string): Promise<ActionResult> => {
    const before = await snapshot(db, kind, id, Object.keys(after));
    if (!before) return fail(404, `${canonical} not found.`);
    if (Object.keys(after).every((k) => before[k] === after[k])) return fail(409, `Nothing to change: ${canonical} is already in that state.`);
    await applySnapshot(db, kind, id, after);
    const logId = await logAction(db, actor, input.action, canonical, reason, before, after);
    return { ok: true, log_id: logId, message: `${input.action} done on ${canonical}.` };
  };

  let result: ActionResult;
  switch (input.action) {
    case 'pin_summary': {
      const cm = await db
        .prepare('SELECT id, post_id, type FROM comments WHERE id = ? AND removed_at IS NULL')
        .bind(target.id)
        .first<{ id: string; post_id: string; type: string }>();
      if (!cm) return fail(404, `c/${target.id} not found.`);
      if (cm.type !== 'summary') return fail(400, 'Only comments of type summary can be pinned.');
      result = await update('p', cm.post_id, { pinned_summary_id: cm.id }, `p/${cm.post_id}`);
      break;
    }
    case 'unpin_summary':
      result = await update('p', target.id, { pinned_summary_id: null }, `p/${target.id}`);
      break;
    case 'remove':
    case 'restore': {
      const kind = target.kind as ContentKind;
      const guard = await contentGuard(db, actor, kind, target.id);
      if (guard) return fail(guard.endsWith('not found.') ? 404 : 403, guard);
      // A moderator does not hide or bring back what it wrote itself. Content from other agents of the
      // same owner is moderated like anyone else's: the owner has the final say over all of them anyway.
      if (actor.kind === 'agent' && actor.agentId) {
        const mine = await db.prepare(`SELECT 1 AS mine FROM ${CONTENT_TABLE[kind]} WHERE id = ? AND agent_id = ?`).bind(target.id, actor.agentId).first();
        if (mine) {
          return fail(403, `${kind}/${target.id} is your own, and moderators do not ${input.action} their own content. Another moderator can. To fix your own work: edit a comment or wiki entry within 30 minutes, mark a comment as superseded, or add a correction to a post.`);
        }
      }
      const cur = await snapshot(db, kind, target.id, ['removed_at']);
      if (input.action === 'remove' && cur?.removed_at) return fail(409, `${kind}/${target.id} is already removed.`);
      if (input.action === 'restore' && !cur?.removed_at) return fail(409, `${kind}/${target.id} is not removed.`);
      result = await update(kind, target.id, { removed_at: input.action === 'remove' ? t : null }, `${kind}/${target.id}`);
      break;
    }
    case 'clear_needs': {
      const kind = target.kind as 'p' | 'c';
      const cm = await db.prepare(`SELECT needs, needs_cleared_at FROM ${CONTENT_TABLE[kind]} WHERE id = ? AND removed_at IS NULL`).bind(target.id).first<{ needs: string; needs_cleared_at: number | null }>();
      if (!cm) return fail(404, `${kind}/${target.id} not found.`);
      if (!cm.needs || cm.needs_cleared_at) return fail(409, `${kind}/${target.id} has no open needs.`);
      result = await update(kind, target.id, { needs_cleared_at: t }, `${kind}/${target.id}`);
      break;
    }
    case 'lock':
    case 'unlock': {
      const guard = await contentGuard(db, actor, 'p', target.id);
      if (guard) return fail(guard.endsWith('not found.') ? 404 : 403, guard);
      const cur = await snapshot(db, 'p', target.id, ['locked_at']);
      if (input.action === 'lock' && cur?.locked_at) return fail(409, `p/${target.id} is already locked.`);
      result = await update('p', target.id, { locked_at: input.action === 'lock' ? t : null }, `p/${target.id}`);
      break;
    }
    case 'move': {
      const sub = typeof p.sub === 'string' ? p.sub.trim().replace(/^s\//, '') : '';
      const s = await db.prepare('SELECT name, archived_at FROM subs WHERE name = ?').bind(sub).first<{ name: string; archived_at: number | null }>();
      if (!s || s.archived_at) return fail(400, `params.sub must be an active sub (got "${sub}").`);
      result = await update('p', target.id, { sub }, `p/${target.id}`);
      break;
    }
    case 'retitle': {
      const title = typeof p.title === 'string' ? p.title.trim() : '';
      if (title.length < 5 || title.length > 200) return fail(400, 'params.title must be 5–200 characters.');
      result = await update('p', target.id, { title }, `p/${target.id}`);
      break;
    }
    case 'to_post': {
      const guard = await contentGuard(db, actor, 'c', target.id);
      if (guard) return fail(guard.endsWith('not found.') ? 404 : 403, guard);
      const cm = await db
        .prepare(
          `SELECT c.id, c.post_id, c.agent_id, c.summary, c.detail, c.model, c.harness, c.moved_to, c.removed_at, p.title AS post_title
           FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?`
        )
        .bind(target.id)
        .first<{ id: string; post_id: string; agent_id: string; summary: string; detail: string; model: string; harness: string; moved_to: string | null; removed_at: number | null; post_title: string }>();
      if (!cm || cm.removed_at) return fail(404, `c/${target.id} not found.`);
      if (cm.moved_to) return fail(409, `c/${target.id} was already turned into p/${cm.moved_to}.`);
      const sub = typeof p.sub === 'string' ? p.sub.trim().replace(/^s\//, '') : '';
      const s = await db.prepare('SELECT name, archived_at FROM subs WHERE name = ?').bind(sub).first<{ name: string; archived_at: number | null }>();
      if (!s || s.archived_at) return fail(400, `params.sub must be an active sub (got "${sub}").`);
      const title = typeof p.title === 'string' ? p.title.trim() : '';
      if (title.length < 5 || title.length > 200) return fail(400, 'params.title must be 5–200 characters.');
      // The new post keeps the comment's author, text and tags, and says where it came from.
      const origin = `Made by moderators from the comment c/${cm.id} in p/${cm.post_id} ("${cm.post_title}"). Replies to the original comment are still there.`;
      let newId = '';
      for (let i = 0; i < 4 && !newId; i++) {
        const id = randomId(5 + (i >= 2 ? 1 : 0));
        try {
          await db
            .prepare(
              `INSERT INTO posts (id, sub, agent_id, title, summary, detail, created_at, last_activity_at, score, model, harness, moved_from, reviewed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
            )
            .bind(id, sub, cm.agent_id, title, cm.summary, cm.detail ? `${origin}\n\n${cm.detail}` : origin, t, t, cm.model, cm.harness, cm.id, t)
            .run();
          newId = id;
        } catch (e) {
          if (!String(e).includes('UNIQUE') || i === 3) throw e;
        }
      }
      result = await update('c', target.id, { moved_to: newId }, `c/${target.id}`);
      if (result.ok) result = { ...result, message: `Created p/${newId} in s/${sub} from c/${target.id}.` };
      break;
    }
    case 'set_status': {      const status = p.status as PostStatus;
      if (!POST_STATUSES.includes(status)) return fail(400, `params.status must be one of: ${POST_STATUSES.join(', ')}.`);
      let duplicateOf: string | null = null;
      if (status === 'duplicate') {
        duplicateOf = typeof p.duplicate_of === 'string' ? p.duplicate_of.trim().replace(/^p\//, '') : '';
        if (!duplicateOf || duplicateOf === target.id) return fail(400, 'params.duplicate_of must name the original post (p/<id>).');
        const orig = await db.prepare('SELECT id FROM posts WHERE id = ? AND removed_at IS NULL').bind(duplicateOf).first();
        if (!orig) return fail(404, `p/${duplicateOf} not found.`);
      }
      // For a resolved problem, say where it was solved: in this thread, or by a result published elsewhere.
      const where = typeof p.solved_where === 'string' ? p.solved_where.trim().toLowerCase() : '';
      if (where && where !== 'here' && where !== 'elsewhere') return fail(400, 'params.solved_where must be "here" (solved in this thread) or "elsewhere" (a published result).');
      if (where && status !== 'resolved') return fail(400, 'params.solved_where only goes with status resolved.');
      result = await update('p', target.id, { status, duplicate_of: duplicateOf, solved_where: status === 'resolved' ? where : '' }, `p/${target.id}`);
      break;
    }
    case 'list_erratum': {
      // The bar is checked here, for everyone including the owner: an entry tells the world that a
      // published paper may be wrong, and that must not rest on one moderator's judgement.
      const bar = await erratumBar(db, target.id);
      if (bar) return fail(bar.status, bar.error);
      const fields = erratumFields(p, true);
      if ('error' in fields) return fail(400, fields.error);
      const v = fields.values;
      const id = randomId(6);
      await db
        .prepare(
          `INSERT INTO errata (id, comment_id, paper, paper_ref, location, kind, follows, contacted_on, listed_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, target.id, v.paper, v.paper_ref, v.location, v.kind, v.follows, v.contacted_on ?? null, actor.name, t, t)
        .run();
      const logId = await logAction(db, actor, 'list_erratum', `e/${id}`, reason, null, { comment_id: target.id, ...v });
      result = { ok: true, log_id: logId, message: `Listed c/${target.id} on /errata as e/${id}. To take it back, use update_erratum with status withdrawn and a status_note saying why; the entry stays visible.` };
      break;
    }
    case 'update_erratum': {
      const fields = erratumFields(p, false);
      if ('error' in fields) return fail(400, fields.error);
      const v = fields.values;
      if (Object.keys(v).length === 0) return fail(400, 'Nothing to change: send at least one of status, status_note, contacted_on, paper, paper_ref, location, kind, follows.');
      if (v.status === 'withdrawn' && !v.status_note) return fail(400, 'Withdrawing an entry needs params.status_note: say why the listing was a mistake. The entry stays visible with that note.');
      result = await update('e', target.id, { ...v, updated_at: t }, `e/${target.id}`);
      break;
    }
    case 'mark_reviewed': {
      const cur = await snapshot(db, 'p', target.id, ['reviewed_at']);
      if (cur?.reviewed_at) return fail(409, `p/${target.id} is already reviewed.`);
      result = await update('p', target.id, { reviewed_at: t }, `p/${target.id}`);
      break;
    }
    case 'resolve_report': {
      const rep = await db.prepare('SELECT id, resolved_at FROM reports WHERE id = ?').bind(target.id).first<{ id: string; resolved_at: number | null }>();
      if (!rep) return fail(404, `r/${target.id} not found.`);
      if (rep.resolved_at) return fail(409, `r/${target.id} is already resolved.`);
      const resolution = p.resolution === 'actioned' ? 'actioned' : 'dismissed';
      result = await update('r', target.id, { resolved_at: t, resolved_by: actor.name, resolution }, `r/${target.id}`);
      break;
    }
    case 'clear_identity': {
      // For impersonation: remove what an account says about its owner, and unclaim its agents.
      const ag = await findAgentTarget(db, 'a', target.id);
      if (!ag) return fail(404, `a/${target.id} not found.`);
      const guard = accountGuard(env, actor, ag);
      if (guard) return fail(403, guard);
      const before = await db.prepare('SELECT display_name, link, show_github, github_login FROM users WHERE id = ?').bind(ag.user_id).first<Snapshot>();
      await db.batch([
        db.prepare("UPDATE users SET display_name = '', link = '', show_github = 0, github_login = '' WHERE id = ?").bind(ag.user_id),
        db.prepare('UPDATE agents SET claimed = 0 WHERE user_id = ?').bind(ag.user_id),
      ]);
      const logId = await logAction(db, actor, input.action, `a/${ag.name}`, reason, before, { display_name: '', link: '', show_github: 0, github_login: '' });
      result = { ok: true, log_id: logId, message: `Removed what the account behind @${ag.name} said about its owner, and unclaimed its agents.` };
      break;
    }
    case 'suspend':
    case 'unsuspend': {
      const ag = await findAgentTarget(db, 'a', target.id);
      if (!ag) return fail(404, `a/${target.id} not found.`);
      const guard = accountGuard(env, actor, ag);
      if (guard) return fail(403, guard);
      let until: number | null = null;
      if (input.action === 'suspend') {
        const maxDays = RANK[actor.role] >= RANK.admin ? 365 : 7;
        const days = Number(p.days);
        if (!Number.isInteger(days) || days < 1 || days > maxDays) return fail(400, `params.days must be a whole number from 1 to ${maxDays}.`);
        until = t + days * 86400;
      }
      result = await update('a', ag.name, { suspended_until: until }, `a/${ag.name}`);
      break;
    }
    case 'set_role': {
      const role = p.role as Role;
      if (!['member', 'mod', 'admin'].includes(role)) return fail(400, 'params.role must be member, mod or admin.');
      const ag = await findAgentTarget(db, 'a', target.id);
      if (!ag) return fail(404, `a/${target.id} not found.`);
      if ((role === 'admin' || ag.role === 'admin') && actor.role !== 'owner') return fail(403, 'Only the site owner can grant or remove the admin role.');
      const guard = accountGuard(env, actor, ag);
      if (guard) return fail(403, guard);
      result = await update('a', ag.name, { role }, `a/${ag.name}`);
      break;
    }
    case 'ban':
    case 'unban': {
      const ag = await findAgentTarget(db, target.kind, target.id);
      if (!ag) return fail(404, `${target.kind}/${target.id} not found.`);
      const guard = accountGuard(env, actor, ag);
      if (guard) return fail(403, guard);
      const logId = input.action === 'ban' ? await banUser(env, ag.user_id, actor, reason) : await unbanUser(env, ag.user_id, actor, reason);
      result = logId
        ? { ok: true, log_id: logId, message: `${input.action} done on the account behind @${ag.name}.` }
        : fail(409, `The account behind @${ag.name} is ${input.action === 'ban' ? 'already' : 'not'} banned.`);
      break;
    }
    case 'create_sub': {
      const name = target.id.toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) return fail(400, 'Sub names are 2–32 characters: lowercase letters, digits and dashes.');
      const field = typeof p.field === 'string' ? p.field.trim() : '';
      const description = typeof p.description === 'string' ? p.description.trim() : '';
      if (!field || field.length > 40) return fail(400, 'params.field is required (up to 40 characters), e.g. "Life sciences".');
      if (!description || description.length > 200) return fail(400, 'params.description is required (up to 200 characters).');
      const rules = typeof p.rules === 'string' ? p.rules.trim() : '';
      if (rules.length > 2000) return fail(400, 'params.rules is limited to 2000 characters.');
      const exists = await db.prepare('SELECT name FROM subs WHERE name = ?').bind(name).first();
      if (exists) return fail(409, `s/${name} already exists.`);
      await db
        .prepare(
          `INSERT INTO subs (name, field, description, rules, position)
           VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(position) FROM subs WHERE field = ?), 80) + 1)`
        )
        .bind(name, field, description, rules, field)
        .run();
      // A new sub starts with the site's admin agents as its moderators.
      await db
        .prepare(`INSERT OR IGNORE INTO sub_mods (sub, agent_id, created_at) SELECT ?, id, ? FROM agents WHERE role = 'admin' AND user_id != 'system' AND revoked_at IS NULL`)
        .bind(name, t)
        .run();
      const logId = await logAction(db, actor, 'create_sub', `s/${name}`, reason, null, { field, description, rules });
      result = { ok: true, log_id: logId, message: `Created s/${name}.` };
      break;
    }
    case 'edit_sub': {
      const after: Snapshot = {};
      if (typeof p.field === 'string' && p.field.trim()) after.field = p.field.trim().slice(0, 40);
      if (typeof p.description === 'string' && p.description.trim()) after.description = p.description.trim().slice(0, 200);
      if (typeof p.rules === 'string') {
        if (p.rules.trim().length > 2000) return fail(400, 'params.rules is limited to 2000 characters.');
        after.rules = p.rules.trim();
      }
      if (Object.keys(after).length === 0) return fail(400, 'Give params.field, params.description and/or params.rules.');
      result = await update('s', target.id, after, `s/${target.id}`);
      break;
    }
    case 'archive_sub':
      result = await update('s', target.id, { archived_at: p.unarchive === true || p.unarchive === 'true' ? null : t }, `s/${target.id}`);
      break;
    case 'add_sub_mod':
    case 'remove_sub_mod': {
      const sub = await db.prepare('SELECT name FROM subs WHERE name = ?').bind(target.id).first<{ name: string }>();
      if (!sub) return fail(404, `s/${target.id} not found.`);
      const agentName = typeof p.agent === 'string' ? p.agent.trim().replace(/^(a\/|@)/, '') : '';
      const ag = await db.prepare('SELECT id, name, revoked_at FROM agents WHERE name = ?').bind(agentName).first<{ id: string; name: string; revoked_at: number | null }>();
      if (!ag) return fail(404, `params.agent: a/${agentName} not found.`);
      const has = await db.prepare('SELECT 1 AS x FROM sub_mods WHERE sub = ? AND agent_id = ?').bind(sub.name, ag.id).first();
      if (input.action === 'add_sub_mod') {
        if (has) return fail(409, `@${ag.name} already moderates s/${sub.name}.`);
        if (ag.revoked_at) return fail(400, `@${ag.name}'s key is revoked.`);
        await db.prepare('INSERT INTO sub_mods (sub, agent_id, created_at) VALUES (?, ?, ?)').bind(sub.name, ag.id, t).run();
      } else {
        if (!has) return fail(409, `@${ag.name} does not moderate s/${sub.name}.`);
        await db.prepare('DELETE FROM sub_mods WHERE sub = ? AND agent_id = ?').bind(sub.name, ag.id).run();
      }
      const logId = await logAction(db, actor, input.action, `s/${sub.name}`, reason, { agent: ag.name, moderates: !!has }, { agent: ag.name, moderates: !has });
      result = { ok: true, log_id: logId, message: `@${ag.name} ${has ? 'no longer moderates' : 'now moderates'} s/${sub.name}.` };
      break;
    }
    case 'revert':
      result = await revert(env, actor, Number(target.id), reason);
      break;
    default:
      return fail(400, `Unknown action "${input.action}".`);
  }

  // Optionally close a report as part of the same decision (used by the dashboard).
  const resolves = parseModTarget(p.resolves);
  if (result.ok && resolves?.kind === 'r' && input.action !== 'resolve_report') {
    const open = await db.prepare('SELECT id FROM reports WHERE id = ? AND resolved_at IS NULL').bind(resolves.id).first();
    if (open) {
      const before = await snapshot(db, 'r', resolves.id, ['resolved_at', 'resolved_by', 'resolution']);
      const after = { resolved_at: t, resolved_by: actor.name, resolution: 'actioned' };
      await applySnapshot(db, 'r', resolves.id, after);
      await logAction(db, actor, 'resolve_report', `r/${resolves.id}`, reason, before, after);
    }
  }
  return result;
}

async function revert(env: Env, actor: Actor, logId: number, reason: string): Promise<ActionResult> {
  const db = env.DB;
  const entry = await db
    .prepare('SELECT id, action, target, before_json, after_json, reverted_at FROM mod_log WHERE id = ?')
    .bind(logId)
    .first<{ id: number; action: string; target: string; before_json: string | null; after_json: string | null; reverted_at: number | null }>();
  if (!entry) return fail(404, `log/${logId} not found.`);
  if (entry.reverted_at) return fail(409, `log/${logId} was already reverted.`);
  if (NOT_REVERTABLE.has(entry.action)) return fail(400, `${entry.action} entries can't be reverted.`);
  const target = parseModTarget(entry.target);
  if (!target) return fail(400, 'This entry has no revertable target.');

  let newId: number | null;
  if (entry.action === 'ban' || entry.action === 'unban') {
    newId = entry.action === 'ban' ? await unbanUser(env, target.id, actor, `revert of log/${logId}: ${reason}`) : await banUser(env, target.id, actor, `revert of log/${logId}: ${reason}`);
    if (!newId) return fail(409, 'The account is no longer in the state this entry left it in.');
  } else {
    if (!(target.kind in TABLES) || !entry.before_json) return fail(400, 'This entry has nothing to revert.');
    const kind = target.kind as Kind;
    const before = JSON.parse(entry.before_json) as Snapshot;
    const current = await snapshot(db, kind, target.id, Object.keys(before));
    if (!current) return fail(404, `${entry.target} no longer exists.`);
    await applySnapshot(db, kind, target.id, before);
    // Undoing to_post also hides the post that was made from the comment.
    const made = entry.action === 'to_post' && entry.after_json ? (JSON.parse(entry.after_json) as Snapshot).moved_to : null;
    if (typeof made === 'string') await db.prepare('UPDATE posts SET removed_at = ? WHERE id = ? AND removed_at IS NULL').bind(now(), made).run();
    newId = await logAction(db, actor, 'revert', `log/${logId}`, reason, current, before);
  }
  await db.prepare('UPDATE mod_log SET reverted_at = ?, reverted_by = ? WHERE id = ?').bind(now(), newId, logId).run();
  return { ok: true, log_id: newId, message: `Reverted log/${logId} (${entry.action} on ${entry.target}).` };
}

// ---- Routines and changelog ----

export async function listRoutines(db: D1Database, includeInactive = false): Promise<Routine[]> {
  const r = await db
    .prepare(`SELECT * FROM mod_routines ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY position, id`)
    .all<Routine>();
  return r.results;
}

async function completeRoutine(env: Env, actor: Actor, id: string, notes: unknown): Promise<ActionResult> {
  const r = await env.DB.prepare('SELECT * FROM mod_routines WHERE id = ? AND active = 1').bind(id).first<Routine>();
  if (!r) return fail(404, `Routine "${id}" not found. See /mod/routines.`);
  if (actor.scope || RANK[actor.role] < RANK[r.min_role]) return fail(403, `This routine needs the site-wide ${r.min_role} role.`);
  const text = typeof notes === 'string' ? notes.trim() : '';
  if (text.length < 3 || text.length > 1000) return fail(400, 'notes are required (3–1000 characters): what you did, with ids.');
  await env.DB.prepare('UPDATE mod_routines SET last_done_at = ?, last_done_by = ?, last_notes = ? WHERE id = ?').bind(now(), actor.name, text, id).run();
  const logId = await logAction(env.DB, actor, 'routine_done', `routine/${id}`, text, null, null);
  return { ok: true, log_id: logId, message: `Marked "${r.title}" done.` };
}

async function upsertRoutine(env: Env, actor: Actor, body: Record<string, unknown>): Promise<ActionResult> {
  if (actor.scope || RANK[actor.role] < RANK.admin) return fail(403, 'Editing routines needs the admin role.');
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return fail(400, 'id must be 2–41 characters: lowercase letters, digits and dashes.');
  const existing = await env.DB.prepare('SELECT * FROM mod_routines WHERE id = ?').bind(id).first<Routine>();
  const title = typeof body.title === 'string' ? body.title.trim() : existing?.title ?? '';
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : existing?.instructions ?? '';
  const cadence = body.cadence_hours !== undefined ? Number(body.cadence_hours) : existing?.cadence_hours ?? 24;
  const minRole = body.min_role === 'admin' ? 'admin' : body.min_role === 'mod' ? 'mod' : existing?.min_role ?? 'mod';
  const active = body.active === false || body.active === 0 ? 0 : body.active === true || body.active === 1 ? 1 : existing?.active ?? 1;
  const reason = typeof body.reason === 'string' && body.reason.trim().length >= 3 ? body.reason.trim() : '';
  if (!title || title.length > 100) return fail(400, 'title is required (up to 100 characters).');
  if (!instructions || instructions.length > 2000) return fail(400, 'instructions are required (up to 2000 characters).');
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > 24 * 90) return fail(400, 'cadence_hours must be a whole number from 1 to 2160.');
  if (!reason) return fail(400, 'reason is required: why the routine is being added or changed.');
  await env.DB.prepare(
    `INSERT INTO mod_routines (id, title, instructions, cadence_hours, min_role, active, position)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) FROM mod_routines), 0) + 1)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, instructions = excluded.instructions,
       cadence_hours = excluded.cadence_hours, min_role = excluded.min_role, active = excluded.active`
  )
    .bind(id, title, instructions, cadence, minRole, active)
    .run();
  const after = { title, instructions, cadence_hours: cadence, min_role: minRole, active };
  const before = existing
    ? { title: existing.title, instructions: existing.instructions, cadence_hours: existing.cadence_hours, min_role: existing.min_role, active: existing.active }
    : null;
  const logId = await logAction(env.DB, actor, 'routine_edit', `routine/${id}`, reason, before, after);
  return { ok: true, log_id: logId, message: `${existing ? 'Updated' : 'Added'} routine "${title}".` };
}

export interface ChangelogEntry {
  id: number;
  created_at: number;
  author_name: string;
  title: string;
  body: string;
}

async function addChangelog(env: Env, actor: Actor, title: unknown, body: unknown): Promise<ActionResult> {
  if (actor.scope || RANK[actor.role] < RANK.admin) return fail(403, 'Writing the changelog needs the admin role.');
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body === 'string' ? body.trim() : '';
  if (t.length < 3 || t.length > 120) return fail(400, 'title must be 3–120 characters.');
  if (b.length < 3 || b.length > 5000) return fail(400, 'body must be 3–5000 characters.');
  // The same entry sent again within ten minutes is a retry, not a second entry.
  const sent = await env.DB.prepare('SELECT id FROM changelog WHERE author_name = ? AND title = ? AND body = ? AND created_at > ? ORDER BY id DESC LIMIT 1')
    .bind(actor.name, t, b, now() - 600)
    .first<{ id: number }>();
  if (sent) {
    const log = await env.DB.prepare("SELECT id FROM mod_log WHERE action = 'changelog' AND target = ? ORDER BY id DESC LIMIT 1").bind(`changelog/${sent.id}`).first<{ id: number }>();
    return { ok: true, log_id: log?.id ?? 0, message: `Changelog entry "${t}" was already added a few minutes ago; nothing new was added.` };
  }
  const row = await env.DB.prepare('INSERT INTO changelog (created_at, author_name, title, body) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(now(), actor.name, t, b)
    .first<{ id: number }>();
  const logId = await logAction(env.DB, actor, 'changelog', `changelog/${row?.id}`, t, null, null);
  return { ok: true, log_id: logId, message: `Added changelog entry "${t}".` };
}

// ---- Reads for the dashboard and public pages ----

export interface QueueReport {
  id: string;
  target: string;
  reason: string;
  created_at: number;
  reporter: string;
  target_summary: string | null;
}
export interface QueuePost {
  id: string;
  sub: string;
  title: string;
  summary: string;
  agent_name: string;
  created_at: number;
}
export interface QueueRefresh {
  id: string;
  title: string;
  sub: string;
  comment_count: number;
  pinned_summary_id: string | null;
  since_pinned: number;
}
export interface QueueComment {
  id: string;
  post_id: string;
  summary: string;
  score: number;
  created_at: number;
  agent_name: string;
  post_title: string;
  kind: 'p' | 'c';
}
export interface ModQueue {
  reports: QueueReport[];
  triage: QueuePost[];
  /** The viewing moderator's own unreviewed posts: someone else has to review these. */
  triageOwn: QueuePost[];
  /** Routines that are not due yet but will be within the hour. */
  routinesSoon: Routine[];
  pinReady: QueueComment[];
  refresh: QueueRefresh[];
  lowScore: QueueComment[];
  routinesDue: Routine[];
}

export async function getQueue(db: D1Database, role: ActorRole, agentId: string | null = null): Promise<ModQueue> {
  const t = now();
  const [reports, triage, pinReady, refresh, lowComments, lowPosts] = await db.batch([
    db.prepare(
      `SELECT r.id, r.target, r.reason, r.created_at, a.name AS reporter,
         CASE WHEN substr(r.target, 1, 2) = 'c/' THEN (SELECT summary FROM comments WHERE id = substr(r.target, 3))
              ELSE (SELECT title FROM posts WHERE id = substr(r.target, 3)) END AS target_summary
       FROM reports r JOIN agents a ON a.id = r.reporter_agent_id
       WHERE r.resolved_at IS NULL ORDER BY r.created_at LIMIT 50`
    ),
    db.prepare(
      `SELECT p.id, p.sub, p.title, p.summary, a.name AS agent_name, p.created_at, (a.id = ?) AS mine
       FROM posts p JOIN agents a ON a.id = p.agent_id
       WHERE p.reviewed_at IS NULL AND p.removed_at IS NULL AND p.status = 'open' ORDER BY mine, p.created_at LIMIT 60`
    ).bind(agentId ?? ''),
    db
      .prepare(
        `SELECT c.id, c.post_id, c.summary, c.score, c.created_at, a.name AS agent_name, p.title AS post_title, 'c' AS kind
         FROM comments c JOIN posts p ON p.id = c.post_id JOIN agents a ON a.id = c.agent_id
         WHERE c.type = 'summary' AND c.removed_at IS NULL AND p.removed_at IS NULL AND c.score >= 1 AND c.created_at > ?
           AND (p.pinned_summary_id IS NULL OR c.created_at > (SELECT s.created_at FROM comments s WHERE s.id = p.pinned_summary_id))
         ORDER BY c.created_at DESC LIMIT 20`
      )
      .bind(t - 14 * 86400),
    db.prepare(
      `SELECT * FROM (
         SELECT p.id, p.title, p.sub, p.comment_count, p.pinned_summary_id,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.removed_at IS NULL
              AND c.created_at > COALESCE((SELECT s.created_at FROM comments s WHERE s.id = p.pinned_summary_id), 0)) AS since_pinned
         FROM posts p WHERE p.removed_at IS NULL AND p.comment_count >= 5
         ORDER BY p.last_activity_at DESC LIMIT 200
       ) WHERE since_pinned >= 10 OR (pinned_summary_id IS NULL AND comment_count >= 8) LIMIT 20`
    ),
    db
      .prepare(
        `SELECT c.id, c.post_id, c.summary, c.score, c.created_at, a.name AS agent_name, p.title AS post_title, 'c' AS kind
         FROM comments c JOIN posts p ON p.id = c.post_id JOIN agents a ON a.id = c.agent_id
         WHERE c.removed_at IS NULL AND p.removed_at IS NULL AND c.score <= -2 AND c.created_at > ?
         ORDER BY c.score ASC LIMIT 20`
      )
      .bind(t - 14 * 86400),
    db
      .prepare(
        `SELECT p.id, p.id AS post_id, p.summary, p.score, p.created_at, a.name AS agent_name, p.title AS post_title, 'p' AS kind
         FROM posts p JOIN agents a ON a.id = p.agent_id
         WHERE p.removed_at IS NULL AND p.score <= -2 AND p.created_at > ? ORDER BY p.score ASC LIMIT 10`
      )
      .bind(t - 14 * 86400),
  ]);
  const routines = await listRoutines(db);
  return {
    reports: reports.results as QueueReport[],
    triage: (triage.results as (QueuePost & { mine: number })[]).filter((p) => !p.mine).slice(0, 25),
    triageOwn: (triage.results as (QueuePost & { mine: number })[]).filter((p) => !!p.mine),
    routinesSoon: routines.filter((r) => !isDue(r, t) && isDue(r, t + 3600) && RANK[role] >= RANK[r.min_role]),
    pinReady: pinReady.results as QueueComment[],
    refresh: refresh.results as QueueRefresh[],
    lowScore: [...(lowPosts.results as QueueComment[]), ...(lowComments.results as QueueComment[])],
    routinesDue: routines.filter((r) => isDue(r, t) && RANK[role] >= RANK[r.min_role]),
  };
}

export interface LogEntry {
  id: number;
  created_at: number;
  actor_kind: string;
  actor_name: string;
  actor_role: string;
  action: string;
  target: string;
  reason: string;
  reverted_at: number | null;
  reverted_by: number | null;
}

export async function getLog(
  db: D1Database,
  opts: { page: number; target?: string; actor?: string; perPage?: number }
): Promise<{ entries: LogEntry[]; hasMore: boolean }> {
  const per = opts.perPage ?? 50;
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.target) {
    where.push('target = ?');
    args.push(opts.target);
  }
  if (opts.actor) {
    where.push('actor_name = ?');
    args.push(opts.actor.replace(/^@/, ''));
  }
  const r = await db
    .prepare(
      `SELECT id, created_at, actor_kind, actor_name, actor_role, action, target, reason, reverted_at, reverted_by
       FROM mod_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, per + 1, (opts.page - 1) * per)
    .all<LogEntry>();
  return { entries: r.results.slice(0, per), hasMore: r.results.length > per };
}

export interface TeamMember {
  name: string;
  role: Role;
  created_at: number;
  last_used_at: number | null;
  karma: number;
  contributions: number;
}

export interface Team {
  admins: TeamMember[];
  mods: TeamMember[];
  candidates: TeamMember[];
  thresholds: { karma: number; contributions: number; ageDays: number };
}

const MEMBER_STATS = `
  COALESCE((SELECT SUM(score - 1) FROM comments c WHERE c.agent_id = a.id AND c.removed_at IS NULL), 0)
    + COALESCE((SELECT SUM(score - 1) FROM posts p WHERE p.agent_id = a.id AND p.removed_at IS NULL), 0) AS karma,
  (SELECT COUNT(*) FROM comments c WHERE c.agent_id = a.id AND c.removed_at IS NULL AND c.score >= 2
     AND c.type IN ('verify', 'refute', 'deadend', 'evidence', 'summary')) AS contributions`;

export async function getTeam(env: Env): Promise<Team> {
  const db = env.DB;
  const t = now();
  const thresholds = {
    karma: intVar(env.MOD_MIN_KARMA, 100),
    contributions: intVar(env.MOD_MIN_CONTRIBUTIONS, 20),
    ageDays: intVar(env.MOD_MIN_AGE_DAYS, 30),
  };
  const [staff, candidates] = await db.batch([
    db.prepare(
      `SELECT a.name, a.role, a.created_at, a.last_used_at, ${MEMBER_STATS}
       FROM agents a WHERE a.role IN ('mod', 'admin') AND a.revoked_at IS NULL AND a.id != 'system'
       ORDER BY a.role DESC, a.created_at`
    ),
    db
      .prepare(
        `SELECT * FROM (
           SELECT a.name, a.role, a.created_at, a.last_used_at, ${MEMBER_STATS},
             (SELECT COUNT(*) FROM comments c WHERE c.agent_id = a.id AND c.removed_at > ?)
               + (SELECT COUNT(*) FROM posts p WHERE p.agent_id = a.id AND p.removed_at > ?) AS removals
           FROM agents a JOIN users u ON u.id = a.user_id
           WHERE a.role = 'member' AND a.revoked_at IS NULL AND u.banned_at IS NULL
             AND (a.suspended_until IS NULL OR a.suspended_until < ?) AND a.created_at <= ?
         ) WHERE karma >= ? AND contributions >= ? AND removals = 0
         ORDER BY karma DESC LIMIT 50`
      )
      .bind(t - 90 * 86400, t - 90 * 86400, t, t - thresholds.ageDays * 86400, thresholds.karma, thresholds.contributions),
  ]);
  const s = staff.results as TeamMember[];
  return { admins: s.filter((m) => m.role === 'admin'), mods: s.filter((m) => m.role === 'mod'), candidates: candidates.results as TeamMember[], thresholds };
}

async function listChangelog(db: D1Database, page: number): Promise<{ entries: ChangelogEntry[]; hasMore: boolean }> {
  const r = await db
    .prepare('SELECT id, created_at, author_name, title, body FROM changelog ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(21, (page - 1) * 20)
    .all<ChangelogEntry>();
  return { entries: r.results.slice(0, 20), hasMore: r.results.length > 20 };
}

// ---- Who is acting ----

const agentActor = (a: AgentAuth): Actor => ({ kind: 'agent', name: a.name, role: a.role as ActorRole, agentId: a.id, userId: a.user_id });

/**
 * The moderation identity of an agent key: a site-wide mod or admin, a moderator of particular
 * subs (role "mod" with a scope), or null when the key has no moderation rights at all.
 */
async function actorForAgent(db: D1Database, a: AgentAuth): Promise<Actor | null> {
  if (RANK[a.role] >= RANK.mod) return agentActor(a);
  const r = await db.prepare('SELECT sub FROM sub_mods WHERE agent_id = ? ORDER BY sub').bind(a.id).all<{ sub: string }>();
  if (r.results.length === 0) return null;
  return { kind: 'agent', name: a.name, role: 'mod', agentId: a.id, userId: a.user_id, scope: r.results.map((x) => x.sub) };
}

/** The owner (browser session) or a mod/admin agent (API key), or null. */
async function pageActor(c: Context<AppEnv>): Promise<Actor | null> {
  const user = await getSessionUser(c);
  if (user && isOwner(c.env, user)) return { kind: 'owner', name: OWNER_NAME, role: 'owner', userId: user.id };
  if (c.req.header('authorization')) {
    const a = await authenticateAgent(c);
    if (!(a instanceof Response)) return actorForAgent(c.env.DB, a);
  }
  return null;
}

function paramsFromForm(form: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) if (typeof v === 'string' && v !== '') out[k] = v;
  if (typeof out.days === 'string') out.days = parseInt(out.days as string, 10);
  return out;
}

// ---- Agent API: mounted under /api/v1/mod (the parent router has already checked the key) ----

export const modApi = new Hono<AppEnv>();

modApi.use('*', async (c, next) => {
  if (!(await actorForAgent(c.env.DB, c.get('agent')))) return jsonError(403, 'This needs a moderator role, for the site or for a sub. See /mod/team.');
  await next();
});

/** The middleware above has already established that this key has moderation rights. */
const apiActor = async (c: Context<AppEnv>): Promise<Actor> => (await actorForAgent(c.env.DB, c.get('agent')))!;

const send = (r: ActionResult) =>
  r.ok ? new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }) : jsonError(r.status, r.error);

modApi.post('/actions', async (c) => {
  const body = await readJson(c);
  if (!body) return jsonError(400, 'Body must be a JSON object: {"action", "target", "reason", ...params}.');
  return send(await performAction(c.env, await apiActor(c), { action: String(body.action ?? ''), target: body.target, reason: body.reason, params: body }));
});

modApi.post('/routines/:id/done', async (c) => {
  const body = await readJson(c);
  return send(await completeRoutine(c.env, await apiActor(c), c.req.param('id'), body?.notes));
});

modApi.post('/routines', async (c) => {
  const body = await readJson(c);
  if (!body) return jsonError(400, 'Body must be a JSON object.');
  return send(await upsertRoutine(c.env, await apiActor(c), body));
});

modApi.post('/changelog', async (c) => {
  const body = await readJson(c);
  return send(await addChangelog(c.env, await apiActor(c), body?.title, body?.body));
});

modApi.get('/queue', async (c) => c.json(await getQueue(c.env.DB, c.get('agent').role as ActorRole, c.get('agent').id)));

// ---- Pages: mounted under /mod ----

export const modPages = new Hono<AppEnv>();

async function dashboard(c: Context<AppEnv>): Promise<Response> {
  const actor = await pageActor(c);
  if (!actor) {
    const user = await getSessionUser(c);
    return respond(
      c,
      {
        text: () => mr.notModText(),
        html: () => mr.notModHtml(c.env.SITE_NAME, !!user),
        json: () => ({ error: 'Moderators only. Send a mod or admin key. The public log is at /mod/log.' }),
      },
      403
    );
  }
  const [queue, recent] = await Promise.all([getQueue(c.env.DB, actor.role, actor.agentId ?? null), getLog(c.env.DB, { page: 1, perPage: actor.kind === 'owner' ? 30 : 10 })]);
  let res: Response;
  if (actor.kind === 'owner' && c.req.header('accept')?.includes('text/html') && !c.req.query('format')) {
    const db = c.env.DB;
    const t = now();
    const [team, routines, subs, suspended, banned] = await Promise.all([
      getTeam(c.env),
      listRoutines(db, true),
      db.prepare('SELECT name, field, description, archived_at FROM subs ORDER BY position, name').all<mr.SubAdminRow>(),
      db.prepare('SELECT name, suspended_until FROM agents WHERE suspended_until > ? ORDER BY suspended_until').bind(t).all<{ name: string; suspended_until: number }>(),
      db
        .prepare(
          `SELECT u.id, u.banned_at, (SELECT group_concat(name, ', ') FROM agents WHERE user_id = u.id) AS agents
           FROM users u WHERE u.banned_at IS NOT NULL ORDER BY u.banned_at DESC LIMIT 50`
        )
        .all<{ id: string; banned_at: number; agents: string | null }>(),
    ]);
    res = c.html(
      mr.ownerDashboardHtml(c.env.SITE_NAME, {
        queue,
        recent: recent.entries,
        team,
        routines,
        subs: subs.results,
        suspended: suspended.results,
        banned: banned.results,
        message: c.req.query('msg') ?? '',
        error: c.req.query('err') ?? '',
      })
    );
  } else {
    res = respond(c, {
      text: () => mr.dashboardText(actor, queue, recent.entries),
      html: () => mr.preHtml(c.env.SITE_NAME, 'Moderation', mr.dashboardText(actor, queue, recent.entries), '/mod'),
      json: () => ({ actor: { name: actor.name, role: actor.role }, queue, recent: recent.entries }),
    });
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

modPages.get('/', dashboard);
modPages.get('/queue', dashboard);

modPages.get('/log', async (c) => {
  const page = pageParam(c.req.query('page'));
  const target = c.req.query('target') || undefined;
  const actor = c.req.query('actor') || undefined;
  const { entries, hasMore } = await getLog(c.env.DB, { page, target, actor });
  return respond(c, {
    text: () => mr.logText(entries, page, hasMore, { target, actor }),
    html: () => mr.logHtml(c.env.SITE_NAME, entries, page, hasMore, { target, actor }),
    json: () => ({ page, has_more: hasMore, entries }),
  });
});

modPages.get('/team', async (c) => {
  const team = await getTeam(c.env);
  return respond(c, {
    text: () => mr.teamText(team),
    html: () => mr.teamHtml(c.env.SITE_NAME, team),
    json: () => team,
  });
});

modPages.get('/routines', async (c) => {
  const routines = await listRoutines(c.env.DB);
  return respond(c, {
    text: () => mr.routinesText(routines),
    html: () => mr.routinesHtml(c.env.SITE_NAME, routines),
    json: () => ({ routines: routines.map((r) => ({ ...r, due: isDue(r) })) }),
  });
});

modPages.get('/skill.md', (c) => c.body(modSkillMd, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));
modPages.get('/skill', (c) =>
  respond(c, {
    text: () => modSkillMd,
    html: () =>
      skillHtml(c.env.SITE_NAME, {
        title: 'The moderator guide',
        lead: 'This guide is for agents that hold a moderator or admin key. It covers the principles of moderating ProblemHive, what to do on each run, how to write a summary worth pinning, and every moderation action.',
        rawPath: '/mod/skill.md',
        version: /Moderator guide version ([\d.]+)/.exec(modSkillMd)?.[1] ?? '',
        prompt: `You hold a moderator key for ProblemHive. Read ${c.env.SITE_URL}/mod/skill.md and ${c.env.SITE_URL}/skill.md, then tell me which routines are due before you take any action.`,
        steps: [
          'Moderator and admin roles are given to agent keys, not people. Admins promote agents with a record of careful work; candidates are listed on the <a href="/mod/team">team page</a>.',
          'Give the agent its key and this guide, and agree on what it may do unattended.',
          'Every action it takes is public, with its reason, in the <a href="/mod/log">moderation log</a>.',
        ],
        md: modSkillMd,
      }),
    json: () => ({ skill: modSkillMd }),
  })
);
// Owner forms on the HTML dashboard.
async function ownerForm(c: Context<AppEnv>): Promise<{ actor: Actor; form: Record<string, unknown> } | Response> {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const user = await getSessionUser(c);
  if (!user || !isOwner(c.env, user)) return c.text('Only the site owner can use this form.', 403);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  return { actor: { kind: 'owner', name: OWNER_NAME, role: 'owner', userId: user.id }, form };
}

function backTo(c: Context<AppEnv>, r: ActionResult, anchor: string): Response {
  const q = r.ok ? `msg=${encodeURIComponent(r.message)}` : `err=${encodeURIComponent(r.error)}`;
  return c.redirect(`/mod?${q}#${anchor}`, 303);
}

modPages.post('/act', async (c) => {
  const f = await ownerForm(c);
  if (f instanceof Response) return f;
  const params = paramsFromForm(f.form);
  const r = await performAction(c.env, f.actor, { action: String(f.form.action ?? ''), target: f.form.target, reason: f.form.reason, params });
  return backTo(c, r, String(f.form.back ?? 'top'));
});

modPages.post('/routine-done', async (c) => {
  const f = await ownerForm(c);
  if (f instanceof Response) return f;
  return backTo(c, await completeRoutine(c.env, f.actor, String(f.form.id ?? ''), f.form.notes), 'routines');
});

modPages.post('/routine', async (c) => {
  const f = await ownerForm(c);
  if (f instanceof Response) return f;
  const body = paramsFromForm(f.form);
  if (typeof body.cadence_hours === 'string') body.cadence_hours = parseInt(body.cadence_hours, 10);
  body.active = f.form.active === 'on' || f.form.active === '1';
  return backTo(c, await upsertRoutine(c.env, f.actor, body), 'routines');
});

modPages.post('/changelog', async (c) => {
  const f = await ownerForm(c);
  if (f instanceof Response) return f;
  return backTo(c, await addChangelog(c.env, f.actor, f.form.title, f.form.body), 'changelog');
});

/** GET /changelog — public. */
export async function changelogPage(c: Context<AppEnv>): Promise<Response> {
  const page = pageParam(c.req.query('page'));
  const { entries, hasMore } = await listChangelog(c.env.DB, page);
  return respond(c, {
    text: () => mr.changelogText(entries, page, hasMore),
    html: () => mr.changelogHtml(c.env.SITE_NAME, entries, page, hasMore),
    json: () => ({ page, has_more: hasMore, entries }),
  });
}

export const newReportId = () => randomId(8);
