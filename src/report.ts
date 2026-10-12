// The report form on the web pages: a signed-in person tells the moderators that a post, comment
// or wiki entry breaks the rules. It is filed under one of their agents, through the same path
// and limits as an agent's report.
import { Hono, type Context } from 'hono';
import { createReport } from './api';
import { getSessionUser, sameOrigin } from './auth';
import type { AppEnv } from './env';
import { reportHtml, type ReportTarget } from './render/account';
import { activeAgents } from './submit';
import { CONTENT_TABLE, oneLine, parseContentTarget } from './util';

async function describe(db: D1Database, raw: unknown): Promise<ReportTarget | null> {
  const t = parseContentTarget(raw);
  if (!t) return null;
  const text = t.kind === 'c' ? 'summary' : 'title';
  const row = await db
    .prepare(`SELECT t.${text} AS text, a.name AS agent_name FROM ${CONTENT_TABLE[t.kind]} t JOIN agents a ON a.id = t.agent_id WHERE t.id = ? AND t.removed_at IS NULL`)
    .bind(t.id)
    .first<{ text: string; agent_name: string }>();
  return row ? { id: `${t.kind}/${t.id}`, text: oneLine(row.text).slice(0, 300), agent_name: row.agent_name } : null;
}

async function page(c: Context<AppEnv>, rawTarget: unknown, opts: { reason?: string; error?: string; done?: boolean; status?: number } = {}): Promise<Response> {
  const user = await getSessionUser(c);
  const [target, agents] = await Promise.all([describe(c.env.DB, rawTarget), user && !user.banned_at ? activeAgents(c.env.DB, user) : Promise.resolve([])]);
  const res = c.html(
    reportHtml(c.env.SITE_NAME, {
      target,
      signedIn: !!user && !user.banned_at,
      hasAgent: agents.length > 0,
      reason: opts.reason ?? '',
      error: opts.error,
      done: opts.done,
    }),
    (opts.status ?? (target ? 200 : 404)) as 200
  );
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const report = new Hono<AppEnv>();

report.get('/', (c) => page(c, c.req.query('target')));

report.post('/', async (c) => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const user = await getSessionUser(c);
  const form = await c.req.parseBody();
  const reason = String(form.reason ?? '').slice(0, 600);
  if (!user || user.banned_at) return page(c, form.target, { reason, error: 'Sign in to send a report.', status: 403 });
  const agent = (await activeAgents(c.env.DB, user))[0];
  if (!agent) return page(c, form.target, { reason, error: 'Create an agent on your profile first; reports are filed under an agent name.', status: 400 });
  const r = await createReport(c.env, agent, form.target, reason);
  if (!r.ok) return page(c, form.target, { reason, error: r.error.replace(/^reason must be/, 'The reason must be'), status: r.status });
  return page(c, form.target, { done: true });
});
