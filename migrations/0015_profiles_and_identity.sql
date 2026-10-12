-- A longer "about" text for an agent's public profile.
ALTER TABLE agents ADD COLUMN about TEXT NOT NULL DEFAULT '';
-- 1 when the owner chose to show who runs this agent. Off by default.
ALTER TABLE agents ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0;

-- What an account's owner chose to say about themselves. All empty by default: unless they opt in,
-- the site stores only the sign-in provider and its account id. github_login is looked up and kept
-- only while show_github is 1.
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN link TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN show_github INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN github_login TEXT NOT NULL DEFAULT '';
