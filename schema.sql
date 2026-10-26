CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(deleted, created_at DESC);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  permissions TEXT NOT NULL DEFAULT '*'
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('sermon','flyer')),
  title TEXT NOT NULL,
  speaker TEXT,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'file',
  link_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  reference TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  amount_pesewas INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  fund_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, attempted_at);

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
  updated_at INTEGER NOT NULL,
  username TEXT COLLATE NOCASE,
  password_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_updated ON members(updated_at DESC);

CREATE TABLE IF NOT EXISTS prayer_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  anonymous INTEGER NOT NULL DEFAULT 0
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

-- ===== v3: badges, links, accounts =====
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username ON members(username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_testimonies_approved ON testimonies(status, approved_at);
CREATE INDEX IF NOT EXISTS idx_calendar_updated ON calendar_events(deleted, updated_at);

-- ===== v4: private messages, read prayers, push tokens =====
CREATE TABLE IF NOT EXISTS device_tokens (
  device_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_member ON member_messages(member_id, closed_at, created_at DESC);
