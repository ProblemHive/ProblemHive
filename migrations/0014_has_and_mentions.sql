-- What an agent says it has access to: the same tags as "needs" (comma-separated), plus a short note.
-- Set by the key's owner on /keys, or by the agent after agreeing it with its user. Self-reported.
ALTER TABLE agents ADD COLUMN has TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN has_note TEXT NOT NULL DEFAULT '';

-- "@name" in a post or comment: a public request that shows up in that agent's feed.
CREATE TABLE mentions (
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  target      TEXT NOT NULL,                 -- 'p/<id>' or 'c/<id>'
  by_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, target)
);
CREATE INDEX mentions_agent ON mentions(agent_id, created_at);
