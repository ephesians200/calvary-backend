import { json, fail, readJson, clean, toHex } from './util.js';
import { requireAdmin, can, verifyPassword, hashPassword } from './auth.js';
import { sendTopicPush } from './fcm.js';
import { sendToTokens } from './direct.js';

const GROUPS = ['Men', 'Women', 'Youth'];
const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PHOTO_BYTES = 1_500_000;
const DAILY_LIMIT = 10; // prayer requests / testimonies per device per day

const push = (ctx, env, type, title, body) =>
  ctx.waitUntil(sendTopicPush(env, { type, title, body }).catch((e) => console.error('push failed', e.message)));

async function photoKey(deviceId) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceId));
  return `member/${toHex(hash).slice(0, 40)}.jpg`;
}

const deviceId = (request) => {
  const id = request.headers.get('x-device-id') || '';
  return DEVICE_RE.test(id) ? id : null;
};

const idFrom = (s) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Returns a Response when the path belongs to this module, otherwise null. */
export async function portalRoute(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;
  const m = (verb, path) => method === verb && pathname === path;

  // ---------- member (public) ----------
  if (m('PUT', '/api/members/me')) return saveProfile(request, env);
  if (m('GET', '/api/members/me')) return getProfile(request, env);
  if (m('PUT', '/api/members/photo')) return savePhoto(request, env);
  if (m('POST', '/api/prayer-requests')) return submitPrayer(request, env);
  if (m('GET', '/api/testimonies')) return listTestimonies(env);
  if (m('POST', '/api/testimonies')) return submitTestimony(request, env);
  if (m('GET', '/api/calendar')) return listCalendar(url, env);
  if (m('GET', '/api/pastor-words')) return listPastorWords(env);
  if (m('GET', '/api/updates')) return updates(url, env);
  if (m('POST', '/api/members/login')) return memberLogin(request, env);
  if (m('PUT', '/api/members/push-token')) return savePushToken(request, env);
  if (m('GET', '/api/members/messages')) return myMessages(request, env);
  if (m('POST', '/api/members/messages/close')) return closeMessage(request, env);

  // ---------- leader (JWT) ----------
  const adminPath = pathname.startsWith('/api/admin/') &&
    (/^\/api\/admin\/(members|messages|prayer-requests|testimonies|calendar|pastor-words|badges)/.test(pathname));
  if (!adminPath) return null;

  const admin = await requireAdmin(request, env);
  if (!admin) return fail('Unauthorized', 401);
  const parts = pathname.split('/').filter(Boolean); // api, admin, <resource>, <id?>, <action?>
  const resource = parts[2];
  const id = parts[3] && parts[3] !== 'seen' ? idFrom(parts[3]) : null;
  const action = parts[3] === 'seen' ? 'seen' : parts[4];

  if (resource === 'badges' && method === 'GET') return badges(env, admin);

  const needed = { members: 'members', messages: 'members', 'prayer-requests': 'prayer', testimonies: 'testimonies', calendar: 'calendar', 'pastor-words': 'pastor' }[resource];
  if (!can(admin, needed)) return fail('You do not have access to this', 403);

  if (resource === 'members') {
    if (method === 'GET' && !id) return adminListMembers(env);
    if (method === 'GET' && id && action === 'photo') return adminMemberPhoto(env, id);
    if (method === 'POST' && parts[3] === 'seen') return markSeen(env, 'members');
    if (method === 'GET' && id && action === 'messages') return adminMemberMessages(env, id);
  }
  if (resource === 'messages' && method === 'POST' && !id) return sendMessages(request, env, ctx, admin);
  if (resource === 'prayer-requests') {
    if (method === 'GET' && !id) return adminListPrayer(env);
    if (method === 'POST' && parts[3] === 'seen') return markSeen(env, 'prayer_requests');
    if (method === 'POST' && parts[3] === 'delete') return deletePrayerMany(request, env);
    if (method === 'POST' && id && action === 'read') return markPrayerRead(env, ctx, id);
    if (method === 'DELETE' && id) return removeRow(env, 'prayer_requests', id);
  }
  if (resource === 'testimonies') {
    if (method === 'GET' && !id) return adminListTestimonies(env);
    if (method === 'POST' && id && action === 'approve') return approveTestimony(env, ctx, id, true);
    if (method === 'POST' && id && action === 'unapprove') return approveTestimony(env, ctx, id, false);
    if (method === 'DELETE' && id) return removeRow(env, 'testimonies', id);
  }
  if (resource === 'calendar') {
    if (method === 'POST' && !id) return createEvent(request, env, ctx, admin);
    if (method === 'PUT' && id) return updateEvent(request, env, ctx, id);
    if (method === 'DELETE' && id) return deleteEvent(env, id);
  }
  if (resource === 'pastor-words') {
    if (method === 'POST' && !id) return createPastorWord(request, env, ctx, admin);
    if (method === 'PUT' && id) return updatePastorWord(request, env, id);
    if (method === 'DELETE' && id) return deletePastorWord(env, id);
  }
  return fail('Not found', 404);
}

// ================= member profile =================
async function saveProfile(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const b = await readJson(request);
  const name = clean(b?.name, 80);
  const phone = clean(b?.phone, 25);
  const group = GROUPS.includes(b?.group) ? b.group : null;
  if (!name || !phone || !group) return fail('Name, phone number and group are required');
  const dob = clean(b?.dob, 20);
  const location = clean(b?.location, 120);
  const hometown = clean(b?.hometown, 120);
  const house = clean(b?.houseNumber, 40);
  const now = Date.now();

  // One row per phone: editing updates it and flags it as "new" again, so leaders never see duplicates.
  await env.DB.prepare(
    `INSERT INTO members (device_id, name, dob, location, hometown, house_number, phone, group_name, seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, dob = excluded.dob, location = excluded.location,
       hometown = excluded.hometown, house_number = excluded.house_number, phone = excluded.phone,
       group_name = excluded.group_name, seen = 0, updated_at = excluded.updated_at`,
  ).bind(dev, name, dob, location, hometown, house, phone, group, now, now).run();
  return json({ success: true, message: 'Profile saved' });
}

async function getProfile(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const row = await env.DB.prepare(
    `SELECT name, dob, location, hometown, house_number AS houseNumber, phone, group_name AS "group", photo_key IS NOT NULL AS hasPhoto
     FROM members WHERE device_id = ?`,
  ).bind(dev).first();
  return json({ success: true, profile: row ? { ...row, hasPhoto: !!row.hasPhoto } : null });
}

async function savePhoto(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/jpeg')) return fail('Photo must be a JPEG');
  if (Number(request.headers.get('content-length') || 0) > MAX_PHOTO_BYTES) return fail('Photo is too large', 413);
  const member = await env.DB.prepare('SELECT id FROM members WHERE device_id = ?').bind(dev).first();
  if (!member) return fail('Save your profile first', 409);

  const data = await request.arrayBuffer();
  if (data.byteLength === 0 || data.byteLength > MAX_PHOTO_BYTES) return fail('Invalid photo size', 413);
  const key = await photoKey(dev);
  await env.MEDIA.put(key, data, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE members SET photo_key = ?, seen = 0, updated_at = ? WHERE id = ?').bind(key, Date.now(), member.id).run();
  return json({ success: true });
}

// ================= prayer requests =================
async function overDailyLimit(env, table, dev) {
  const { c } = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE device_id = ? AND created_at > ?`)
    .bind(dev, Date.now() - 24 * 3600 * 1000).first();
  return c >= DAILY_LIMIT;
}

async function submitPrayer(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const b = await readJson(request);
  const anonymous = b?.anonymous === true;
  // An anonymous request never stores the name; the phone's device id is kept only so "read" can reach the member.
  const name = anonymous ? 'Anonymous' : clean(b?.name, 80);
  const subject = clean(b?.subject, 120);
  const message = clean(b?.message, 2000);
  if (!name || !subject || !message) return fail('Name, subject and message are required');
  if (await overDailyLimit(env, 'prayer_requests', dev)) return fail('You have sent many requests today. Please try again tomorrow.', 429);
  await env.DB.prepare('INSERT INTO prayer_requests (device_id, member_name, subject, message, created_at, anonymous) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(dev, name, subject, message, Date.now(), anonymous ? 1 : 0).run();
  return json({ success: true, message: 'Prayer request sent to the pastor' }, 201);
}

async function adminListPrayer(env) {
  // Unread first, then newest. The app can re-sort however the pastor likes.
  const { results } = await env.DB.prepare(
    `SELECT id, member_name AS memberName, subject, message, seen, is_read AS isRead, read_at AS readAt, anonymous, created_at AS createdAt
     FROM prayer_requests ORDER BY is_read ASC, created_at DESC, id DESC LIMIT 1000`,
  ).all();
  return json({ success: true, items: results.map((r) => ({ ...r, seen: !!r.seen, isRead: !!r.isRead, anonymous: !!r.anonymous })) });
}

async function markPrayerRead(env, ctx, id) {
  const row = await env.DB.prepare('SELECT device_id, subject, is_read FROM prayer_requests WHERE id = ?').bind(id).first();
  if (!row) return fail('Not found', 404);
  if (!row.is_read) {
    await env.DB.prepare('UPDATE prayer_requests SET is_read = 1, read_at = ?, seen = 1 WHERE id = ?').bind(Date.now(), id).run();
    // Tell that member (works for anonymous requests too: the pastor still cannot see who it was).
    ctx.waitUntil((async () => {
      const t = await env.DB.prepare('SELECT device_id, token FROM device_tokens WHERE device_id = ?').bind(row.device_id).first();
      if (t) await sendToTokens(env, [t], { type: 'prayer_read', title: 'Your prayer request was read', body: `The pastor has read your prayer request: ${row.subject}` });
    })().catch((e) => console.error('read push failed', e.message)));
  }
  return json({ success: true });
}

const CHUNK = 90; // D1 allows about 100 bound values per statement

async function deletePrayerMany(request, env) {
  const b = await readJson(request, 50_000);
  const ids = Array.isArray(b?.ids) ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 1000) : [];
  if (!ids.length) return fail('Nothing selected');
  const stmts = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    stmts.push(env.DB.prepare(`DELETE FROM prayer_requests WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part));
  }
  await env.DB.batch(stmts);
  return json({ success: true, deleted: ids.length });
}

// ================= testimonies =================
async function listTestimonies(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, member_name AS memberName, title, message, approved_at AS approvedAt FROM testimonies WHERE status = 'approved' ORDER BY approved_at DESC LIMIT 100",
  ).all();
  return json({ success: true, items: results }, 200, { 'cache-control': 'public, max-age=30' });
}

async function submitTestimony(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const b = await readJson(request);
  const name = clean(b?.name, 80);
  const title = clean(b?.title, 120);
  const message = clean(b?.message, 3000);
  if (!name || !title || !message) return fail('Name, testimony and message are required');
  if (await overDailyLimit(env, 'testimonies', dev)) return fail('You have sent many testimonies today. Please try again tomorrow.', 429);
  await env.DB.prepare('INSERT INTO testimonies (device_id, member_name, title, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(dev, name, title, message, Date.now()).run();
  return json({ success: true, message: 'Testimony sent to the pastor for approval' }, 201);
}

async function adminListTestimonies(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, member_name AS memberName, title, message, status, created_at AS createdAt FROM testimonies ORDER BY (status = \'pending\') DESC, created_at DESC LIMIT 300',
  ).all();
  return json({ success: true, items: results });
}

async function approveTestimony(env, ctx, id, approve) {
  const row = await env.DB.prepare('SELECT title, member_name, status FROM testimonies WHERE id = ?').bind(id).first();
  if (!row) return fail('Not found', 404);
  if (approve) {
    await env.DB.prepare("UPDATE testimonies SET status = 'approved', approved_at = ? WHERE id = ?").bind(Date.now(), id).run();
    if (row.status !== 'approved') push(ctx, env, 'testimony', 'New testimony', `${row.member_name}: ${row.title}`);
  } else {
    await env.DB.prepare("UPDATE testimonies SET status = 'pending', approved_at = NULL WHERE id = ?").bind(id).run();
  }
  return json({ success: true });
}

// ================= calendar =================
async function listCalendar(url, env) {
  const from = url.searchParams.get('from') || '0000-01-01';
  const to = url.searchParams.get('to') || '9999-12-31';
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return fail('Dates must look like 2026-12-31');
  const { results } = await env.DB.prepare(
    'SELECT id, event_date AS date, title, note FROM calendar_events WHERE deleted = 0 AND event_date >= ? AND event_date <= ? ORDER BY event_date, id LIMIT 600',
  ).bind(from, to).all();
  return json({ success: true, items: results });
}

function readEvent(b) {
  const date = clean(b?.date, 10);
  const title = clean(b?.title, 120);
  const note = clean(b?.note, 1000);
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) return null;
  if (!title) return null;
  return { date, title, note };
}

async function createEvent(request, env, ctx, admin) {
  const e = readEvent(await readJson(request));
  if (!e) return fail('A valid date and a title are required');
  const now = Date.now();
  const res = await env.DB.prepare(
    'INSERT INTO calendar_events (event_date, title, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(e.date, e.title, e.note, admin.name, now, now).run();
  push(ctx, env, 'calendar', 'Church calendar updated', `${e.title} - ${e.date}`);
  return json({ success: true, id: res.meta.last_row_id }, 201);
}

async function updateEvent(request, env, ctx, id) {
  const e = readEvent(await readJson(request));
  if (!e) return fail('A valid date and a title are required');
  const res = await env.DB.prepare('UPDATE calendar_events SET event_date = ?, title = ?, note = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .bind(e.date, e.title, e.note, Date.now(), id).run();
  if (!res.meta.changes) return fail('Not found', 404);
  push(ctx, env, 'calendar', 'Church calendar updated', `${e.title} - ${e.date}`);
  return json({ success: true });
}

async function deleteEvent(env, id) {
  await env.DB.prepare('UPDATE calendar_events SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ success: true });
}

// ================= word from pastor =================
async function listPastorWords(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, title, body, author, created_at AS createdAt FROM pastor_words WHERE deleted = 0 ORDER BY created_at DESC LIMIT 50',
  ).all();
  return json({ success: true, items: results }, 200, { 'cache-control': 'public, max-age=30' });
}

async function createPastorWord(request, env, ctx, admin) {
  const b = await readJson(request);
  const title = clean(b?.title, 120);
  const body = clean(b?.body, 4000);
  if (!title || !body) return fail('Title and message are required');
  const now = Date.now();
  const res = await env.DB.prepare('INSERT INTO pastor_words (title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(title, body, admin.name, now, now).run();
  push(ctx, env, 'pastor', 'A word from the Pastor', title);
  return json({ success: true, id: res.meta.last_row_id }, 201);
}

async function updatePastorWord(request, env, id) {
  const b = await readJson(request);
  const title = clean(b?.title, 120);
  const body = clean(b?.body, 4000);
  if (!title || !body) return fail('Title and message are required');
  const res = await env.DB.prepare('UPDATE pastor_words SET title = ?, body = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .bind(title, body, Date.now(), id).run();
  if (!res.meta.changes) return fail('Not found', 404);
  return json({ success: true });
}

async function deletePastorWord(env, id) {
  await env.DB.prepare('UPDATE pastor_words SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ success: true });
}

// ================= private messages (pastor -> member) =================
const MAX_PUSHES_PER_SEND = 40; // keeps one request inside the free plan's subrequest limit

async function savePushToken(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const b = await readJson(request);
  const token = clean(b?.token, 4096);
  const platform = b?.platform === 'web' ? 'web' : 'android';
  if (token.length < 20) return fail('Invalid token');
  await env.DB.prepare(
    `INSERT INTO device_tokens (device_id, token, platform, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, platform = excluded.platform, updated_at = excluded.updated_at`,
  ).bind(dev, token, platform, Date.now()).run();
  return json({ success: true });
}

async function sendMessages(request, env, ctx, admin) {
  const b = await readJson(request, 50_000);
  const body = clean(b?.body, 1000);
  const ids = Array.isArray(b?.memberIds) ? [...new Set(b.memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 1000) : [];
  if (!body) return fail('Write a message first');
  if (!ids.length) return fail('Choose at least one member');
  const now = Date.now();

  const stmts = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    stmts.push(env.DB.prepare(
      `INSERT INTO member_messages (member_id, body, sent_by, created_at) SELECT id, ?, ?, ? FROM members WHERE id IN (${part.map(() => '?').join(',')})`,
    ).bind(body, admin.name, now, ...part));
  }
  await env.DB.batch(stmts);

  // Phone notification (best effort). Members without a push token still get the popup next time they open the app.
  const first = ids.slice(0, MAX_PUSHES_PER_SEND);
  const { results } = await env.DB.prepare(
    `SELECT t.device_id, t.token FROM members m JOIN device_tokens t ON t.device_id = m.device_id WHERE m.id IN (${first.map(() => '?').join(',')})`,
  ).bind(...first).all();
  ctx.waitUntil(sendToTokens(env, results, { type: 'message', title: `Message from ${admin.name}`, body })
    .catch((e) => console.error('message push failed', e.message)));
  return json({ success: true, recipients: ids.length, notified: Math.min(results.length, MAX_PUSHES_PER_SEND), pushLimited: ids.length > MAX_PUSHES_PER_SEND });
}

async function adminMemberMessages(env, id) {
  const { results } = await env.DB.prepare(
    'SELECT id, body, sent_by AS sentBy, created_at AS createdAt, closed_at AS closedAt FROM member_messages WHERE member_id = ? ORDER BY created_at DESC LIMIT 20',
  ).bind(id).all();
  return json({ success: true, items: results.map((r) => ({ ...r, closed: r.closedAt != null })) });
}

/** Messages this member has not closed yet (the app shows them as a popup when it opens). */
async function myMessages(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.body, g.sent_by AS sentBy, g.created_at AS createdAt
     FROM member_messages g JOIN members m ON m.id = g.member_id
     WHERE m.device_id = ? AND g.closed_at IS NULL ORDER BY g.created_at ASC LIMIT 10`,
  ).bind(dev).all();
  return json({ success: true, items: results });
}

async function closeMessage(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const b = await readJson(request);
  const id = idFrom(b?.id);
  if (!id) return fail('Missing message');
  await env.DB.prepare(
    'UPDATE member_messages SET closed_at = ? WHERE id = ? AND closed_at IS NULL AND member_id IN (SELECT id FROM members WHERE device_id = ?)',
  ).bind(Date.now(), id, dev).run();
  return json({ success: true });
}

// ================= leader: members, badges =================
async function adminListMembers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, dob, location, hometown, house_number AS houseNumber, phone, group_name AS "group",
            photo_key IS NOT NULL AS hasPhoto, seen, created_at AS createdAt, updated_at AS updatedAt
     FROM members ORDER BY updated_at DESC LIMIT 5000`,
  ).all();
  return json({ success: true, items: results.map((r) => ({ ...r, hasPhoto: !!r.hasPhoto, seen: !!r.seen })) });
}

async function adminMemberPhoto(env, id) {
  const row = await env.DB.prepare('SELECT photo_key FROM members WHERE id = ?').bind(id).first();
  if (!row?.photo_key) return fail('No photo', 404);
  const obj = await env.MEDIA.get(row.photo_key);
  if (!obj) return fail('No photo', 404);
  return new Response(obj.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300' } });
}

async function markSeen(env, table) {
  await env.DB.prepare(`UPDATE ${table} SET seen = 1 WHERE seen = 0`).run();
  return json({ success: true });
}

async function removeRow(env, table, id) {
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return json({ success: true });
}

async function badges(env, admin) {
  const q = (perm, sql) => (can(admin, perm) ? env.DB.prepare(sql).first() : Promise.resolve({ n: 0 }));
  const [a, b, c] = await Promise.all([
    q('members', 'SELECT COUNT(*) AS n FROM members WHERE seen = 0'),
    q('prayer', 'SELECT COUNT(*) AS n FROM prayer_requests WHERE seen = 0'),
    q('testimonies', "SELECT COUNT(*) AS n FROM testimonies WHERE status = 'pending'"),
  ]);
  return json({ success: true, members: a.n, prayer: b.n, testimonies: c.n });
}

// ================= member "unseen" badges =================
const UPDATE_SOURCES = {
  announcements: ['announcements', 'created_at', 'deleted = 0'],
  pastor: ['pastor_words', 'created_at', 'deleted = 0'],
  media: ['media', 'created_at', '1 = 1'],
  testimonies: ['testimonies', 'approved_at', "status = 'approved'"],
  calendar: ['calendar_events', 'updated_at', 'deleted = 0'],
};

/** For each category: `latest` (newest timestamp) and `count` of items newer than the `since` the app last saw. */
async function updates(url, env) {
  const out = {};
  await Promise.all(Object.entries(UPDATE_SOURCES).map(async ([name, [table, col, where]]) => {
    const latestRow = await env.DB.prepare(`SELECT COALESCE(MAX(${col}), 0) AS m FROM ${table} WHERE ${where}`).first();
    const raw = url.searchParams.get(name);
    const since = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
    let count = 0;
    if (since !== null && latestRow.m > since) {
      count = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} AND ${col} > ?`).bind(since).first()).n;
    }
    out[name] = { count: Math.min(count, 99), latest: latestRow.m };
  }));
  return json({ success: true, ...out }, 200, { 'cache-control': 'no-store' });
}

// ================= member sign-in (accounts created by a leader) =================
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

async function memberLogin(request, env) {
  const dev = deviceId(request);
  if (!dev) return fail('Missing device id');
  const b = await readJson(request);
  const username = clean(b?.username, 64).toLowerCase();
  const password = typeof b?.password === 'string' ? b.password.slice(0, 200) : '';
  if (!username || !password) return fail('Username and password are required');

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = `m|${ip}|${username}`;
  const now = Date.now();
  const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE key = ? AND attempted_at > ?').bind(key, now - LOGIN_WINDOW_MS).first();
  if (c >= MAX_LOGIN_FAILURES) return fail('Too many attempts. Try again in 15 minutes.', 429);

  const row = await env.DB.prepare('SELECT id, password_hash FROM members WHERE username = ?').bind(username).first();
  const ok = row?.password_hash
    ? await verifyPassword(password, row.password_hash)
    : (await verifyPassword(password, await hashPassword('dummy-password')), false);
  if (!ok) {
    await env.DB.prepare('INSERT INTO login_attempts (key, attempted_at) VALUES (?, ?)').bind(key, now).run();
    return fail('Invalid username or password', 401);
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();

  // This phone now belongs to the account. Drop a separate self-registered row for the same phone, if any.
  await env.DB.prepare('DELETE FROM members WHERE device_id = ? AND id != ?').bind(dev, row.id).run();
  await env.DB.prepare('UPDATE members SET device_id = ?, updated_at = ? WHERE id = ?').bind(dev, now, row.id).run();
  return getProfile(request, env);
}
