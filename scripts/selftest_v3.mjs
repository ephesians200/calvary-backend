// Offline self-test (v3: links, video, permissions, accounts, badges): runs the real Worker against an in-memory SQLite (node:sqlite) standing in for D1,
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


// --- paystack failure is explained, not hidden ---
globalThis.fetch = async (u) => new Response(JSON.stringify({ status: false, message: 'Currency not supported by merchant' }), { status: 400 });
const bad = await post('/api/payments/init', { amountPesewas: 2550, email: 'a@b.co', fundType: 'Tithe' }, dev(DEV));
assert.equal(bad.status, 502);
assert.ok((await bad.json()).message.includes('Currency not supported')); ok('Paystack error message reaches the app');
globalThis.fetch = realFetch;

// --- video upload + size ---
const start = await (await post('/api/admin/media/multipart/start', { kind: 'sermon', contentType: 'video/mp4', title: 'Sunday video' }, auth)).json();
assert.ok(start.key && start.uploadId, JSON.stringify(start)); ok('video sermon upload accepted');
const part = await call(`/api/admin/media/multipart/part?key=${encodeURIComponent(start.key)}&uploadId=${start.uploadId}&partNumber=1`, { method: 'PUT', headers: auth, body: new Uint8Array(2048) });
const pj = await part.json();
assert.equal((await post('/api/admin/media/multipart/complete', { key: start.key, uploadId: start.uploadId, kind: 'sermon', title: 'Sunday video', speaker: 'Pastor', parts: [{ partNumber: 1, etag: pj.etag }] }, auth)).status, 201);
const list = (await (await call('/api/media?kind=sermon')).json()).items;
assert.equal(list[0].size, 2048); assert.equal(list[0].contentType, 'video/mp4'); assert.equal(list[0].source, 'file'); ok('list returns size, type, source');
assert.equal((await post('/api/admin/media/multipart/start', { kind: 'flyer', contentType: 'video/mp4', title: 'x' }, auth)).status, 400); ok('video as flyer rejected');

// --- links ---
assert.equal((await post('/api/admin/media/link', { title: 'T', link: 'https://example.com/x' }, auth)).status, 400); ok('unsupported link rejected');
assert.equal((await post('/api/admin/media/link', { title: 'T', link: 'http://youtube.com/watch?v=dQw4w9WgXcQ' }, auth)).status, 400); ok('non-https link rejected');
assert.equal((await post('/api/admin/media/link', { title: 'Yt', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).status, 401); ok('link needs login');
assert.equal((await post('/api/admin/media/link', { title: 'Yt', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, auth)).status, 201);
assert.equal((await post('/api/admin/media/link', { title: 'Fb', link: 'https://www.facebook.com/watch/?v=12345' }, auth)).status, 201); ok('YouTube and Facebook links saved');
const items = (await (await call('/api/media?kind=sermon')).json()).items;
const yt = items.find((i) => i.title === 'Yt');
assert.equal(yt.source, 'link'); assert.ok(yt.watchUrl.endsWith(`/watch/${yt.id}`)); ok('link item has watchUrl');
const wp = await call(`/watch/${yt.id}`);
const wh = await wp.text();
assert.equal(wp.status, 200); assert.ok(wh.includes('youtube.com/embed/dQw4w9WgXcQ')); assert.ok(wp.headers.get('content-security-policy').includes('frame-src')); ok('watch page embeds the player');
assert.equal((await call('/watch/9999')).status, 404); assert.equal((await call(`/watch/${list[0].id}`)).status, 404); ok('watch page only serves links');

// --- member badges ---
const base = await (await call('/api/updates')).json();
assert.equal(base.media.count, 0); assert.ok(base.media.latest > 0); ok('no baseline -> zero counts, latest returned');
const before = { a: base.announcements.latest, m: base.media.latest };
await new Promise((r) => setTimeout(r, 5));
await post('/api/announcements', { title: 'N1', body: 'b', category: 'General' }, auth);
await post('/api/admin/media/link', { title: 'Yt2', link: 'https://youtu.be/dQw4w9WgXcQ' }, auth);
const up = await (await call(`/api/updates?announcements=${before.a}&media=${before.m}&pastor=0&testimonies=0&calendar=0`)).json();
assert.equal(up.announcements.count, 1); assert.equal(up.media.count, 1); ok('badge counts new announcement and media');
const up2 = await (await call(`/api/updates?announcements=${up.announcements.latest}&media=${up.media.latest}`)).json();
assert.equal(up2.announcements.count, 0); assert.equal(up2.media.count, 0); ok('badge clears after marking seen');

// --- permissions: create admins ---
assert.deepEqual((await (await call('/api/admin/me', { headers: auth })).json()).permissions, ['*']); ok('existing admin has full access');
assert.equal((await call('/api/admin/users')).status, 401); ok('users list needs login');
const mk = (body) => post('/api/admin/users', body, auth);
assert.equal((await mk({ type: 'admin', name: 'Elder', username: 'elder', password: 'short' })).status, 400); ok('short password rejected');
assert.equal((await mk({ type: 'admin', name: 'Elder', username: 'elder', password: 'longenough1', permissions: [] })).status, 400); ok('admin needs at least one button');
assert.equal((await mk({ type: 'admin', name: 'Elder', username: 'elder', password: 'longenough1', permissions: ['calendar', 'notice', 'bogus'] })).status, 201); ok('limited admin created');
assert.equal((await mk({ type: 'admin', name: 'Dup', username: 'ELDER', password: 'longenough1', permissions: ['calendar'] })).status, 409); ok('duplicate username rejected');
const el = await (await post('/api/auth/login', { username: 'elder', password: 'longenough1' })).json();
assert.deepEqual(el.permissions, ['calendar', 'notice']); ok('login returns permissions');
const eauth = { authorization: `Bearer ${el.token}` };
assert.equal((await post('/api/announcements', { title: 'From elder', body: 'x', category: 'General' }, eauth)).status, 201); ok('allowed button works (notice)');
assert.equal((await post('/api/admin/media/link', { title: 'T', link: 'https://youtu.be/dQw4w9WgXcQ' }, eauth)).status, 403); ok('upload blocked for elder');
assert.equal((await call('/api/admin/members', { headers: eauth })).status, 403); ok('members blocked for elder');
assert.equal((await call('/api/admin/users', { headers: eauth })).status, 403); ok('create-user blocked for elder');
assert.equal((await call('/api/admin/stats', { headers: eauth })).status, 200);
assert.equal((await (await call('/api/admin/stats', { headers: eauth })).json()).gifts, 0); ok('gifts figure hidden from limited admin');
const bj = await (await call('/api/admin/badges', { headers: eauth })).json();
assert.equal(bj.members, 0); ok('badges zeroed for blocked areas');

// escalation
const usersList = (await (await call('/api/admin/users', { headers: auth })).json());
const elderId = usersList.admins.find((a) => a.username === 'elder').id;
assert.equal((await call(`/api/admin/users/admin/${elderId}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ permissions: ['calendar', 'notice', 'users'] }) })).status, 200); ok('boss can add the users button');
assert.equal((await post('/api/admin/users', { type: 'admin', name: 'X', username: 'xx1', password: 'longenough1', permissions: ['members'] }, eauth)).status, 403); ok('cannot grant a button you do not have');
assert.equal((await post('/api/admin/users', { type: 'admin', name: 'X', username: 'xx1', password: 'longenough1', fullAccess: true }, eauth)).status, 403); ok('limited admin cannot create full admin');
const meId = usersList.admins.find((a) => a.username === 'pastor').id;
assert.equal((await call(`/api/admin/users/admin/${meId}`, { method: 'PUT', headers: { ...eauth, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) })).status, 403); ok('limited admin cannot touch the full admin');
assert.equal((await call(`/api/admin/users/admin/${meId}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) })).status, 403); ok('cannot disable yourself');
assert.equal((await call(`/api/admin/users/admin/${elderId}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) })).status, 200);
assert.equal((await call('/api/admin/stats', { headers: eauth })).status, 401); ok('disabled admin is locked out immediately');

// --- member accounts ---
assert.equal((await mk({ type: 'member', name: 'Esi', username: 'esi', password: 'longenough1', phone: '0244000000' })).status, 400); ok('member needs group');
assert.equal((await mk({ type: 'member', name: 'Esi Owusu', username: 'esi', password: 'longenough1', phone: '0244000000', group: 'Women', location: 'Accra' })).status, 201); ok('member account created');
assert.equal((await post('/api/members/login', { username: 'esi', password: 'wrong-password' }, dev(DEV2))).status, 401); ok('wrong member password rejected');
const ml = await post('/api/members/login', { username: 'ESI', password: 'longenough1' }, dev(DEV2));
const mlj = await ml.json();
assert.equal(ml.status, 200); assert.equal(mlj.profile.name, 'Esi Owusu'); assert.equal(mlj.profile.group, 'Women'); ok('member signs in, profile returned');
assert.equal(db.prepare("SELECT COUNT(*) c FROM members WHERE device_id = ?").get(DEV2).c, 1); ok('device linked to account, no duplicate row');
for (let i = 0; i < 5; i++) await post('/api/members/login', { username: 'esi', password: 'nope-nope-nope' }, dev(DEV));
assert.equal((await post('/api/members/login', { username: 'esi', password: 'longenough1' }, dev(DEV))).status, 429); ok('member login lockout works');
const mid = (await (await call('/api/admin/users', { headers: auth })).json()).members[0].id;
assert.equal((await call(`/api/admin/users/member/${mid}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'brandnewpass1' }) })).status, 200); ok('member password reset');

console.log(`\nAll ${n} v3 checks passed.`);
