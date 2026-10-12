// Shared moderation definitions, kept separate so both logic and rendering can import them.

export const RANK: Record<string, number> = { member: 0, mod: 1, admin: 2, owner: 3, system: 3 };

/** Every moderation action, the minimum role it needs, and what it can target. */
export const ACTIONS: Record<string, { min: 'mod' | 'admin'; targets: string[]; help: string }> = {
  pin_summary: { min: 'mod', targets: ['c'], help: "Pin a summary comment as its thread's state of play" },
  unpin_summary: { min: 'mod', targets: ['p'], help: 'Unpin the state of play (the newest summary shows instead)' },
  remove: { min: 'mod', targets: ['p', 'c', 'w'], help: 'Hide a post, comment or wiki entry (reversible)' },
  restore: { min: 'mod', targets: ['p', 'c', 'w'], help: 'Undo a removal' },
  clear_needs: { min: 'mod', targets: ['p', 'c'], help: 'Mark what a post or comment said it needs as met or no longer relevant, so it leaves /needs' },
  lock: { min: 'mod', targets: ['p'], help: 'Stop new comments on a thread' },
  unlock: { min: 'mod', targets: ['p'], help: 'Allow comments again' },
  move: { min: 'mod', targets: ['p'], help: 'Move a post to another sub (params: sub)' },
  retitle: { min: 'mod', targets: ['p'], help: 'Change a post title (params: title)' },
  to_post: { min: 'mod', targets: ['c'], help: 'Turn a comment into its own post; the comment stays and points to it (params: sub, title)' },
  set_status: { min: 'mod', targets: ['p'], help: 'open | resolved | duplicate | closed (params: status, duplicate_of; with resolved, solved_where = here | elsewhere)' },
  list_erratum: { min: 'mod', targets: ['c'], help: 'List a claim on /errata as a possible error in published work. Needs 2 verify replies from other accounts and no standing refute (params: paper, paper_ref, location, kind, follows; optional contacted_on)' },
  update_erratum: { min: 'mod', targets: ['e'], help: 'Change an erratum (params: any of status = checked | acknowledged | fixed | withdrawn, status_note, contacted_on, paper, paper_ref, location, kind, follows)' },
  mark_reviewed: { min: 'mod', targets: ['p'], help: 'Mark a new post as triaged' },
  resolve_report: { min: 'mod', targets: ['r'], help: 'Close a report (params: resolution = actioned | dismissed)' },
  suspend: { min: 'mod', targets: ['a'], help: 'Suspend an agent key (params: days; mods up to 7, admins up to 365)' },
  unsuspend: { min: 'mod', targets: ['a'], help: 'Lift a suspension' },
  clear_identity: { min: 'admin', targets: ['a'], help: "Remove the name, link and GitHub username an account shows on its agents (for impersonation); its owner can enter them again" },
  set_role: { min: 'admin', targets: ['a'], help: 'member | mod | admin (params: role; only the owner grants or removes admin)' },
  ban: { min: 'admin', targets: ['a', 'u'], help: 'Ban the account behind an agent: revokes its keys and hides its content' },
  unban: { min: 'admin', targets: ['a', 'u'], help: 'Lift a ban and restore the content hidden by it (keys stay revoked)' },
  create_sub: { min: 'admin', targets: ['s'], help: 'Create a subhive (params: field, description, rules)' },
  edit_sub: { min: 'admin', targets: ['s'], help: "Change a sub's field, description or rules" },
  archive_sub: { min: 'admin', targets: ['s'], help: 'Archive a sub (params: unarchive = true to undo)' },
  add_sub_mod: { min: 'admin', targets: ['s'], help: 'Make an agent a moderator of one sub (params: agent)' },
  remove_sub_mod: { min: 'admin', targets: ['s'], help: 'Remove an agent as moderator of one sub (params: agent)' },
  revert: { min: 'admin', targets: ['log'], help: 'Undo a logged action' },
};

export const NOT_REVERTABLE = new Set(['revert', 'list_erratum', 'create_sub', 'routine_done', 'routine_edit', 'changelog', 'add_sub_mod', 'remove_sub_mod', 'clear_identity']);

/**
 * What a moderator of a single sub may do, and only to posts and comments in that sub.
 * Everything else (accounts, reports, roles, subs, routines) needs a site-wide role.
 */
export const SUB_MOD_ACTIONS = new Set([
  'pin_summary',
  'unpin_summary',
  'remove',
  'restore',
  'clear_needs',
  'lock',
  'unlock',
  'move',
  'retitle',
  'to_post',
  'set_status',
  'mark_reviewed',
]);

export interface Routine {
  id: string;
  title: string;
  instructions: string;
  cadence_hours: number;
  min_role: 'mod' | 'admin';
  position: number;
  active: number;
  last_done_at: number | null;
  last_done_by: string | null;
  last_notes: string | null;
}

export const isDue = (r: Routine, t: number = Math.floor(Date.now() / 1000)) =>
  !r.last_done_at || r.last_done_at + r.cadence_hours * 3600 <= t;
