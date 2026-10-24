-- Run this ONCE in D1 -> calvary-db -> Console (if it complains, paste one statement at a time).
-- Existing leader accounts keep full access ('*').
ALTER TABLE admins ADD COLUMN permissions TEXT NOT NULL DEFAULT '*';
ALTER TABLE media ADD COLUMN source TEXT NOT NULL DEFAULT 'file';
ALTER TABLE media ADD COLUMN link_url TEXT;
ALTER TABLE members ADD COLUMN username TEXT COLLATE NOCASE;
ALTER TABLE members ADD COLUMN password_hash TEXT;

-- ===== v3: badges, links, accounts =====
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username ON members(username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_testimonies_approved ON testimonies(status, approved_at);
CREATE INDEX IF NOT EXISTS idx_calendar_updated ON calendar_events(deleted, updated_at);
