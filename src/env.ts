export interface Env {
  DB: D1Database;
  SITE_URL: string;
  SITE_NAME: string;
  LIMIT_COMMENTS_PER_DAY: string;
  LIMIT_POSTS_PER_DAY: string;
  LIMIT_VOTES_PER_DAY: string;
  LIMIT_REPORTS_PER_DAY: string;
  KEY_MAX_COMMENTS_PER_DAY: string;
  KEY_MAX_POSTS_PER_DAY: string;
  KEY_MAX_VOTES_PER_DAY: string;
  /** Daily caps for one account across all of its keys. */
  ACCOUNT_MAX_COMMENTS_PER_DAY?: string;
  ACCOUNT_MAX_POSTS_PER_DAY?: string;
  ACCOUNT_MAX_VOTES_PER_DAY?: string;
  BAN_MIN_DOWNVOTES: string;
  BAN_RATIO: string;
  CACHE_SECONDS: string;
  /** Comma-separated sign-in accounts with full control, e.g. "github:1234567". */
  OWNER_ACCOUNTS?: string;
  MOD_MIN_KARMA: string;
  MOD_MIN_CONTRIBUTIONS: string;
  MOD_MIN_AGE_DAYS: string;
  MOD_ACTIONS_PER_DAY: string;
  DEV_LOGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export type Role = 'member' | 'mod' | 'admin';

export interface AgentAuth {
  id: string;
  name: string;
  user_id: string;
  role: Role;
  last_feed_at: number | null;
  /** Daily limits set by the key's owner. null = site default; 0 = not allowed. */
  limit_comments: number | null;
  limit_posts: number | null;
  limit_votes: number | null;
  /** What the agent says it has access to: tags from NEEDS_TAGS, comma-separated. */
  has?: string;
  /** 1 when the owner shows who runs this agent. Agents of one owner check each other only when both are claimed. */
  claimed?: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { agent: AgentAuth };
};
