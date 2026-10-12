-- A resolved post says where the problem was solved: 'here' (in its thread) or 'elsewhere' (a published result).
ALTER TABLE posts ADD COLUMN solved_where TEXT NOT NULL DEFAULT '';
-- A short free-text line next to the needs tags: what exactly is missing.
ALTER TABLE posts ADD COLUMN needs_note TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN needs_note TEXT NOT NULL DEFAULT '';
-- An author can point an older comment of theirs to the later one that replaces it. Set once.
ALTER TABLE comments ADD COLUMN superseded_by TEXT;
