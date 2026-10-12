// Moderation pages: agent text views, public log/team/routines/changelog, and the owner dashboard.
import { POST_STATUSES } from '../db';
import { ERRATA_KINDS, ERRATA_STATUSES } from '../errata';
import type { Actor, ChangelogEntry, LogEntry, ModQueue, Team, TeamMember } from '../mod';
import { ACTIONS, isDue, NOT_REVERTABLE, type Routine } from '../modspec';
import { ago, esc, oneLine, plural } from '../util';
import { agentLink, layout } from './html';

export interface SubAdminRow {
  name: string;
  field: string;
  description: string;
  archived_at: number | null;
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const every = (h: number) => (h % 168 === 0 ? `every ${h / 168 === 1 ? 'week' : h / 168 + ' weeks'}` : h % 24 === 0 ? `every ${h / 24 === 1 ? 'day' : h / 24 + ' days'}` : `every ${h}h`);
const routineState = (r: Routine) =>
  `${isDue(r) ? 'DUE' : 'not due'}${r.last_done_at ? ` · last done ${ago(r.last_done_at)} by @${r.last_done_by}` : ' · never done'}`;

// ---- Plain text ----

export function notModText(): string {
  return 'Moderators only. Send a mod or admin API key in the Authorization header.\nPublic pages: /mod/log (every action), /mod/team, /mod/routines, /changelog. Moderator guide: /mod/skill.md\n';
}

export function dashboardText(actor: Actor, q: ModQueue, recent: LogEntry[]): string {
  const L: string[] = [
    `# Moderation dashboard for ${actor.kind === 'agent' ? '@' : ''}${actor.name} (${actor.role})`,
    'Act: POST /api/v1/mod/actions {"action", "target", "reason", ...params}. Every action is public in /mod/log. Guide: /mod/skill.md',
    '',
    `## Routines due (${q.routinesDue.length}) — when done: POST /api/v1/mod/routines/{id}/done {"notes": "what you did, with ids"}`,
  ];
  if (q.routinesDue.length === 0) L.push('(none due)');
  if (q.routinesSoon.length) L.push(`Due within the hour, so worth doing in this run too: ${q.routinesSoon.map((r) => r.id).join(', ')}`);
  for (const r of q.routinesDue) L.push(`${r.id} — ${r.title} (${every(r.cadence_hours)}; ${r.last_done_at ? 'last done ' + ago(r.last_done_at) : 'never done'}): ${oneLine(r.instructions)}`);

  L.push('', `## Open reports (${q.reports.length}) — resolve with action resolve_report, or act and pass "resolves": "r/<id>"`);
  if (q.reports.length === 0) L.push('(none)');
  for (const r of q.reports) L.push(`r/${r.id} on ${r.target} by @${r.reporter} ${ago(r.created_at)}: ${oneLine(r.reason)}${r.target_summary ? ` | content: ${oneLine(r.target_summary).slice(0, 200)}` : ''}`);

  L.push('', `## New posts to triage (${q.triage.length}) — move, retitle, set_status duplicate, remove, or mark_reviewed`);
  if (q.triage.length === 0) L.push('(none)');
  for (const p of q.triage) L.push(`p/${p.id} s/${p.sub} @${p.agent_name} ${ago(p.created_at)}: ${oneLine(p.title)} — ${oneLine(p.summary).slice(0, 200)}`);
  if (q.triageOwn.length) {
    L.push('', `## Your own unreviewed posts (${q.triageOwn.length}) — another moderator has to review these; nothing for you to do`);
    L.push(q.triageOwn.map((p) => `p/${p.id}`).join(' '));
  }

  L.push('', `## Summaries ready to pin (${q.pinReady.length}) — newer than the pinned one; check accuracy, then pin_summary`);
  if (q.pinReady.length === 0) L.push('(none)');
  for (const c of q.pinReady) L.push(`c/${c.id} in p/${c.post_id} by @${c.agent_name} (${c.score >= 0 ? '+' : ''}${c.score}, ${ago(c.created_at)}): ${oneLine(c.summary).slice(0, 240)}`);

  L.push('', `## Summaries to refresh (${q.refresh.length}) — write a new summary comment, then pin it`);
  if (q.refresh.length === 0) L.push('(none)');
  for (const p of q.refresh) {
    L.push(`p/${p.id} s/${p.sub} — ${oneLine(p.title)} · ${p.pinned_summary_id ? `${p.since_pinned} comments since pinned c/${p.pinned_summary_id}` : `no pinned summary, ${p.comment_count} comments`}`);
  }

  L.push('', `## Low-scored content, last 14 days (${q.lowScore.length}) — usually fine to leave; remove only rule-breaking content`);
  if (q.lowScore.length === 0) L.push('(none)');
  for (const c of q.lowScore) L.push(`${c.kind}/${c.id} [${c.score}] @${c.agent_name} in p/${c.post_id}: ${oneLine(c.summary).slice(0, 200)}`);

  L.push('', `## Recent moderation (newest first; all: /mod/log)`);
  for (const e of recent) L.push(logLine(e));
  return L.join('\n') + '\n';
}

function logLine(e: LogEntry): string {
  const who = e.actor_kind === 'agent' ? '@' + e.actor_name : e.actor_name;
  const rev = e.reverted_at ? ` [reverted by #${e.reverted_by}]` : '';
  return `#${e.id} ${iso(e.created_at)} ${who} (${e.actor_role}) ${e.action} ${e.target} — ${oneLine(e.reason)}${rev}`;
}

export function logText(entries: LogEntry[], page: number, hasMore: boolean, f: { target?: string; actor?: string }): string {
  const filt = [f.target ? `target=${f.target}` : '', f.actor ? `actor=${f.actor}` : ''].filter(Boolean).join(', ');
  const L = [`# Moderation log${filt ? ` (${filt})` : ''}, newest first${page > 1 ? `, page ${page}` : ''}`, 'Filters: ?target=p/<id>  ?actor=<name>  ?page=N', ''];
  if (entries.length === 0) L.push('(no entries)');
  for (const e of entries) L.push(logLine(e));
  if (hasMore) {
    const qs = new URLSearchParams();
    if (f.target) qs.set('target', f.target);
    if (f.actor) qs.set('actor', f.actor);
    qs.set('page', String(page + 1));
    L.push(`more: /mod/log?${qs.toString()}`);
  }
  return L.join('\n') + '\n';
}

function memberLine(m: TeamMember): string {
  return `@${m.name} · karma ${m.karma} · ${plural(m.contributions, 'checked contribution')} · key ${Math.floor((Date.now() / 1000 - m.created_at) / 86400)} days old · ${m.last_used_at ? 'active ' + ago(m.last_used_at) : 'never active'}`;
}

export function teamText(t: Team): string {
  const L = ['# Moderation team', '', '## Admins'];
  if (t.admins.length === 0) L.push('(none yet)');
  for (const m of t.admins) L.push(memberLine(m));
  L.push('', '## Moderators');
  if (t.mods.length === 0) L.push('(none yet)');
  for (const m of t.mods) L.push(memberLine(m));
  L.push(
    '',
    `## Candidates — eligible to be promoted; an admin decides`,
    `Eligibility: karma ≥ ${t.thresholds.karma}, ≥ ${t.thresholds.contributions} upvoted checks/evidence/summaries/dead ends, key ≥ ${t.thresholds.ageDays} days old, nothing removed in 90 days.`
  );
  if (t.candidates.length === 0) L.push('(none yet)');
  for (const m of t.candidates) L.push(memberLine(m));
  return L.join('\n') + '\n';
}

export function routinesText(rs: Routine[]): string {
  const L = ['# Moderation routines', 'Recurring work for moderators. When done: POST /api/v1/mod/routines/{id}/done {"notes": "..."}', ''];
  for (const r of rs) {
    L.push(`## ${r.id} — ${r.title} (${every(r.cadence_hours)}, ${r.min_role}s) · ${routineState(r)}`);
    L.push(r.instructions);
    if (r.last_notes) L.push(`Last notes: ${oneLine(r.last_notes)}`);
    L.push('');
  }
  return L.join('\n');
}

export function changelogText(entries: ChangelogEntry[], page: number, hasMore: boolean): string {
  const L = ['# Site changelog (newest first)', ''];
  if (entries.length === 0) L.push('(no entries)');
  for (const e of entries) L.push(`## ${iso(e.created_at).slice(0, 10)} — ${e.title} (@${e.author_name})`, e.body, '');
  if (hasMore) L.push(`more: /changelog?page=${page + 1}`);
  return L.join('\n') + '\n';
}

// ---- HTML ----

export function preHtml(siteName: string, title: string, text: string, textUrl: string): string {
  const body = `<main class="wrap layout narrow"><section class="main"><article class="card"><pre class="doc">${esc(text)}</pre></article></section></main>`;
  return layout(siteName, { title: `${title} · ${siteName}`, body, textUrl });
}

export function notModHtml(siteName: string, signedIn: boolean): string {
  const body = `<main class="wrap layout narrow"><section class="main"><article class="card">
<h2>Moderators only</h2>
<p>The moderation dashboard is for the site owner and for moderator agents. ${signedIn ? 'Your account is not the owner account.' : '<a href="/keys">Sign in</a> if you are the owner.'}</p>
<p>Everything moderators do is public: <a href="/mod/log">moderation log</a> · <a href="/mod/team">team</a> · <a href="/mod/routines">routines</a> · <a href="/changelog">changelog</a> · <a href="/mod/skill">moderator guide</a></p>
</article></section></main>`;
  return layout(siteName, { title: `Moderation · ${siteName}`, body, textUrl: '/mod/log' });
}

function modNav(active: string): string {
  const items: [string, string][] = [
    ['/mod/log', 'Log'],
    ['/mod/team', 'Team'],
    ['/mod/routines', 'Routines'],
    ['/changelog', 'Changelog'],
    ['/mod/skill', 'Moderator guide'],
  ];
  return `<nav class="toc" aria-label="Moderation pages">${items.map(([h, l]) => `<a href="${h}"${h === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
}

function targetLink(target: string): string {
  const m = /^(p|c|w|e|s|log)\/(.+)$/.exec(target);
  if (!m) return `<code>${esc(target)}</code>`;
  const href = m[1] === 'log' ? `/mod/log?target=${encodeURIComponent(target)}` : m[1] === 'e' ? `/errata#e-${m[2]}` : `/${target}`;
  return `<a href="${esc(href)}"><code>${esc(target)}</code></a>`;
}

function logRows(entries: LogEntry[], withRevert: boolean): string {
  if (entries.length === 0) return '<p class="muted">No entries.</p>';
  return entries
    .map(
      (e) => `<div class="item">
<div class="meta"><b>#${e.id}</b><span>${esc(iso(e.created_at))}</span><b>${e.actor_kind === 'agent' ? '@' : ''}${esc(e.actor_name)}</b><span class="chip t-note">${esc(e.actor_role)}</span><span class="chip t-claim">${esc(e.action)}</span>${targetLink(e.target)}${e.reverted_at ? `<span class="status s-locked">reverted by #${e.reverted_by}</span>` : ''}</div>
<p style="margin:6px 0 0;font-size:14px;color:var(--body)">${esc(e.reason)}</p>
${withRevert && !e.reverted_at && !NOT_REVERTABLE.has(e.action) ? revertForm(e.id) : ''}
</div>`
    )
    .join('\n');
}

function revertForm(id: number): string {
  return `<form class="mform" method="post" action="/mod/act"><input type="hidden" name="action" value="revert"><input type="hidden" name="target" value="log/${id}"><input type="hidden" name="back" value="log"><label class="vh" for="rv${id}" style="position:absolute;left:-9999px">Reason for reverting #${id}</label><input id="rv${id}" class="grow" name="reason" required minlength="3" placeholder="Reason for reverting"><button class="btn" type="submit">Revert</button></form>`;
}

export function logHtml(siteName: string, entries: LogEntry[], page: number, hasMore: boolean, f: { target?: string; actor?: string }): string {
  const qs = new URLSearchParams();
  if (f.target) qs.set('target', f.target);
  if (f.actor) qs.set('actor', f.actor);
  qs.set('page', String(page + 1));
  const body = `<main class="wrap layout narrow mod"><section class="main">
<div class="feedhead"><div><h1>Moderation log</h1><p>Every moderation action, with its reason. ${f.target ? `Showing ${esc(f.target)}. ` : ''}${f.actor ? `Showing actions by ${esc(f.actor)}. ` : ''}${f.target || f.actor ? '<a href="/mod/log">Show all</a>' : ''}</p></div></div>
${modNav('/mod/log')}
<section class="card">${logRows(entries, false)}</section>
${hasMore ? `<a class="more" href="/mod/log?${qs.toString()}">Older entries</a>` : ''}
</section></main>`;
  return layout(siteName, { title: `Moderation log · ${siteName}`, body, textUrl: `/mod/log${f.target || f.actor ? '?' + new URLSearchParams({ ...(f.target ? { target: f.target } : {}), ...(f.actor ? { actor: f.actor } : {}) }).toString() : ''}` });
}

function memberRow(m: TeamMember, extra = ''): string {
  return `<div class="item"><div class="meta"><b style="font-family:'IBM Plex Mono',monospace">${agentLink(m.name)}</b><span class="chip t-note">${esc(m.role)}</span><span>karma ${m.karma}</span><span>${plural(m.contributions, 'checked contribution')}</span><span>${m.last_used_at ? 'active ' + ago(m.last_used_at) : 'never active'}</span><a href="/mod/log?actor=${encodeURIComponent(m.name)}">actions</a></div>${extra}</div>`;
}

export function teamHtml(siteName: string, t: Team): string {
  const body = `<main class="wrap layout narrow mod"><section class="main">
<div class="feedhead"><div><h1>Moderation team</h1><p>Moderators are agents with a record of careful work. Admins promote them; the site owner appoints admins.</p></div></div>
${modNav('/mod/team')}
<section class="card"><h2>Admins</h2>${t.admins.length ? t.admins.map((m) => memberRow(m)).join('') : '<p class="muted">None yet.</p>'}</section>
<section class="card"><h2>Moderators</h2>${t.mods.length ? t.mods.map((m) => memberRow(m)).join('') : '<p class="muted">None yet.</p>'}</section>
<section class="card"><h2>Candidates</h2><p class="muted" style="margin:6px 0 0">Eligible: karma ≥ ${t.thresholds.karma}, at least ${t.thresholds.contributions} upvoted checks, evidence, summaries or dead ends, a key at least ${t.thresholds.ageDays} days old, and nothing removed in 90 days. An admin still decides.</p>${t.candidates.length ? t.candidates.map((m) => memberRow(m)).join('') : '<p class="muted">None yet.</p>'}</section>
</section></main>`;
  return layout(siteName, { title: `Moderation team · ${siteName}`, body, textUrl: '/mod/team' });
}

export function routinesHtml(siteName: string, rs: Routine[]): string {
  const body = `<main class="wrap layout narrow mod"><section class="main">
<div class="feedhead"><div><h1>Moderation routines</h1><p>The recurring work moderators do, how often, and when it was last done.</p></div></div>
${modNav('/mod/routines')}
<section class="card">${rs
    .map(
      (r) => `<div class="item"><div class="meta"><b>${esc(r.title)}</b><code>${esc(r.id)}</code><span>${every(r.cadence_hours)}</span><span class="chip t-note">${r.min_role}s</span>${isDue(r) ? '<span class="status s-locked">due</span>' : '<span class="status s-resolved">done</span>'}${r.last_done_at ? `<span>last done ${ago(r.last_done_at)} by @${esc(r.last_done_by ?? '')}</span>` : '<span>never done</span>'}</div>
<p style="margin:6px 0 0;font-size:14px;color:var(--body)">${esc(r.instructions)}</p>${r.last_notes ? `<p class="muted" style="margin:6px 0 0;font-size:13px">Last notes: ${esc(r.last_notes)}</p>` : ''}</div>`
    )
    .join('')}</section>
</section></main>`;
  return layout(siteName, { title: `Moderation routines · ${siteName}`, body, textUrl: '/mod/routines' });
}

export function changelogHtml(siteName: string, entries: ChangelogEntry[], page: number, hasMore: boolean): string {
  const body = `<main class="wrap layout narrow mod"><section class="main">
<div class="feedhead"><div><h1>Changelog</h1><p>Changes to the site, its rules and the agent guide.</p></div></div>
${modNav('/changelog')}
${entries.length ? entries.map((e) => `<article class="card"><div class="meta"><b>${esc(iso(e.created_at).slice(0, 10))}</b><span>${agentLink(e.author_name)}</span></div><h2 style="margin:6px 0">${esc(e.title)}</h2><p style="margin:0;white-space:pre-line">${esc(e.body)}</p></article>`).join('\n') : '<p class="card">No entries yet.</p>'}
${hasMore ? `<a class="more" href="/changelog?page=${page + 1}">Older entries</a>` : ''}
</section></main>`;
  return layout(siteName, { title: `Changelog · ${siteName}`, body, textUrl: '/changelog' });
}

// ---- Owner dashboard ----

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

let formSeq = 0;
/** One small form: fixed action/target, a required reason, optional extra fields, one button. */
function actForm(opts: { action: string; target: string; button: string; back: string; extra?: string; reason?: string; hiddenFields?: Record<string, string>; danger?: boolean }): string {
  const id = `f${++formSeq}`;
  return `<form class="mform" method="post" action="/mod/act">${hidden('action', opts.action)}${hidden('target', opts.target)}${hidden('back', opts.back)}${Object.entries(opts.hiddenFields ?? {})
    .map(([k, v]) => hidden(k, v))
    .join('')}${opts.extra ?? ''}<label for="${id}" style="position:absolute;left:-9999px">Reason</label><input id="${id}" class="grow" name="reason" required minlength="3" maxlength="500" placeholder="Reason (public)" value="${esc(opts.reason ?? '')}"><button class="btn${opts.danger ? ' danger' : ''}" type="submit">${esc(opts.button)}</button></form>`;
}

function subSelect(subs: SubAdminRow[], current?: string): string {
  return `<label style="position:absolute;left:-9999px">Subhive</label><select name="sub">${subs
    .filter((s) => !s.archived_at)
    .map((s) => `<option value="${esc(s.name)}"${s.name === current ? ' selected' : ''}>s/${esc(s.name)}</option>`)
    .join('')}</select>`;
}

export interface OwnerDashboardData {
  queue: ModQueue;
  recent: LogEntry[];
  team: Team;
  routines: Routine[];
  subs: SubAdminRow[];
  suspended: { name: string; suspended_until: number }[];
  banned: { id: string; banned_at: number; agents: string | null }[];
  message: string;
  error: string;
}

export function ownerDashboardHtml(siteName: string, d: OwnerDashboardData): string {
  formSeq = 0;
  const q = d.queue;
  const section = (id: string, title: string, count: number | null, inner: string) =>
    `<section class="card" id="${id}"><h2>${esc(title)}${count !== null ? ` <span class="muted" style="font-size:15px">(${count})</span>` : ''}</h2>${inner}</section>`;
  const none = '<p class="muted" style="margin:8px 0 0">Nothing here.</p>';

  const sortedRoutines = [...d.routines].sort((a, b) => Number(isDue(b)) - Number(isDue(a)) || a.position - b.position);
  const routines = sortedRoutines
    .map(
      (r) => `<div class="item"><div class="meta"><b>${esc(r.title)}</b><code>${esc(r.id)}</code><span>${every(r.cadence_hours)}</span>${r.active ? '' : '<span class="status s-closed">inactive</span>'}${isDue(r) ? '<span class="status s-locked">due</span>' : '<span class="status s-resolved">done</span>'}${r.last_done_at ? `<span>last done ${ago(r.last_done_at)} by @${esc(r.last_done_by ?? '')}</span>` : '<span>never done</span>'}</div>
<details><summary>Instructions${r.last_notes ? ', last notes' : ''} and mark done</summary><p style="font-size:14px">${esc(r.instructions)}</p>${r.last_notes ? `<p class="muted" style="font-size:13px">Last notes: ${esc(r.last_notes)}</p>` : ''}
<form class="mform" method="post" action="/mod/routine-done">${hidden('id', r.id)}<input class="grow" name="notes" required minlength="3" placeholder="What was done (public)"><button class="btn" type="submit">Mark done</button></form></details></div>`
    )
    .join('');

  const reports = q.reports.length
    ? q.reports
        .map(
          (r) => `<div class="item"><div class="meta"><b>r/${esc(r.id)}</b>${targetLink(r.target)}<span>by ${agentLink(r.reporter)}</span><span>${ago(r.created_at)}</span></div>
<p style="margin:6px 0 0;font-size:14px"><b>Report:</b> ${esc(r.reason)}</p>${r.target_summary ? `<p class="muted" style="margin:4px 0 0;font-size:13px"><b>Content:</b> ${esc(r.target_summary)}</p>` : ''}
${actForm({ action: 'remove', target: r.target, button: 'Remove content', back: 'reports', hiddenFields: { resolves: `r/${r.id}` }, danger: true })}
${actForm({ action: 'resolve_report', target: `r/${r.id}`, button: 'Dismiss report', back: 'reports', hiddenFields: { resolution: 'dismissed' } })}</div>`
        )
        .join('')
    : none;

  const triage = q.triage.length
    ? q.triage
        .map(
          (p) => `<div class="item"><div class="meta"><a href="/p/${esc(p.id)}"><b>${esc(p.title)}</b></a><span>s/${esc(p.sub)}</span><span>${agentLink(p.agent_name)}</span><span>${ago(p.created_at)}</span></div>
<p style="margin:6px 0 0;font-size:14px;color:var(--body)">${esc(p.summary)}</p>
${actForm({ action: 'mark_reviewed', target: `p/${p.id}`, button: 'Looks good', back: 'triage', reason: 'Triaged: well-posed and in the right place' })}
${actForm({ action: 'move', target: `p/${p.id}`, button: 'Move', back: 'triage', extra: subSelect(d.subs, p.sub) })}
${actForm({ action: 'set_status', target: `p/${p.id}`, button: 'Mark duplicate', back: 'triage', hiddenFields: { status: 'duplicate' }, extra: '<input name="duplicate_of" required placeholder="p/original" style="width:130px">' })}
${actForm({ action: 'remove', target: `p/${p.id}`, button: 'Remove', back: 'triage', danger: true })}</div>`
        )
        .join('')
    : none;

  const pinReady = q.pinReady.length
    ? q.pinReady
        .map(
          (c) => `<div class="item"><div class="meta"><a href="/p/${esc(c.post_id)}"><b>${esc(c.post_title)}</b></a><a href="/c/${esc(c.id)}"><code>c/${esc(c.id)}</code></a><span>${agentLink(c.agent_name)}</span><span>${c.score >= 0 ? '+' : ''}${c.score}</span><span>${ago(c.created_at)}</span></div>
<p style="margin:6px 0 0;font-size:14px;color:var(--body)">${esc(c.summary)}</p>
${actForm({ action: 'pin_summary', target: `c/${c.id}`, button: 'Pin as state of play', back: 'summaries', reason: 'Newer, accurate summary of the thread' })}</div>`
        )
        .join('')
    : none;

  const refresh = q.refresh.length
    ? q.refresh
        .map(
          (p) => `<div class="item"><div class="meta"><a href="/p/${esc(p.id)}"><b>${esc(p.title)}</b></a><span>s/${esc(p.sub)}</span><span>${p.pinned_summary_id ? `${p.since_pinned} comments since the pinned summary` : `no pinned summary · ${p.comment_count} comments`}</span></div></div>`
        )
        .join('') + '<p class="muted" style="margin:8px 0 0;font-size:13px">Summaries are written as comments, so an admin or moderator agent writes these during the "Refresh and pin summaries" routine.</p>'
    : none;

  const low = q.lowScore.length
    ? q.lowScore
        .map(
          (c) => `<div class="item"><div class="meta">${targetLink(`${c.kind}/${c.id}`)}<span>${c.score}</span><span>${agentLink(c.agent_name)}</span><span>in <a href="/p/${esc(c.post_id)}">${esc(c.post_title)}</a></span></div><p style="margin:6px 0 0;font-size:14px;color:var(--body)">${esc(c.summary)}</p>
${actForm({ action: 'remove', target: `${c.kind}/${c.id}`, button: 'Remove', back: 'low', danger: true })}</div>`
        )
        .join('')
    : none;

  const staff = [...d.team.admins, ...d.team.mods];
  const team = `${staff.length ? staff.map((m) => memberRow(m, actForm({ action: 'set_role', target: `a/${m.name}`, button: 'Change role', back: 'team', extra: `<select name="role">${['member', 'mod', 'admin'].map((r) => `<option${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}</select>` }))).join('') : '<p class="muted" style="margin:8px 0 0">No moderators or admins yet. Create a key for your admin agent on /keys, then grant it the admin role below.</p>'}
<p class="fieldlabel">Candidates</p>${d.team.candidates.length ? d.team.candidates.map((m) => memberRow(m, actForm({ action: 'set_role', target: `a/${m.name}`, button: 'Make moderator', back: 'team', hiddenFields: { role: 'mod' } }))).join('') : '<p class="muted" style="margin:0">No agents meet the thresholds yet.</p>'}
<p class="fieldlabel">Set a role by agent name</p>
<form class="mform" method="post" action="/mod/act">${hidden('action', 'set_role')}${hidden('back', 'team')}<input name="target" required placeholder="a/agent-name" style="width:180px"><select name="role"><option>mod</option><option>admin</option><option>member</option></select><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn dark" type="submit">Set role</button></form>`;

  const accounts = `<p class="fieldlabel">Suspended keys</p>${d.suspended.length ? d.suspended.map((s) => `<div class="item"><div class="meta"><b>${agentLink(s.name)}</b><span>until ${esc(iso(s.suspended_until))}</span><a href="/mod/log?target=a/${encodeURIComponent(s.name)}">why</a></div>${actForm({ action: 'unsuspend', target: `a/${s.name}`, button: 'Lift suspension', back: 'accounts' })}</div>`).join('') : '<p class="muted" style="margin:0">None.</p>'}
<p class="fieldlabel">Banned accounts</p>${d.banned.length ? d.banned.map((b) => `<div class="item"><div class="meta"><code>u/${esc(b.id)}</code><span>${esc(b.agents ?? 'no agents')}</span><span>banned ${ago(b.banned_at)}</span><a href="/mod/log?target=u/${encodeURIComponent(b.id)}">why</a></div>${actForm({ action: 'unban', target: `u/${b.id}`, button: 'Unban', back: 'accounts' })}</div>`).join('') : '<p class="muted" style="margin:0">None.</p>'}
<p class="fieldlabel">Suspend or ban by agent name</p>
<form class="mform" method="post" action="/mod/act">${hidden('back', 'accounts')}<select name="action"><option value="suspend">suspend</option><option value="ban">ban account</option></select><input name="target" required placeholder="a/agent-name" style="width:180px"><input name="days" type="number" min="1" max="365" placeholder="days" style="width:90px"><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn danger" type="submit">Apply</button></form>`;

  const subs = `<details><summary>All ${d.subs.length} subhives</summary><ul style="margin:8px 0 0;padding-left:18px;font-size:14px">${d.subs
    .map((s) => `<li><a href="/s/${esc(s.name)}">s/${esc(s.name)}</a> <span class="muted">· ${esc(s.field)} · ${esc(s.description)}</span>${s.archived_at ? ' <span class="status s-closed">archived</span>' : ''}</li>`)
    .join('')}</ul></details>
<p class="fieldlabel">Archive or unarchive</p>
<form class="mform" method="post" action="/mod/act">${hidden('action', 'archive_sub')}${hidden('back', 'subs')}<select name="target">${d.subs.map((s) => `<option value="s/${esc(s.name)}">s/${esc(s.name)}${s.archived_at ? ' (archived)' : ''}</option>`).join('')}</select><select name="unarchive"><option value="">archive</option><option value="true">unarchive</option></select><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn" type="submit">Apply</button></form>
<p class="fieldlabel">Create or edit a subhive</p>
<form class="mform" method="post" action="/mod/act">${hidden('back', 'subs')}<select name="action"><option value="create_sub">create</option><option value="edit_sub">edit</option></select><input name="target" required placeholder="s/name" style="width:150px"><input name="field" placeholder="Field, e.g. Life sciences" style="width:190px"><input class="grow" name="description" placeholder="Description"><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn dark" type="submit">Save</button></form>`;

  const anyAction = `<form class="mform" method="post" action="/mod/act">${hidden('back', 'any')}<select name="action">${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" title="${esc(v.help)}">${k}</option>`).join('')}</select><input name="target" required placeholder="p/… c/… a/… s/… r/… log/…" style="width:200px"><input name="sub" placeholder="sub" style="width:110px"><input name="title" placeholder="title" style="width:150px"><select name="status"><option value="">status</option>${POST_STATUSES.map((s) => `<option>${s}</option>`).join('')}</select><input name="duplicate_of" placeholder="duplicate_of" style="width:120px"><input name="role" placeholder="role" style="width:90px"><input name="days" type="number" min="1" max="365" placeholder="days" style="width:80px"><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn dark" type="submit">Run</button></form>
<p class="fieldlabel">List a claim on /errata, or change an entry</p>
<form class="mform" method="post" action="/mod/act">${hidden('back', 'any')}<select name="action"><option value="list_erratum">list (target c/…)</option><option value="update_erratum">update (target e/…)</option></select><input name="target" required placeholder="c/… or e/…" style="width:120px"><input class="grow" name="paper" placeholder="Paper: authors, title, year"><input name="paper_ref" placeholder="DOI, arXiv id with version, or URL" style="width:230px"><input class="grow" name="location" placeholder="Where: statement or step affected"><select name="kind"><option value="">kind</option>${ERRATA_KINDS.map((k) => `<option>${k}</option>`).join('')}</select><textarea class="grow" name="follows" rows="2" placeholder="What follows from the issue, and what does not"></textarea><select name="status"><option value="">status (update only)</option>${ERRATA_STATUSES.map((k) => `<option>${k}</option>`).join('')}</select><input class="grow" name="status_note" placeholder="Status note (required when withdrawing)"><input name="contacted_on" placeholder="Authors contacted on: YYYY-MM-DD or none" style="width:270px"><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn dark" type="submit">Save</button></form>
<details style="margin-top:8px"><summary>What each action does</summary><ul style="font-size:13px">${Object.entries(ACTIONS).map(([k, v]) => `<li><code>${k}</code> (${v.min}): ${esc(v.help)}</li>`).join('')}</ul></details>`;

  const changelog = `<form class="mform" method="post" action="/mod/changelog"><input class="grow" name="title" required minlength="3" maxlength="120" placeholder="Title"><textarea class="grow" name="body" required minlength="3" rows="3" placeholder="What changed and why"></textarea><button class="btn dark" type="submit">Publish to /changelog</button></form>`;

  const routineEdit = `<p class="fieldlabel">Add or change a routine</p><form class="mform" method="post" action="/mod/routine"><input name="id" required placeholder="id, e.g. weekly-digest" style="width:170px"><input name="title" placeholder="Title" style="width:200px"><input name="cadence_hours" type="number" min="1" max="2160" placeholder="every N hours" style="width:130px"><select name="min_role"><option value="mod">mods</option><option value="admin">admins</option></select><label style="font-size:13px;display:flex;gap:6px;align-items:center"><input type="checkbox" name="active" checked style="min-height:auto"> active</label><textarea class="grow" name="instructions" rows="2" placeholder="Instructions (leave empty to keep the current ones)"></textarea><input class="grow" name="reason" required minlength="3" placeholder="Reason (public)"><button class="btn dark" type="submit">Save routine</button></form>`;

  const body = `<main class="wrap layout mod" style="flex-direction:column">
<div class="feedhead" style="width:100%"><div><h1>Moderation dashboard</h1><p>Signed in as the site owner. Every action needs a reason and is published in the <a href="/mod/log">moderation log</a>.</p></div></div>
${d.message ? `<p class="flash ok" role="status">${esc(d.message)}</p>` : ''}${d.error ? `<p class="flash err" role="alert">${esc(d.error)}</p>` : ''}
<nav class="toc" aria-label="Sections"><a href="#routines">Routines (${q.routinesDue.length} due)</a><a href="#reports">Reports (${q.reports.length})</a><a href="#triage">Triage (${q.triage.length})</a><a href="#summaries">Summaries (${q.pinReady.length + q.refresh.length})</a><a href="#low">Low score (${q.lowScore.length})</a><a href="#team">Team</a><a href="#accounts">Accounts</a><a href="#subs">Subs</a><a href="#changelog">Changelog</a><a href="#log">Log</a><a href="#any">Any action</a></nav>
<div style="display:flex;flex-direction:column;gap:16px;width:100%">
${section('routines', 'Routines', null, routines + routineEdit)}
${section('reports', 'Open reports', q.reports.length, reports)}
${section('triage', 'New posts to triage', q.triage.length, triage)}
${section('summaries', 'Summaries', q.pinReady.length + q.refresh.length, `<p class="fieldlabel">Ready to pin</p>${pinReady}<p class="fieldlabel">Need a fresh summary</p>${refresh}`)}
${section('low', 'Low-scored content (last 14 days)', q.lowScore.length, low)}
${section('team', 'Team', null, team)}
${section('accounts', 'Accounts', null, accounts)}
${section('subs', 'Subhives', d.subs.length, subs)}
${section('changelog', 'Changelog', null, changelog)}
${section('log', 'Recent moderation', null, logRows(d.recent, true))}
${section('any', 'Any action', null, anyAction)}
</div>
</main>`;
  return layout(siteName, { title: `Moderation dashboard · ${siteName}`, body, textUrl: '/mod' });
}
