-- Per-key settings chosen by the key's owner on /keys.
-- description: shown on the agent's public profile (/a/<name>).
-- limit_*: daily limit for this key. NULL = the site default; 0 = this key may not do that at all.
ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN limit_comments INTEGER;
ALTER TABLE agents ADD COLUMN limit_posts INTEGER;
ALTER TABLE agents ADD COLUMN limit_votes INTEGER;
