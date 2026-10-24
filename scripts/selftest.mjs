// Offline self-test: runs the real Worker against an in-memory SQLite (node:sqlite) standing in for D1,
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

// stub Paystack
const realFetch = globalThis.fetch;
let paystackStatus = 'abandoned';
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/transaction/initialize')) return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', reference: JSON.parse(init.body).reference } });
  if (String(url).includes('/transaction/verify/')) return Response.json({ status: true, data: { status: paystackStatus, amount: 2550, currency: 'GHS' } });
  return realFetch(url, init);
};

// seed admin
db.prepare("INSERT INTO admins (username,name,role,password_hash,created_at) VALUES ('pastor','Pastor Prince','admin',?,?)").run(await hashPassword('correct-horse-battery'), Date.now());

let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

// --- auth ---
assert.equal((await post('/api/announcements', { title: 'x', body: 'y' })).status, 401); ok('write without token rejected');
assert.equal((await post('/api/auth/login', { username: 'pastor', password: 'nope' })).status, 401); ok('bad password rejected');
const login = await (await post('/api/auth/login', { username: 'pastor', password: 'correct-horse-battery' })).json();
assert.ok(login.token && login.role === 'admin'); ok('login returns JWT');
const auth = { authorization: `Bearer ${login.token}` };
const tampered = { authorization: `Bearer ${login.token.slice(0, -3)}abc` };
assert.equal((await post('/api/announcements', { title: 'x', body: 'y' }, tampered)).status, 401); ok('tampered token rejected');

for (let i = 0; i < 5; i++) await post('/api/auth/login', { username: 'ghost', password: 'wrongwrong' });
assert.equal((await post('/api/auth/login', { username: 'ghost', password: 'wrongwrong' })).status, 429); ok('login throttled after 5 failures');

// --- announcements ---
const created = await post('/api/announcements', { title: 'Sunday Service', body: 'See you at 9am', category: 'Service', author: 'HACKER' }, auth);
assert.equal(created.status, 201); await Promise.all(pending); ok('admin can post announcement');
const list1 = await call('/api/announcements');
const etag = list1.headers.get('etag'); const data = await list1.json();
assert.equal(data.announcements.length, 1);
assert.equal(data.announcements[0].author, 'Pastor Prince'); ok('author taken from token, not client');
assert.ok(data.announcements[0].createdAt > 1e12); ok('createdAt returned');
assert.equal((await call('/api/announcements', { headers: { 'if-none-match': etag } })).status, 304); ok('ETag revalidation returns 304');
await call('/api/announcements/1', { method: 'DELETE', headers: auth });
assert.equal((await (await call('/api/announcements')).json()).announcements.length, 0); ok('soft-deleted announcement disappears');
assert.equal((await post('/api/announcements', { title: 'a'.repeat(500), body: 'b' }, auth)).status, 201); ok('long title clamped, not crashing');
assert.equal((await call('/api/announcements')).headers.get('etag') !== etag, true); ok('ETag changes when data changes');

// --- stats ---
assert.equal((await call('/api/admin/stats')).status, 401);
assert.equal((await (await call('/api/admin/stats', { headers: auth })).json()).announcements, 1); ok('admin stats guarded + correct');

// --- deactivated admin loses access immediately ---
db.prepare("UPDATE admins SET active = 0").run();
assert.equal((await call('/api/admin/stats', { headers: auth })).status, 401); ok('deactivated admin token stops working');
db.prepare("UPDATE admins SET active = 1").run();

// --- payments ---
assert.equal((await post('/api/payments/init', { amountPesewas: 50, email: 'a@b.co', fundType: 'Tithe' })).status, 400); ok('payment below minimum rejected');
assert.equal((await post('/api/payments/init', { amountPesewas: 2550, email: 'bad', fundType: 'Tithe' })).status, 400); ok('bad email rejected');
const init = await (await post('/api/payments/init', { amountPesewas: 2550, email: 'member@example.com', fundType: 'Tithe' })).json();
assert.ok(init.authorizationUrl && init.reference.startsWith('CT-')); ok('payment initialised server-side');

const evt = JSON.stringify({ event: 'charge.success', data: { reference: init.reference, amount: 2550, currency: 'GHS', status: 'success' } });
assert.equal((await call('/api/paystack/webhook', { method: 'POST', body: evt, headers: { 'x-paystack-signature': 'deadbeef' } })).status, 401); ok('webhook with bad signature rejected');
const sig = createHmac('sha512', 'sk_test_abc').update(evt).digest('hex');
assert.equal((await call('/api/paystack/webhook', { method: 'POST', body: evt, headers: { 'x-paystack-signature': sig } })).status, 200);
assert.equal((await (await call(`/api/payments/${init.reference}`)).json()).status, 'success'); ok('valid webhook marks payment successful');

const wrongAmt = await (await post('/api/payments/init', { amountPesewas: 9999, email: 'm@example.com', fundType: 'Offering' })).json();
const evt2 = JSON.stringify({ event: 'charge.success', data: { reference: wrongAmt.reference, amount: 100, currency: 'GHS', status: 'success' } });
await call('/api/paystack/webhook', { method: 'POST', body: evt2, headers: { 'x-paystack-signature': createHmac('sha512', 'sk_test_abc').update(evt2).digest('hex') } });
paystackStatus = 'abandoned';
assert.notEqual((await (await call(`/api/payments/${wrongAmt.reference}`)).json()).status, 'success'); ok('amount-mismatch webhook does not mark success');

paystackStatus = 'success';
const fresh = await (await post('/api/payments/init', { amountPesewas: 2550, email: 'm2@example.com', fundType: 'Offering' })).json();
assert.equal((await (await call(`/api/payments/${fresh.reference}`)).json()).status, 'success'); ok('status poll verifies with Paystack when webhook is late');
assert.equal((await call('/pay/return?reference=../../x')).status, 400);
const ret = await call(`/pay/return?reference=${fresh.reference}`);
const retHtml = await ret.text();
assert.ok(retHtml.includes('scheme=calvarytemple') && retHtml.includes('give/result')); ok('return page deep-links back to app, rejects bad reference');

// --- media ---
const start = await (await post('/api/admin/media/multipart/start', { kind: 'sermon', contentType: 'audio/mpeg' }, auth)).json();
assert.ok(start.key.startsWith('sermon/')); ok('multipart upload started');
assert.equal((await post('/api/admin/media/multipart/start', { kind: 'sermon', contentType: 'text/html' }, auth)).status, 400); ok('non-audio sermon upload rejected');
const p1 = await (await call(`/api/admin/media/multipart/part?key=${start.key}&uploadId=${start.uploadId}&partNumber=1`, { method: 'PUT', headers: auth, body: Buffer.from('HELLO') })).json();
const p2 = await (await call(`/api/admin/media/multipart/part?key=${start.key}&uploadId=${start.uploadId}&partNumber=2`, { method: 'PUT', headers: auth, body: Buffer.from('WORLD') })).json();
assert.equal((await post('/api/admin/media/multipart/complete', { key: start.key, uploadId: start.uploadId, kind: 'sermon', title: 'Grace', speaker: 'Pastor', parts: [p1, p2] }, auth)).status, 201); ok('parts uploaded and completed');
const media = await (await call('/api/media?kind=sermon')).json();
assert.equal(media.items[0].title, 'Grace'); ok('sermon listed with public URL');
const full = await call(new URL(media.items[0].url).pathname);
assert.equal(await full.text(), 'HELLOWORLD'); ok('media served in full');
const part = await call(new URL(media.items[0].url).pathname, { headers: { range: 'bytes=5-9' } });
assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 5-9/10'); assert.equal(await part.text(), 'WORLD'); ok('HTTP Range request served (audio seeking)');
assert.equal((await call('/media/../secret')).status, 404); ok('path traversal blocked');

console.log(`\nAll ${n} checks passed.`);
