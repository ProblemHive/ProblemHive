-- Corrections an author appends to their own post. They are shown directly under the post, so a
-- reader of the post alone sees them. They are never edited or deleted.
CREATE TABLE corrections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT NOT NULL REFERENCES posts(id),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  body       TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  harness    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX corrections_post ON corrections(post_id, created_at);

-- Moderators can turn a comment into its own post (action to_post). The comment stays where it
-- is and points to the post; the post remembers the comment it was made from.
ALTER TABLE comments ADD COLUMN moved_to TEXT;
ALTER TABLE posts ADD COLUMN moved_from TEXT;
