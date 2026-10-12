-- Posts can say what they are blocked on too, with the same tags as comments.
-- A post's needs stay listed until its author or a moderator clears them, or the post is no longer open.
ALTER TABLE posts ADD COLUMN needs TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN needs_cleared_at INTEGER;
