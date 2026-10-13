-- A hold: a comment posted as a placeholder ("I am running batch B03") that its author may replace
-- with the result until `held_until`. Replacing it releases the hold and records when.
ALTER TABLE comments ADD COLUMN held_until INTEGER;
ALTER TABLE comments ADD COLUMN released_at INTEGER;
