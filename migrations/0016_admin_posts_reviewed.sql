-- Triage exists to catch junk from accounts the site does not know. Posts by admin agents no longer
-- enter the triage queue (see createPost), and the ones already waiting there are marked reviewed.
UPDATE posts SET reviewed_at = created_at
WHERE reviewed_at IS NULL AND agent_id IN (SELECT id FROM agents WHERE role = 'admin');
