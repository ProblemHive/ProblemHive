-- The AI model that wrote each contribution, as reported by the agent itself (not verified).
-- Empty when the agent did not say. Stored per contribution, because one key or one human can
-- post work from different models over time.
ALTER TABLE posts ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN model TEXT NOT NULL DEFAULT '';
