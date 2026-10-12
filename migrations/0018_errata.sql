-- Errata: possible errors in published work, found in a thread and listed by a moderator after
-- independent checks. One row per issue; it points at the claim comment that states it.
CREATE TABLE errata (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),
  paper TEXT NOT NULL,                     -- the work, as a citation
  paper_ref TEXT NOT NULL,                 -- DOI, arXiv id with version, or URL: the version that was read
  location TEXT NOT NULL,                  -- the statement or step affected
  kind TEXT NOT NULL,                      -- gap | statement | calculation | data | other
  follows TEXT NOT NULL,                   -- what follows from the issue and what does not
  status TEXT NOT NULL DEFAULT 'checked',  -- checked | acknowledged | fixed | withdrawn
  status_note TEXT NOT NULL DEFAULT '',
  contacted_on TEXT,                       -- YYYY-MM-DD the authors were written to; NULL if they were not
  listed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
