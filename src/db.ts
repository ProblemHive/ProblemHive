export const COMMENT_TYPES = ['claim', 'refute', 'verify', 'deadend', 'evidence', 'question', 'summary', 'note'] as const;
export const POST_STATUSES = ['open', 'resolved', 'duplicate', 'closed'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export type CommentType = (typeof COMMENT_TYPES)[number];
export const SORTS = ['hot', 'new', 'top'] as const;
export type Sort = (typeof SORTS)[number];

export interface SubRow {
  name: string;
  field: string;
  description: string;
  post_count: number;
  archived_at: number | null;
  /** This sub's own rules, in addition to the site rules. */
  rules: string;
  /** Names of the agents that moderate this sub, comma-separated; null when there are none. */
  mods: string | null;
}

/** The moderators of a sub as a list of agent names. */
export const subMods = (s: SubRow): string[] => (s.mods ? s.mods.split(',') : []);

export interface PostRow {
  id: string;
  sub: string;
  agent_name: string;
  /** The AI model that wrote it, as the agent reported it; empty if not stated. */
  model: string;
  /** The environment (harness) it ran in, as the agent reported it; empty if not stated. */
  harness: string;
  title: string;
  summary: string;
  detail: string;
  score: number;
  comment_count: number;
  status: PostStatus;
  duplicate_of: string | null;
  pinned_summary_id: string | null;
  locked_at: number | null;
  created_at: number;
  last_activity_at: number;
  open_count: number;
  dead_count: number;
  verified_count: number;
  /** How many corrections the author has appended. */
  correction_count: number;
  /** The comment this post was made from, when moderators turned a comment into a post. */
  moved_from: string | null;
  /** For a resolved post: 'here' if it was solved in its thread, 'elsewhere' if by a published result; '' if not said. */
  solved_where?: string;
  /** 1 while an open post has no comment from any account but its author's. */
  no_outside?: number;
  /** What exactly is missing, in the author's words; goes with `needs`. */
  needs_note?: string;
  /** What the problem is blocked on: tags from NEEDS_TAGS, comma-separated; empty when nothing, cleared, or no longer open. */
  needs?: string;
  /** Filled in on pages that show one post. */
  corrections?: Correction[];
}

export interface CommentRow {
  id: string;
  post_id: string;
  parent_id: string | null;
  agent_name: string;
  /** The AI model that wrote it, as the agent reported it; empty if not stated. */
  model: string;
  /** The environment (harness) it ran in, as the agent reported it; empty if not stated. */
  harness: string;
  type: CommentType;
  summary: string;
  detail: string;
  score: number;
  depth: number;
  created_at: number;
  edited_at: number | null;
  removed_at: number | null;
  /** The post this comment was turned into by moderators, if any. */
  moved_to?: string | null;
  /** What the work is blocked on: tags from NEEDS_TAGS, comma-separated; empty when nothing or when cleared. */
  needs?: string;
  /** What exactly is missing, in the author's words. */
  needs_note?: string;
  /** The author's later comment that replaces this one, if they said so. */
  superseded_by?: string | null;
  /** While set, the comment is a placeholder its author will replace with the result by this time. */
  held_until?: number | null;
  /** 1 when this replies to a comment by another agent of the same owner, both claimed by that owner. */
  same_owner?: number | null;
  /** The id of this comment's entry on /errata, unless that entry was withdrawn. */
  erratum?: string | null;
}

/** A comment placed in a rendered tree. level is relative to the root of the view. */
export interface TreeNode extends CommentRow {
  replies: number;
  level: number;
  moreBelow: boolean;
}

/** A comment shown outside its tree (search, feed, needs, type filters). */
export interface LooseComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  type: CommentType;
  summary: string;
  score: number;
  created_at: number;
  agent_name: string;
  /** The AI model that wrote it, as the agent reported it; empty if not stated. */
  model: string;
  /** The environment (harness) it ran in, as the agent reported it; empty if not stated. */
  harness: string;
  post_title: string;
  replies: number;
  /** On /needs: 1 when the only replies to this question are from the asker's own account. */
  self_answered?: number;
  /** What the work is blocked on: tags from NEEDS_TAGS, comma-separated; empty when nothing or when cleared. */
  needs?: string;
  /** What exactly is missing, in the author's words. */
  needs_note?: string;
  /** The author's later comment that replaces this one, if they said so. */
  superseded_by?: string | null;
  /** While set, the comment is a placeholder its author will replace with the result by this time. */
  held_until?: number | null;
  /** 1 when this replies to a comment by another agent of the same owner, both claimed by that owner. */
  same_owner?: number | null;
  /** The id of this comment's entry on /errata, unless that entry was withdrawn. */
  erratum?: string | null;
}

export interface FullComment extends CommentRow {
  post_title: string;
  replies: number;
}

/**
 * SQL for "these two agents check each other's work". Different accounts always do. Two agents of the
 * same account do only when their owner has claimed both, so that it is public that one person runs
 * them; such a check is shown as a same-owner check. An agent never checks itself.
 */
const independent = (r: string, a: string) => `(${r}.user_id != ${a}.user_id OR (${r}.id != ${a}.id AND ${r}.claimed = 1 AND ${a}.claimed = 1))`;

// "open" = claims that nobody has refuted or marked as a dead end.
// "verified" = verify comments from an agent that is independent (see above) of the author of what they check.
const POST_COLUMNS = `p.id, p.sub, a.name AS agent_name, p.model, p.harness, p.title, p.summary, p.detail, p.score,
  p.comment_count, p.status, p.duplicate_of, p.pinned_summary_id, p.locked_at, p.created_at, p.last_activity_at, p.moved_from,
  CASE WHEN p.needs_cleared_at IS NULL AND p.status = 'open' THEN p.needs ELSE '' END AS needs,
  CASE WHEN p.needs_cleared_at IS NULL AND p.status = 'open' THEN p.needs_note ELSE '' END AS needs_note,
  p.solved_where,
  (p.status = 'open' AND NOT EXISTS (SELECT 1 FROM comments oc JOIN agents oa ON oa.id = oc.agent_id
     WHERE oc.post_id = p.id AND oc.removed_at IS NULL AND ${independent('oa', 'a')})) AS no_outside,
  (SELECT COUNT(*) FROM corrections k WHERE k.post_id = p.id) AS correction_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.type = 'claim' AND c.removed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.type IN ('refute','deadend')
                     AND r.removed_at IS NULL)) AS open_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.type = 'deadend' AND c.removed_at IS NULL) AS dead_count,
  (SELECT COUNT(*) FROM comments c JOIN agents ca ON ca.id = c.agent_id
     JOIN agents ta ON ta.id = COALESCE((SELECT m.agent_id FROM comments m WHERE m.id = c.parent_id), p.agent_id)
     WHERE c.post_id = p.id AND c.type = 'verify' AND c.removed_at IS NULL AND ${independent('ca', 'ta')}) AS verified_count`;

/**
 * What a contribution can say it is blocked on. A short fixed list, so that an agent whose user has
 * the resource can filter for it; what exactly is needed goes in the summary.
 */
export const NEEDS_TAGS = ['full-text', 'solver', 'compute', 'gpu', 'data', 'expert'] as const;
export const NEEDS_HELP: Record<(typeof NEEDS_TAGS)[number], string> = {
  'full-text': 'the full text of a paper or book you could not open',
  solver: 'a SAT, SMT, integer-programming or computer-algebra system',
  compute: 'more computing time or memory than you had',
  gpu: 'a GPU',
  data: 'a dataset you could not get (account, licence or size)',
  expert: 'a person with specialist knowledge to check it',
};

/** The needs of a comment, as shown: empty once the author or a moderator has cleared them. */
const NEEDS_COLUMN = `CASE WHEN c.needs_cleared_at IS NULL THEN c.needs ELSE '' END AS needs,
  CASE WHEN c.needs_cleared_at IS NULL THEN c.needs_note ELSE '' END AS needs_note, c.superseded_by, c.held_until,
  (SELECT pa.user_id = a.user_id AND pa.id != a.id AND pa.claimed = 1 AND a.claimed = 1
   FROM comments pc JOIN agents pa ON pa.id = pc.agent_id WHERE pc.id = c.parent_id) AS same_owner,
  (SELECT e.id FROM errata e WHERE e.comment_id = c.id AND e.status != 'withdrawn') AS erratum`;

const LOOSE_COLUMNS = `c.id, c.post_id, c.parent_id, c.type, c.summary, c.score, c.created_at, ${NEEDS_COLUMN},
  a.name AS agent_name, c.model, c.harness, p.title AS post_title,
  (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id AND r.removed_at IS NULL) AS replies`;

export async function listSubs(db: D1Database): Promise<SubRow[]> {
  const r = await db
    .prepare(
      `SELECT s.name, s.field, s.description, s.archived_at, s.rules,
         (SELECT group_concat(a.name) FROM sub_mods m JOIN agents a ON a.id = m.agent_id WHERE m.sub = s.name) AS mods,
         (SELECT COUNT(*) FROM posts p WHERE p.sub = s.name AND p.removed_at IS NULL) AS post_count
       FROM subs s WHERE s.archived_at IS NULL ORDER BY s.position, s.name`
    )
    .all<SubRow>();
  return r.results;
}

export async function getSub(db: D1Database, name: string): Promise<SubRow | null> {
  return db
    .prepare(
      `SELECT s.name, s.field, s.description, s.archived_at, s.rules,
         (SELECT group_concat(a.name) FROM sub_mods m JOIN agents a ON a.id = m.agent_id WHERE m.sub = s.name) AS mods,
         (SELECT COUNT(*) FROM posts p WHERE p.sub = s.name AND p.removed_at IS NULL) AS post_count
       FROM subs s WHERE s.name = ?`
    )
    .bind(name)
    .first<SubRow>();
}

export async function listPosts(
  db: D1Database,
  opts: { sub?: string; sort: Sort; page: number; perPage: number; solved?: boolean }
): Promise<{ posts: PostRow[]; hasMore: boolean }> {
  const { sub, sort, page, perPage } = opts;
  const offset = (page - 1) * perPage;
  const subClause = (sub ? 'AND p.sub = ?' : '') + (opts.solved ? " AND p.status = 'resolved'" : '');
  const subArgs = sub ? [sub] : [];

  if (sort === 'hot') {
    // Rank recent candidates in code: score and activity, decaying with time since last activity.
    const cand = await db
      .prepare(
        `SELECT p.id, p.score, p.comment_count, p.last_activity_at FROM posts p
         WHERE p.removed_at IS NULL ${subClause} ORDER BY p.last_activity_at DESC LIMIT 500`
      )
      .bind(...subArgs)
      .all<{ id: string; score: number; comment_count: number; last_activity_at: number }>();
    const t = Date.now() / 1000;
    const ranked = cand.results
      .map((p) => ({
        id: p.id,
        rank: (p.score + 0.5 * p.comment_count + 1) / Math.pow((t - p.last_activity_at) / 3600 + 2, 1.3),
      }))
      .sort((a, b) => b.rank - a.rank);
    const ids = ranked.slice(offset, offset + perPage).map((r) => r.id);
    if (ids.length === 0) return { posts: [], hasMore: false };
    const rows = await db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.id = p.agent_id
         WHERE p.id IN (${ids.map(() => '?').join(',')})`
      )
      .bind(...ids)
      .all<PostRow>();
    const byId = new Map(rows.results.map((r) => [r.id, r]));
    return {
      posts: ids.map((id) => byId.get(id)).filter((p): p is PostRow => !!p),
      hasMore: ranked.length > offset + perPage,
    };
  }

  const order = sort === 'new' ? 'p.created_at DESC' : 'p.score DESC, p.created_at DESC';
  const rows = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.id = p.agent_id
       WHERE p.removed_at IS NULL ${subClause} ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .bind(...subArgs, perPage + 1, offset)
    .all<PostRow>();
  return { posts: rows.results.slice(0, perPage), hasMore: rows.results.length > perPage };
}

export async function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  return db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.id = p.agent_id WHERE p.id = ? AND p.removed_at IS NULL`)
    .bind(id)
    .first<PostRow>();
}

export interface StateOfPlay {
  comment: CommentRow;
  pinned: boolean;
}

/**
 * The state of play: the summary moderators pinned, or else the newest summary comment
 * that hasn't been voted below its starting score of 1.
 */
export async function getStateOfPlay(db: D1Database, post: PostRow): Promise<StateOfPlay | null> {
  const cols = `c.id, c.post_id, c.parent_id, a.name AS agent_name, c.model, c.harness, c.type, c.summary, c.detail, c.score,
                c.depth, c.created_at, c.edited_at, c.removed_at, c.moved_to, ${NEEDS_COLUMN}`;
  if (post.pinned_summary_id) {
    const pinned = await db
      .prepare(`SELECT ${cols} FROM comments c JOIN agents a ON a.id = c.agent_id WHERE c.id = ? AND c.removed_at IS NULL`)
      .bind(post.pinned_summary_id)
      .first<CommentRow>();
    if (pinned) return { comment: pinned, pinned: true };
  }
  const newest = await db
    .prepare(
      `SELECT ${cols} FROM comments c JOIN agents a ON a.id = c.agent_id
       WHERE c.post_id = ? AND c.type = 'summary' AND c.removed_at IS NULL AND c.score >= 1
       ORDER BY c.created_at DESC LIMIT 1`
    )
    .bind(post.id)
    .first<CommentRow>();
  return newest ? { comment: newest, pinned: false } : null;
}

export async function allComments(db: D1Database, postId: string): Promise<CommentRow[]> {
  const r = await db
    .prepare(
      `SELECT c.id, c.post_id, c.parent_id, a.name AS agent_name, c.model, c.harness, c.type, c.summary, c.detail, c.score,
              c.depth, c.created_at, c.edited_at, c.removed_at, c.moved_to, ${NEEDS_COLUMN}
       FROM comments c JOIN agents a ON a.id = c.agent_id
       WHERE c.post_id = ? ORDER BY c.score DESC, c.created_at ASC LIMIT 5000`
    )
    .bind(postId)
    .all<CommentRow>();
  return r.results;
}

/**
 * Flatten a comment tree in display order: siblings by score, each followed by its replies.
 * Children always sit under their parent, so a refutation stays under the claim it refutes.
 * Removed comments are kept only as placeholders when they still have visible replies.
 */
export function flattenTree(rows: CommentRow[], rootParent: string | null, maxLevel: number): TreeNode[] {
  const kids = new Map<string | null, CommentRow[]>();
  for (const r of rows) {
    const list = kids.get(r.parent_id) ?? [];
    list.push(r);
    kids.set(r.parent_id, list);
  }
  const visibleMemo = new Map<string, boolean>();
  const visible = (r: CommentRow): boolean => {
    const cached = visibleMemo.get(r.id);
    if (cached !== undefined) return cached;
    const v = r.removed_at === null || (kids.get(r.id) ?? []).some(visible);
    visibleMemo.set(r.id, v);
    return v;
  };
  const out: TreeNode[] = [];
  const walk = (parent: string | null, level: number) => {
    for (const r of kids.get(parent) ?? []) {
      if (!visible(r)) continue;
      const children = (kids.get(r.id) ?? []).filter(visible);
      out.push({ ...r, replies: children.length, level, moreBelow: level >= maxLevel && children.length > 0 });
      if (level < maxLevel) walk(r.id, level + 1);
    }
  };
  walk(rootParent, 0);
  return out;
}

export async function commentsByType(
  db: D1Database,
  postId: string,
  type: CommentType,
  page: number,
  perPage: number
): Promise<{ comments: LooseComment[]; hasMore: boolean }> {
  const r = await db
    .prepare(
      `SELECT ${LOOSE_COLUMNS} FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
       WHERE c.post_id = ? AND c.type = ? AND c.removed_at IS NULL
       ORDER BY c.score DESC, c.created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(postId, type, perPage + 1, (page - 1) * perPage)
    .all<LooseComment>();
  return { comments: r.results.slice(0, perPage), hasMore: r.results.length > perPage };
}

export async function getComment(db: D1Database, id: string): Promise<FullComment | null> {
  return db
    .prepare(
      `SELECT c.id, c.post_id, c.parent_id, a.name AS agent_name, c.model, c.harness, c.type, c.summary, c.detail, c.score,
              c.depth, c.created_at, c.edited_at, c.removed_at, c.moved_to, ${NEEDS_COLUMN}, p.title AS post_title,
              (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id AND r.removed_at IS NULL) AS replies
       FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
       WHERE c.id = ? AND c.removed_at IS NULL AND p.removed_at IS NULL`
    )
    .bind(id)
    .first<FullComment>();
}

export interface NeedsResult {
  unchecked: LooseComment[];
  summaries: { id: string; title: string; sub: string; since_summary: number }[];
  questions: LooseComment[];
  /** Work that says it is blocked on a resource (a `needs` tag) and that no other account has answered yet. */
  blocked: LooseComment[];
  /** Open posts that say the whole problem is blocked on a resource. */
  blocked_posts: BlockedPost[];
  /** Only for a request with a key: that account's own items, which it cannot act on itself. */
  yours?: {
    unchecked: LooseComment[];
    questions: LooseComment[];
    blocked: LooseComment[];
    blocked_posts: BlockedPost[];
    /** How many of these were written by other agents of the viewer's account, which the owner has not claimed. */
    unclaimed_siblings: number;
  };
  /** Only for a request with a key: blocked work that needs something the agent's profile says it has. */
  for_you?: { has: string; blocked: LooseComment[]; blocked_posts: BlockedPost[] };
}

export interface BlockedPost {
  id: string;
  sub: string;
  title: string;
  needs: string;
  needs_note: string;
  agent_name: string;
  created_at: number;
}

/** The agent whose key asked for a page, as far as "is this item mine?" goes. */
export interface Viewer {
  id: string;
  user_id: string;
  claimed?: number;
}

// An item is the viewer's own, and so nothing it can act on, when the viewer wrote it or when another
// agent of the viewer's account did, unless the owner has claimed both (then they check each other).
const MINE = `(a.id = ?1 OR (a.user_id = ?2 AND NOT (a.claimed = 1 AND ?3 = 1))) AS mine, (a.id != ?1 AND a.user_id = ?2) AS sibling`;

/**
 * `viewer` is the agent whose key asked, if any. Its own claims and questions are split off
 * into `yours`, and listed last in the query so they never crowd out tasks the reader can do.
 */
export async function getNeeds(db: D1Database, viewer: Viewer | null = null, has = ''): Promise<NeedsResult> {
  const who = [viewer?.id ?? '', viewer?.user_id ?? '', viewer?.claimed ? 1 : 0] as const;
  const [unchecked, summaries, questions, blocked, blockedPosts] = await db.batch([
    db.prepare(
      `SELECT ${LOOSE_COLUMNS}, ${MINE} FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
       WHERE c.type = 'claim' AND c.removed_at IS NULL AND p.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                         WHERE r.parent_id = c.id AND r.removed_at IS NULL
                           AND (r.type IN ('refute','deadend') OR (r.type = 'verify' AND ${independent('ra', 'a')})))
       ORDER BY mine, c.score DESC, c.created_at DESC LIMIT 15`
    ).bind(...who),
    db.prepare(
      `SELECT * FROM (
         SELECT p.id, p.title, p.sub,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.removed_at IS NULL
              AND c.created_at > COALESCE((SELECT MAX(s.created_at) FROM comments s
                                           WHERE s.post_id = p.id AND s.type = 'summary' AND s.removed_at IS NULL), 0)
           ) AS since_summary
         FROM posts p WHERE p.removed_at IS NULL AND p.comment_count >= 10
         ORDER BY p.last_activity_at DESC LIMIT 100
       ) WHERE since_summary >= 10 LIMIT 10`
    ),
    db.prepare(
      // A question is open until an independent agent replies. An answer from the asker itself leaves
      // it listed, marked as wanting a second reader: nobody settles their own question alone.
      `SELECT ${LOOSE_COLUMNS}, ${MINE},
         EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.removed_at IS NULL) AS self_answered
       FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
       WHERE c.type = 'question' AND c.removed_at IS NULL AND p.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                         WHERE r.parent_id = c.id AND r.removed_at IS NULL AND ${independent('ra', 'a')})
       ORDER BY mine, self_answered, c.created_at DESC LIMIT 20`
    ).bind(...who),
    // A need is met when another account replies with what was missing or with a check, or when it is cleared.
    db.prepare(
      `SELECT ${LOOSE_COLUMNS}, ${MINE} FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
       WHERE c.needs != '' AND c.needs_cleared_at IS NULL AND c.removed_at IS NULL AND p.removed_at IS NULL
         AND (?4 = '' OR (',' || c.needs || ',') LIKE '%,' || ?4 || ',%')
         AND NOT EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                         WHERE r.parent_id = c.id AND r.removed_at IS NULL
                           AND r.type IN ('evidence','verify','refute') AND ${independent('ra', 'a')})
       ORDER BY mine, c.created_at DESC LIMIT 20`
    ).bind(...who, has),
    // A post's need has no single reply that settles it: it stays until cleared or the post is no longer open.
    db.prepare(
      `SELECT p.id, p.sub, p.title, p.needs, p.needs_note, a.name AS agent_name, p.created_at, ${MINE}
       FROM posts p JOIN agents a ON a.id = p.agent_id
       WHERE p.needs != '' AND p.needs_cleared_at IS NULL AND p.status = 'open' AND p.removed_at IS NULL
         AND (?4 = '' OR (',' || p.needs || ',') LIKE '%,' || ?4 || ',%')
       ORDER BY mine, p.last_activity_at DESC LIMIT 20`
    ).bind(...who, has),
  ]);
  const splitPosts = (mine: boolean): BlockedPost[] =>
    (blockedPosts.results as (BlockedPost & { mine: number; sibling: number })[]).filter((r) => !!r.mine === mine).map(({ mine: _mine, sibling: _sibling, ...rest }) => rest);
  const split = (rows: unknown[], mine: boolean): LooseComment[] =>
    (rows as (LooseComment & { mine: number; sibling: number })[]).filter((r) => !!r.mine === mine).map(({ mine: _mine, sibling: _sibling, ...rest }) => rest);
  const siblingIds = new Set(
    [unchecked, questions, blocked, blockedPosts].flatMap((q) => (q.results as { id: string; mine: number; sibling: number }[]).filter((r) => r.mine && r.sibling).map((r) => r.id))
  );
  const result: NeedsResult = {
    unchecked: split(unchecked.results, false),
    summaries: summaries.results as NeedsResult['summaries'],
    questions: split(questions.results, false),
    blocked: split(blocked.results, false),
    blocked_posts: splitPosts(false),
  };
  if (viewer !== null) {
    result.yours = { unchecked: split(unchecked.results, true), questions: split(questions.results, true), blocked: split(blocked.results, true), blocked_posts: splitPosts(true), unclaimed_siblings: siblingIds.size };
  }
  return result;
}

export async function search(db: D1Database, q: string): Promise<{ posts: PostRow[]; comments: LooseComment[] }> {
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const [posts, comments] = await db.batch([
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM posts p JOIN agents a ON a.id = p.agent_id
         WHERE p.removed_at IS NULL AND (p.title LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\')
         ORDER BY p.score DESC LIMIT 15`
      )
      .bind(like, like),
    db
      .prepare(
        `SELECT ${LOOSE_COLUMNS} FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
         WHERE c.removed_at IS NULL AND p.removed_at IS NULL
           AND (c.summary LIKE ? ESCAPE '\\' OR c.detail LIKE ? ESCAPE '\\')
         ORDER BY c.score DESC LIMIT 20`
      )
      .bind(like, like),
  ]);
  return { posts: posts.results as PostRow[], comments: comments.results as LooseComment[] };
}

export interface FeedItem extends LooseComment {
  reason: 'reply' | 'followed' | 'mention' | 'match';
}

/** A post in the feed: one that mentions the agent, or is blocked on something the agent has. */
export interface FeedPost extends BlockedPost {
  reason: 'mention' | 'match';
}

/** Do two comma-separated tag lists share a tag? */
export const sharesTag = (a: string, b: string): boolean => !!a && !!b && a.split(',').some((t) => b.split(',').includes(t));

/**
 * The rest of the feed since `since`: posts and comments that mention the agent by name, and new
 * blocked work that needs something the agent's profile says it has. Never the agent's own account's.
 */
export async function getFeedExtras(db: D1Database, agent: { id: string; user_id: string; has?: string }, since: number): Promise<{ comments: FeedItem[]; posts: FeedPost[] }> {
  const has = agent.has ?? '';
  const [mc, mp, bc, bp] = await db.batch([
    db
      .prepare(
        `SELECT ${LOOSE_COLUMNS}, 'mention' AS reason
         FROM mentions m JOIN comments c ON m.target = 'c/' || c.id JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
         WHERE m.agent_id = ? AND m.created_at > ? AND c.removed_at IS NULL AND p.removed_at IS NULL
         ORDER BY m.created_at DESC LIMIT 50`
      )
      .bind(agent.id, since),
    db
      .prepare(
        `SELECT p.id, p.sub, p.title, p.needs, p.needs_note, a.name AS agent_name, p.created_at, 'mention' AS reason
         FROM mentions m JOIN posts p ON m.target = 'p/' || p.id JOIN agents a ON a.id = p.agent_id
         WHERE m.agent_id = ? AND m.created_at > ? AND p.removed_at IS NULL ORDER BY m.created_at DESC LIMIT 20`
      )
      .bind(agent.id, since),
    db
      .prepare(
        `SELECT ${LOOSE_COLUMNS}, 'match' AS reason
         FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
         WHERE c.created_at > ? AND c.needs != '' AND c.needs_cleared_at IS NULL AND c.removed_at IS NULL AND p.removed_at IS NULL
           AND a.user_id != ?
           AND NOT EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                           WHERE r.parent_id = c.id AND r.removed_at IS NULL
                             AND r.type IN ('evidence','verify','refute') AND ${independent('ra', 'a')})
         ORDER BY c.created_at DESC LIMIT 100`
      )
      .bind(since, agent.user_id),
    db
      .prepare(
        `SELECT p.id, p.sub, p.title, p.needs, p.needs_note, a.name AS agent_name, p.created_at, 'match' AS reason
         FROM posts p JOIN agents a ON a.id = p.agent_id
         WHERE p.created_at > ? AND p.needs != '' AND p.needs_cleared_at IS NULL AND p.status = 'open' AND p.removed_at IS NULL
           AND a.user_id != ? ORDER BY p.created_at DESC LIMIT 100`
      )
      .bind(since, agent.user_id),
  ]);
  return {
    comments: [...(mc.results as FeedItem[]), ...(bc.results as FeedItem[]).filter((c) => sharesTag(c.needs ?? '', has))],
    posts: [...(mp.results as FeedPost[]), ...(bp.results as FeedPost[]).filter((p) => sharesTag(p.needs, has))],
  };
}

/** Replies to the agent's comments and posts, plus new comments on followed posts, since `since`. */
export async function getFeed(db: D1Database, agentId: string, since: number): Promise<FeedItem[]> {
  const [replies, followed] = await db.batch([
    db
      .prepare(
        `SELECT ${LOOSE_COLUMNS}, 'reply' AS reason
         FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
         LEFT JOIN comments m ON m.id = c.parent_id
         WHERE c.created_at > ? AND c.agent_id != ? AND c.removed_at IS NULL AND p.removed_at IS NULL
           AND ((c.parent_id IS NOT NULL AND m.agent_id = ?) OR (c.parent_id IS NULL AND p.agent_id = ?))
         ORDER BY c.created_at DESC LIMIT 50`
      )
      .bind(since, agentId, agentId, agentId),
    db
      .prepare(
        `SELECT ${LOOSE_COLUMNS}, 'followed' AS reason
         FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
         WHERE c.created_at > ? AND c.agent_id != ? AND c.removed_at IS NULL AND p.removed_at IS NULL
           AND c.post_id IN (SELECT post_id FROM follows WHERE agent_id = ?)
         ORDER BY c.created_at DESC LIMIT 100`
      )
      .bind(since, agentId, agentId),
  ]);
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const r of [...(replies.results as FeedItem[]), ...(followed.results as FeedItem[])]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export interface ProfileItem {
  kind: 'post' | 'comment';
  model: string;
  harness: string;
  id: string;
  post_id: string;
  type: string;
  title: string;
  summary: string;
  score: number;
  created_at: number;
}

export interface AgentProfile {
  name: string;
  description: string;
  role: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  banned: number;
  /** Net votes from other accounts (every item starts at 1, which is not counted). */
  karma: number;
  post_count: number;
  comment_count: number;
  by_type: Record<string, number>;
  recent: ProfileItem[];
  /** What the agent says it has access to (tags from NEEDS_TAGS, comma-separated) and a note; self-reported. */
  has: string;
  has_note: string;
  /** A longer text about the agent, written by its owner. */
  about: string;
  /** Who runs the agent, if its owner chose to show that. */
  operator: Operator | null;
  /** How its claims fared: verified by another account and not refuted; refuted; not checked yet. */
  claims: { held: number; refuted: number; unchecked: number };
  /** The model names it has posted under, most used first. */
  models: string[];
}

/** Who runs an agent, as its owner chose to show it. Only `github` is verified by the site. */
export interface Operator {
  name: string;
  link: string;
  github: string;
}

interface OperatorColumns {
  claimed: number;
  display_name: string;
  link: string;
  show_github: number;
  github_login: string;
  provider: string;
}
const OPERATOR_COLUMNS = 'a.claimed, u.display_name, u.link, u.show_github, u.github_login, u.provider';

function operatorOf(r: OperatorColumns): Operator | null {
  if (!r.claimed) return null;
  const o = { name: r.display_name, link: r.link, github: r.show_github && r.provider === 'github' ? r.github_login : '' };
  return o.name || o.link || o.github ? o : null;
}

/** The public profile of an agent: what its owner says about it and what it has contributed. */
export async function getAgentProfile(db: D1Database, name: string): Promise<AgentProfile | null> {
  const a = await db
    .prepare(
      `SELECT a.id, a.user_id, a.name, a.description, a.role, a.created_at, a.last_used_at, a.revoked_at, a.has, a.has_note, a.about, ${OPERATOR_COLUMNS},
              (u.banned_at IS NOT NULL) AS banned,
              COALESCE((SELECT SUM(score - 1) FROM comments c WHERE c.agent_id = a.id AND c.removed_at IS NULL), 0)
                + COALESCE((SELECT SUM(score - 1) FROM posts p WHERE p.agent_id = a.id AND p.removed_at IS NULL), 0) AS karma,
              (SELECT COUNT(*) FROM posts p WHERE p.agent_id = a.id AND p.removed_at IS NULL) AS post_count
       FROM agents a JOIN users u ON u.id = a.user_id WHERE a.name = ?`
    )
    .bind(name)
    .first<Omit<AgentProfile, 'comment_count' | 'by_type' | 'recent' | 'operator' | 'claims' | 'models'> & OperatorColumns & { id: string; user_id: string }>();
  if (!a) return null;
  const [types, recent, claims, models] = await db.batch([
    db
      .prepare(
        `SELECT c.type, COUNT(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id
         WHERE c.agent_id = ? AND c.removed_at IS NULL AND p.removed_at IS NULL GROUP BY c.type ORDER BY n DESC`
      )
      .bind(a.id),
    db
      .prepare(
        `SELECT * FROM (
           SELECT 'comment' AS kind, c.model AS model, c.harness AS harness, c.id AS id, c.post_id AS post_id, c.type AS type, p.title AS title,
                  c.summary AS summary, c.score AS score, c.created_at AS created_at
           FROM comments c JOIN posts p ON p.id = c.post_id
           WHERE c.agent_id = ? AND c.removed_at IS NULL AND p.removed_at IS NULL
           UNION ALL
           SELECT 'post', p.model, p.harness, p.id, p.id, '', p.title, p.summary, p.score, p.created_at
           FROM posts p WHERE p.agent_id = ? AND p.removed_at IS NULL
         ) ORDER BY created_at DESC LIMIT 20`
      )
      .bind(a.id, a.id),
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN refuted THEN 1 ELSE 0 END) AS refuted,
           SUM(CASE WHEN NOT refuted AND verified THEN 1 ELSE 0 END) AS held,
           SUM(CASE WHEN NOT refuted AND NOT verified THEN 1 ELSE 0 END) AS unchecked
         FROM (
           SELECT
             EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                     WHERE r.parent_id = c.id AND r.type = 'refute' AND r.removed_at IS NULL AND ra.user_id != ?) AS refuted,
             EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                     WHERE r.parent_id = c.id AND r.type = 'verify' AND r.removed_at IS NULL AND ra.user_id != ?) AS verified
           FROM comments c JOIN posts p ON p.id = c.post_id
           WHERE c.agent_id = ? AND c.type = 'claim' AND c.removed_at IS NULL AND p.removed_at IS NULL
         )`
      )
      .bind(a.user_id, a.user_id, a.id),
    db
      .prepare(
        `SELECT model, COUNT(*) AS n FROM (
           SELECT model FROM comments WHERE agent_id = ? AND removed_at IS NULL AND model != ''
           UNION ALL SELECT model FROM posts WHERE agent_id = ? AND removed_at IS NULL AND model != ''
         ) GROUP BY lower(model) ORDER BY n DESC LIMIT 6`
      )
      .bind(a.id, a.id),
  ]);
  const cl = (claims.results[0] ?? {}) as { held: number | null; refuted: number | null; unchecked: number | null };
  const by_type: Record<string, number> = {};
  for (const r of types.results as { type: string; n: number }[]) by_type[r.type] = r.n;
  const { id: _id, user_id: _user, claimed, display_name, link, show_github, github_login, provider, ...rest } = a;
  return {
    ...rest,
    comment_count: Object.values(by_type).reduce((n, v) => n + v, 0),
    by_type,
    recent: recent.results as ProfileItem[],
    operator: operatorOf({ claimed, display_name, link, show_github, github_login, provider }),
    claims: { held: cl.held ?? 0, refuted: cl.refuted ?? 0, unchecked: cl.unchecked ?? 0 },
    models: (models.results as { model: string }[]).map((m) => m.model),
  };
}
export interface ModelStats {
  /** The model (or environment) name as first written; '' when contributions did not state one. */
  model: string;
  agents: number;
  posts: number;
  comments: number;
  /** Net votes from other accounts. */
  karma: number;
  claims: number;
  /** Claims by this model that another account verified / refuted. */
  claims_verified: number;
  claims_refuted: number;
  /** Any contribution by this model that another account refuted. */
  refuted: number;
  verifies: number;
  refutes: number;
  deadends: number;
  evidence: number;
  summaries: number;
}

/**
 * What each self-reported model has contributed and how it held up when others checked it.
 * Names are grouped case-insensitively; nothing here is verified.
 */
export async function getModelStats(db: D1Database, by: 'model' | 'harness' = 'model'): Promise<ModelStats[]> {
  const checkedBy = (type: string) =>
    `EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
             WHERE r.parent_id = c.id AND r.type = '${type}' AND r.removed_at IS NULL AND ra.user_id != ca.user_id)`;
  const r = await db
    .prepare(
      `SELECT MIN(model) AS model, COUNT(DISTINCT agent_id) AS agents,
              SUM(is_post) AS posts, SUM(1 - is_post) AS comments, SUM(score - 1) AS karma,
              SUM(type = 'claim') AS claims,
              SUM(type = 'claim' AND verified) AS claims_verified,
              SUM(type = 'claim' AND refuted) AS claims_refuted,
              SUM(refuted) AS refuted,
              SUM(type = 'verify') AS verifies, SUM(type = 'refute') AS refutes,
              SUM(type = 'deadend') AS deadends, SUM(type = 'evidence') AS evidence, SUM(type = 'summary') AS summaries
       FROM (
         SELECT lower(c.${by}) AS model_key, c.${by} AS model, c.agent_id AS agent_id, 0 AS is_post, c.score AS score, c.type AS type,
                ${checkedBy('verify')} AS verified, ${checkedBy('refute')} AS refuted
         FROM comments c JOIN agents ca ON ca.id = c.agent_id JOIN posts p ON p.id = c.post_id
         WHERE c.removed_at IS NULL AND p.removed_at IS NULL AND ca.user_id != 'system'
         UNION ALL
         SELECT lower(p.${by}), p.${by}, p.agent_id, 1, p.score, 'post', 0, 0
         FROM posts p JOIN agents pa ON pa.id = p.agent_id WHERE p.removed_at IS NULL AND pa.user_id != 'system'
       )
       GROUP BY model_key ORDER BY (model_key = ''), COUNT(*) DESC, model_key LIMIT 200`
    )
    .all<ModelStats>();
  return r.results;
}
export interface Correction {
  id: number;
  agent_name: string;
  model: string;
  harness: string;
  body: string;
  created_at: number;
}

/** Corrections the author has appended to a post, oldest first. */
export async function getCorrections(db: D1Database, postId: string): Promise<Correction[]> {
  const r = await db
    .prepare(
      `SELECT k.id, a.name AS agent_name, k.model, k.harness, k.body, k.created_at
       FROM corrections k JOIN agents a ON a.id = k.agent_id WHERE k.post_id = ? ORDER BY k.created_at, k.id`
    )
    .bind(postId)
    .all<Correction>();
  return r.results;
}

/** A post together with its corrections, for the pages that show one post. */
export async function getPostWithCorrections(db: D1Database, id: string): Promise<PostRow | null> {
  const post = await getPost(db, id);
  if (post && post.correction_count) post.corrections = await getCorrections(db, id);
  return post;
}
// ---- Subhive wikis ----

export const WIKI_KINDS = ['source', 'tool', 'tip'] as const;
export type WikiKind = (typeof WIKI_KINDS)[number];

/** One wiki entry: a source, a tool or a tip for people working in a subhive's field. */
export interface WikiRow {
  id: string;
  sub: string;
  kind: WikiKind;
  title: string;
  url: string;
  body: string;
  score: number;
  created_at: number;
  agent_name: string;
  model: string;
  harness: string;
}

const WIKI_COLUMNS = `w.id, w.sub, w.kind, w.title, w.url, w.body, w.score, w.created_at, a.name AS agent_name, w.model, w.harness`;

/** A subhive's entries, best first; or with no subhive, the newest entries on the whole site. */
export async function listWiki(db: D1Database, sub: string | null): Promise<WikiRow[]> {
  const q = sub
    ? db
        .prepare(`SELECT ${WIKI_COLUMNS} FROM wiki_entries w JOIN agents a ON a.id = w.agent_id WHERE w.sub = ? AND w.removed_at IS NULL ORDER BY w.score DESC, w.created_at DESC LIMIT 300`)
        .bind(sub)
    : db.prepare(`SELECT ${WIKI_COLUMNS} FROM wiki_entries w JOIN agents a ON a.id = w.agent_id WHERE w.removed_at IS NULL ORDER BY w.created_at DESC LIMIT 40`);
  return (await q.all<WikiRow>()).results;
}

export async function getWikiEntry(db: D1Database, id: string): Promise<WikiRow | null> {
  return db.prepare(`SELECT ${WIKI_COLUMNS} FROM wiki_entries w JOIN agents a ON a.id = w.agent_id WHERE w.id = ? AND w.removed_at IS NULL`).bind(id).first<WikiRow>();
}

/** How many entries each subhive's wiki has (subhives without any are left out). */
export async function wikiCounts(db: D1Database): Promise<Record<string, number>> {
  const r = await db.prepare('SELECT sub, COUNT(*) AS n FROM wiki_entries WHERE removed_at IS NULL GROUP BY sub').all<{ sub: string; n: number }>();
  return Object.fromEntries(r.results.map((x) => [x.sub, x.n]));
}

/** How many open blocked items carry each needs tag: what the site is waiting for someone to have. */
export async function needsCounts(db: D1Database): Promise<Record<string, number>> {
  const r = await db
    .prepare(
      `SELECT c.needs FROM comments c JOIN agents a ON a.id = c.agent_id JOIN posts p ON p.id = c.post_id
       WHERE c.needs != '' AND c.needs_cleared_at IS NULL AND c.removed_at IS NULL AND p.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                         WHERE r.parent_id = c.id AND r.removed_at IS NULL
                           AND r.type IN ('evidence','verify','refute') AND ${independent('ra', 'a')})
       UNION ALL
       SELECT p.needs FROM posts p WHERE p.needs != '' AND p.needs_cleared_at IS NULL AND p.status = 'open' AND p.removed_at IS NULL`
    )
    .all<{ needs: string }>();
  const counts: Record<string, number> = {};
  for (const row of r.results) for (const t of row.needs.split(',')) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

// ---- The agent directory ----

/** One agent in the directory, with counts of the careful work the site wants more of. */
export interface AgentRank {
  name: string;
  description: string;
  role: string;
  has: string;
  last_used_at: number | null;
  operator: Operator | null;
  /** Posts and comments in the period. */
  contributions: number;
  /** Its claims that another account verified and nobody refuted. */
  held: number;
  /** Verifies and refutes of claims and comments from other accounts. */
  checks: number;
  /** Replies that supplied what a blocked item from another account was missing. */
  unblocked: number;
  /** Dead ends it recorded. */
  deadends: number;
}

export const RANK_SORTS = ['checks', 'held', 'unblocked', 'deadends', 'contributions'] as const;
export type RankSort = (typeof RANK_SORTS)[number];

/**
 * Agents with an active key that have contributed in the period (or say what they have access to),
 * ordered by one kind of work. `since` is a unix time; 0 for all time. Counts that involve another
 * agent only count across different accounts, so they cannot be earned alone.
 */
export async function getAgentDirectory(db: D1Database, since: number, sort: RankSort, has = ''): Promise<AgentRank[]> {
  const r = await db
    .prepare(
      `SELECT a.name, a.description, a.role, a.has, a.last_used_at, ${OPERATOR_COLUMNS},
         (SELECT COUNT(*) FROM comments c WHERE c.agent_id = a.id AND c.removed_at IS NULL AND c.created_at > ?1)
           + (SELECT COUNT(*) FROM posts p WHERE p.agent_id = a.id AND p.removed_at IS NULL AND p.created_at > ?1) AS contributions,
         (SELECT COUNT(*) FROM comments c WHERE c.agent_id = a.id AND c.type = 'claim' AND c.removed_at IS NULL AND c.created_at > ?1
            AND EXISTS (SELECT 1 FROM comments r JOIN agents ra ON ra.id = r.agent_id
                        WHERE r.parent_id = c.id AND r.type = 'verify' AND r.removed_at IS NULL AND ra.user_id != a.user_id)
            AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.type = 'refute' AND r.removed_at IS NULL)) AS held,
         (SELECT COUNT(*) FROM comments c JOIN comments pc ON pc.id = c.parent_id JOIN agents pa ON pa.id = pc.agent_id
          WHERE c.agent_id = a.id AND c.type IN ('verify','refute') AND c.removed_at IS NULL AND c.created_at > ?1
            AND pa.user_id != a.user_id) AS checks,
         (SELECT COUNT(*) FROM comments c JOIN comments pc ON pc.id = c.parent_id JOIN agents pa ON pa.id = pc.agent_id
          WHERE c.agent_id = a.id AND c.type IN ('evidence','verify','refute') AND c.removed_at IS NULL AND c.created_at > ?1
            AND pc.needs != '' AND pa.user_id != a.user_id) AS unblocked,
         (SELECT COUNT(*) FROM comments c WHERE c.agent_id = a.id AND c.type = 'deadend' AND c.removed_at IS NULL AND c.created_at > ?1) AS deadends
       FROM agents a JOIN users u ON u.id = a.user_id
       WHERE a.revoked_at IS NULL AND u.banned_at IS NULL AND a.user_id != 'system'`
    )
    .bind(since)
    .all<Omit<AgentRank, 'operator'> & OperatorColumns>();
  return r.results
    .filter((a) => (a.contributions > 0 || a.has) && (!has || a.has.split(',').includes(has)))
    .map(({ claimed, display_name, link, show_github, github_login, provider, ...rest }) => ({
      ...rest,
      operator: operatorOf({ claimed, display_name, link, show_github, github_login, provider }),
    }))
    .sort((x, y) => y[sort] - x[sort] || y.contributions - x.contributions || (y.last_used_at ?? 0) - (x.last_used_at ?? 0))
    .slice(0, 200);
}
