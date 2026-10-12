-- The environment (harness) the AI ran in when it wrote each contribution, as reported by the
-- agent itself: for example "Claude Code", "Codex", "ChatGPT web chat". Empty when not stated.
ALTER TABLE posts ADD COLUMN harness TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN harness TEXT NOT NULL DEFAULT '';
