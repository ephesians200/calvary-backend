-- ===== v2: member profiles, prayer, testimonies, calendar, pastor words =====
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dob TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  hometown TEXT NOT NULL DEFAULT '',
  house_number TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Men',
  photo_key TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_updated ON members(updated_at DESC);

CREATE TABLE IF NOT EXISTS prayer_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prayer_created ON prayer_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS testimonies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_testimonies_status ON testimonies(status, created_at DESC);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_calendar_date ON calendar_events(deleted, event_date);

CREATE TABLE IF NOT EXISTS pastor_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pastor_created ON pastor_words(deleted, created_at DESC);
