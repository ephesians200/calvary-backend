// Offline self-test (portal features): runs the real Worker against an in-memory SQLite (node:sqlite) standing in for D1,
// a fake R2 bucket, and a stubbed fetch() for Paystack. Run with: node scripts/selftest.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { hashPassword } from '../src/auth.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

const D1 = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return api; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { const r = stmt.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    };
    return api;
  },
};

const store = new Map();
const uploads = new Map();
const MEDIA = {
  async createMultipartUpload(key, opts) { const id = 'u' + uploads.size; uploads.set(id, { key, parts: new Map(), opts }); return { uploadId: id }; },
  resumeMultipartUpload(key, id) {
    const u = uploads.get(id);
    return {
      async uploadPart(n, data) { u.parts.set(n, Buffer.from(data)); return { partNumber: n, etag: `e${n}` }; },
      async complete(parts) {
        const buf = Buffer.concat(parts.map((p) => u.parts.get(p.partNumber)));
        store.set(key, { buf, ct: u.opts.httpMetadata.contentType });
        return { size: buf.length, httpMetadata: u.opts.httpMetadata };
      },
      async abort() { uploads.delete(id); },
    };
  },
  async get(key, opts) {
    const o = store.get(key); if (!o) return null;
    let body = o.buf; let range;
    if (opts?.range) { const m = /bytes=(\d+)-(\d*)/.exec(opts.range.get('range')); const s = +m[1]; const e = m[2] ? +m[2] : o.buf.length - 1; body = o.buf.subarray(s, e + 1); range = { offset: s, length: e - s + 1 }; }
    return { body, size: o.buf.length, range, httpEtag: '"abc"', writeHttpMetadata(h) { h.set('content-type', o.ct); } };
  },
  async delete(k) { store.delete(k); },
};

const env = { DB: D1, MEDIA, JWT_SECRET: 'test-secret-test-secret-test-secret', PAYSTACK_SECRET_KEY: 'sk_test_abc', APP_SCHEME: 'calvarytemple' };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = (path, init = {}) => worker.fetch(new Request(`https://x.test${path}`, init), env, ctx);
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });


// FCM stub: capture pushes sent to the topic
const pushes = [];
const realFetch = globalThis.fetch;
env.FCM_SERVICE_ACCOUNT_JSON = '';
MEDIA.put = async (key, data, opts) => { store.set(key, { buf: Buffer.from(data), ct: opts?.httpMetadata?.contentType }); };
// capture pushes by wrapping the module-level send: easiest is to observe via a fake service account
// (sendTopicPush returns {skipped} without creds), so we assert on rows instead and test push via spy below.

db.prepare("INSERT INTO admins (username,name,role,password_hash,created_at) VALUES ('pastor','Pastor Prince','admin',?,?)").run(await hashPassword('pw-pw-pw-pw'), Date.now());
let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);
const login = await (await post('/api/auth/login', { username: 'pastor', password: 'pw-pw-pw-pw' })).json();
const auth = { authorization: `Bearer ${login.token}` };
const DEV = 'a'.repeat(32), DEV2 = 'b'.repeat(32);
const dev = (d) => ({ 'x-device-id': d });
const put = (path, body, headers = {}) => call(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// --- member profile ---
assert.equal((await put('/api/members/me', { name: 'Ama', phone: '024', group: 'Women' })).status, 400); ok('profile needs a device id');
assert.equal((await put('/api/members/me', { name: 'Ama', phone: '024', group: 'Aliens' }, dev(DEV))).status, 400); ok('invalid group rejected');
assert.equal((await put('/api/members/me', { name: 'Ama Mensah', dob: '1990-05-01', location: 'Accra', hometown: 'Kumasi', houseNumber: 'A12', phone: '0241234567', group: 'Women' }, dev(DEV))).status, 200); ok('profile saved');
assert.equal((await put('/api/members/me', { name: 'Ama M.', phone: '0241234567', group: 'Women' }, dev(DEV))).status, 200);
assert.equal(db.prepare('SELECT COUNT(*) c FROM members').get().c, 1); ok('editing updates the same row, no duplicate');
assert.equal((await (await call('/api/members/me', { headers: dev(DEV) })).json()).profile.name, 'Ama M.'); ok('member can read own profile back');
assert.equal((await call('/api/members/photo', { method: 'PUT', headers: { ...dev(DEV2), 'content-type': 'image/jpeg' }, body: new Uint8Array([1, 2, 3]) })).status, 409); ok('photo before profile rejected');
assert.equal((await call('/api/members/photo', { method: 'PUT', headers: { ...dev(DEV), 'content-type': 'image/png' }, body: new Uint8Array([1]) })).status, 400); ok('non-jpeg photo rejected');
assert.equal((await call('/api/members/photo', { method: 'PUT', headers: { ...dev(DEV), 'content-type': 'image/jpeg' }, body: new Uint8Array([255, 216, 255, 1, 2]) })).status, 200); ok('photo stored in R2');
await put('/api/members/me', { name: 'Kofi', phone: '0200000000', group: 'Men' }, dev(DEV2));

// --- leader: members + badge ---
assert.equal((await call('/api/admin/members')).status, 401); ok('members list needs login');
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).members, 2); ok('badge counts 2 new profiles');
const members = (await (await call('/api/admin/members', { headers: auth })).json()).items;
assert.equal(members.length, 2); assert.equal(members.find((m) => m.name === 'Ama M.').hasPhoto, true); ok('leader lists members');
const photo = await call(`/api/admin/members/${members.find((m) => m.name === 'Ama M.').id}/photo`, { headers: auth });
assert.equal(photo.status, 200); assert.equal((await photo.arrayBuffer()).byteLength, 5); ok('leader can fetch member photo');
assert.equal((await call(`/api/admin/members/${members[0].id}/photo`)).status, 401); ok('photo needs login');
assert.equal((await post('/api/admin/members/seen', {}, auth)).status, 200);
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).members, 0); ok('badge clears after viewing');
await put('/api/members/me', { name: 'Ama M.', phone: '0241234567', group: 'Women', location: 'Tema' }, dev(DEV));
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).members, 1); ok('an edit raises the badge again (count 1, not duplicate)');

// --- prayer ---
assert.equal((await post('/api/prayer-requests', { name: 'Ama', subject: 'Healing', message: 'Pray for me' })).status, 400); ok('prayer needs device id');
assert.equal((await post('/api/prayer-requests', { name: 'Ama', subject: 'Healing', message: 'Pray for me' }, dev(DEV))).status, 201); ok('prayer request sent');
assert.equal((await post('/api/prayer-requests', { name: '', subject: 's', message: 'm' }, dev(DEV))).status, 400); ok('empty name rejected');
assert.equal((await call('/api/admin/prayer-requests')).status, 401);
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).prayer, 1); ok('prayer badge = 1');
const pr = (await (await call('/api/admin/prayer-requests', { headers: auth })).json()).items;
assert.equal(pr[0].subject, 'Healing'); ok('leader sees prayer request');
await post('/api/admin/prayer-requests/seen', {}, auth);
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).prayer, 0); ok('prayer badge clears');
for (let i = 0; i < 12; i++) await post('/api/prayer-requests', { name: 'A', subject: 's', message: 'm' }, dev(DEV2));
assert.equal(db.prepare("SELECT COUNT(*) c FROM prayer_requests WHERE device_id = ?").get(DEV2).c, 10); ok('daily limit stops spam (10/device)');
assert.equal((await call(`/api/admin/prayer-requests/${pr[0].id}`, { method: 'DELETE', headers: auth })).status, 200); ok('leader can delete a prayer request');

// --- testimonies ---
assert.equal((await post('/api/testimonies', { name: 'Ama', title: 'God healed me', message: 'Full story' }, dev(DEV))).status, 201); ok('testimony submitted');
assert.equal((await (await call('/api/testimonies')).json()).items.length, 0); ok('pending testimony hidden from members');
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).testimonies, 1); ok('testimony badge = 1');
const tid = (await (await call('/api/admin/testimonies', { headers: auth })).json()).items[0].id;
assert.equal((await call(`/api/admin/testimonies/${tid}/approve`, { method: 'POST' })).status, 401); ok('approve needs login');
assert.equal((await call(`/api/admin/testimonies/${tid}/approve`, { method: 'POST', headers: auth })).status, 200);
const pub = (await (await call('/api/testimonies')).json()).items;
assert.equal(pub.length, 1); assert.equal(pub[0].title, 'God healed me'); ok('approved testimony appears for members');
assert.equal((await (await call('/api/admin/badges', { headers: auth })).json()).testimonies, 0); ok('testimony badge clears after approval');
await call(`/api/admin/testimonies/${tid}/unapprove`, { method: 'POST', headers: auth });
assert.equal((await (await call('/api/testimonies')).json()).items.length, 0); ok('unapprove hides it again');

// --- calendar ---
assert.equal((await post('/api/admin/calendar', { date: '2026-12-25', title: 'Christmas Service' })).status, 401); ok('calendar write needs login');
assert.equal((await post('/api/admin/calendar', { date: 'nope', title: 'x' }, auth)).status, 400); ok('bad date rejected');
const ev = await (await post('/api/admin/calendar', { date: '2026-12-25', title: 'Christmas Service', note: '9am' }, auth)).json();
await Promise.all(pending);
const cal = (await (await call('/api/calendar?from=2026-12-01&to=2026-12-31')).json()).items;
assert.equal(cal.length, 1); assert.equal(cal[0].date, '2026-12-25'); ok('event appears on members calendar');
assert.equal((await put(`/api/admin/calendar/${ev.id}`, { date: '2026-12-26', title: 'Boxing Day Service', note: '' }, auth)).status, 200);
assert.equal((await (await call('/api/calendar?from=2026-12-26&to=2026-12-26')).json()).items[0].title, 'Boxing Day Service'); ok('leader can edit event');
await call(`/api/admin/calendar/${ev.id}`, { method: 'DELETE', headers: auth });
assert.equal((await (await call('/api/calendar')).json()).items.length, 0); ok('leader can remove event');

// --- pastor words ---
assert.equal((await post('/api/admin/pastor-words', { title: 'x', body: 'y' })).status, 401); ok('pastor word needs login');
const pw = await (await post('/api/admin/pastor-words', { title: 'Be strong', body: 'Joshua 1:9' }, auth)).json();
assert.equal((await (await call('/api/pastor-words')).json()).items[0].title, 'Be strong'); ok('pastor word published');
assert.equal((await put(`/api/admin/pastor-words/${pw.id}`, { title: 'Be very strong', body: 'Joshua 1:9' }, auth)).status, 200);
assert.equal((await (await call('/api/pastor-words')).json()).items[0].title, 'Be very strong'); ok('pastor word edited');
await call(`/api/admin/pastor-words/${pw.id}`, { method: 'DELETE', headers: auth });
assert.equal((await (await call('/api/pastor-words')).json()).items.length, 0); ok('pastor word removed');
assert.equal((await (await call('/api/announcements')).json()).announcements.length, 0);

// --- announcements edit ---
const a = await (await post('/api/announcements', { title: 'Old', body: 'Old body', category: 'General' }, auth)).json();
assert.equal((await put(`/api/announcements/${a.id}`, { title: 'New', body: 'New body', category: 'Event' })).status, 401); ok('announcement edit needs login');
assert.equal((await put(`/api/announcements/${a.id}`, { title: 'New', body: 'New body', category: 'Event' }, auth)).status, 200);
const got = (await (await call('/api/announcements')).json()).announcements[0];
assert.equal(got.title, 'New'); assert.equal(got.category, 'Event'); ok('leader can edit announcement');
assert.equal((await call('/api/admin/nope', { headers: auth, method: 'DELETE' })).status, 404); ok('unknown admin DELETE no longer hits announcements');

console.log(`\nAll ${n} portal checks passed.`);
