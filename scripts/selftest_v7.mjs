// Offline self-test for v7: sign-up credentials, phone change, duplicate flags, merge, password reset.
// Run: node scripts/selftest_v7.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { hashPassword } from '../src/auth.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const D1 = {
  prepare(sql) {
    const stmt = db.prepare(sql); let args = [];
    const api = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return api; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { const r = stmt.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      _run() { return stmt.run(...args); },
    };
    return api;
  },
  async batch(list) { db.exec('BEGIN'); try { for (const s of list) s._run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; },
};
const env = { DB: D1, MEDIA: {}, JWT_SECRET: 'test-secret-test-secret-test-secret' };
const ctx = { waitUntil: () => {} };
const call = (path, init = {}) => worker.fetch(new Request(`https://x.test${path}`, init), env, ctx);
const send = (method) => (path, body, headers = {}) => call(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const post = send('POST'), put = send('PUT');
const dev = (d) => ({ 'x-device-id': d });
const PH1 = 'a'.repeat(32), PH2 = 'b'.repeat(32), PH3 = 'c'.repeat(32);
let n = 0; const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);

db.prepare("INSERT INTO admins (username,name,role,password_hash,created_at) VALUES ('pastor','Pastor','admin',?,?)").run(await hashPassword('pw-pw-pw-pw'), Date.now());
const auth = { authorization: `Bearer ${(await (await post('/api/auth/login', { username: 'pastor', password: 'pw-pw-pw-pw' })).json()).token}` };
const base = { name: 'Ama Mensah', phone: '024 123 4567', group: 'Women' };

// sign-up with a sign-in
assert.equal((await put('/api/members/me', { ...base, username: 'ab', password: 'longenough1' }, dev(PH1))).status, 400); ok('short username rejected');
assert.equal((await put('/api/members/me', { ...base, username: 'ama.m', password: 'short' }, dev(PH1))).status, 400); ok('short password rejected');
assert.equal((await put('/api/members/me', { ...base, username: 'ama.m', password: 'longenough1' }, dev(PH1))).status, 200); ok('sign-up with username + password');
assert.equal(db.prepare('SELECT username FROM members').get().username, 'ama.m');
assert.ok(db.prepare('SELECT password_hash h FROM members').get().h.startsWith('pbkdf2$')); ok('password stored only as a hash');
assert.equal((await put('/api/members/me', { name: 'Kofi', phone: '0200000000', group: 'Men', username: 'AMA.M', password: 'longenough1' }, dev(PH3))).status, 409); ok('taken username (any case) -> 409');
assert.equal((await put('/api/members/me', { ...base, name: 'Ama M.', username: 'other.name', password: 'longenough9' }, dev(PH1))).status, 200);
assert.equal(db.prepare('SELECT username FROM members WHERE device_id = ?').get(PH1).username, 'ama.m'); ok('an existing sign-in is not overwritten');
assert.equal((await put('/api/members/me', { name: 'Kofi', phone: '0200000000', group: 'Men' }, dev(PH3))).status, 200); ok('sign-up without a sign-in still works');
assert.equal((await put('/api/members/me', { ...base, username: 'later.user', password: 'longenough2' }, dev(PH3))).status, 200);
db.prepare('DELETE FROM members WHERE device_id = ?').run(PH3);

// phone change: sign in on a new phone that already registered a duplicate
await post('/api/prayer-requests', { name: 'Ama', subject: 'Health', message: 'pray' }, dev(PH1));
await put('/api/members/push-token', { token: 'x'.repeat(40) }, dev(PH1));
const amaId = db.prepare('SELECT id FROM members WHERE username = ?').get('ama.m').id;
db.prepare("INSERT INTO member_messages (member_id, body, sent_by, created_at) VALUES (?, 'Welcome', 'Pastor', ?)").run(amaId, Date.now());
await put('/api/members/me', { ...base, phone: '+233241234567' }, dev(PH2)); // same person, new phone, signed up again
assert.equal(db.prepare('SELECT COUNT(*) c FROM members').get().c, 2);
let list = (await (await call('/api/admin/members', { headers: auth })).json()).items;
assert.ok(list.every((m) => m.duplicateIds.length === 1)); ok('same number typed two ways is flagged as duplicate');
assert.equal(list.find((m) => m.username === 'ama.m').hasAccount, true);

assert.equal((await post('/api/members/login', { username: 'ama.m', password: 'wrong-wrong' }, dev(PH2))).status, 401);
const li = await post('/api/members/login', { username: 'ama.m', password: 'longenough1' }, dev(PH2));
assert.equal(li.status, 200); ok('sign-in on the new phone works');
assert.equal(db.prepare('SELECT COUNT(*) c FROM members').get().c, 1); ok('duplicate row removed');
assert.equal(db.prepare('SELECT device_id d FROM members').get().d, PH2);
assert.equal(db.prepare('SELECT device_id d FROM prayer_requests').get().d, PH2); ok('prayer requests followed the member');
assert.equal(db.prepare('SELECT COUNT(*) c FROM device_tokens').get().c, 0); ok('old phone push address dropped');
const msgs = await (await call('/api/members/messages', { headers: dev(PH2) })).json();
assert.equal(msgs.items.length, 1); ok('private messages reach the new phone');

// merge two rows that never signed in
await put('/api/members/me', { name: 'Yaw Boateng', phone: '0551112222', group: 'Men', location: 'Tema' }, dev('d'.repeat(32)));
await new Promise((r) => setTimeout(r, 5));
await put('/api/members/me', { name: 'Yaw B', phone: '055 111 2222', group: 'Men', username: 'yaw.b', password: 'longenough3' }, dev('e'.repeat(32)));
list = (await (await call('/api/admin/members', { headers: auth })).json()).items;
const yawOld = list.find((m) => m.name === 'Yaw Boateng'), yawNew = list.find((m) => m.name === 'Yaw B');
assert.deepEqual(yawOld.duplicateIds, [yawNew.id]);
db.prepare("INSERT INTO member_messages (member_id, body, sent_by, created_at) VALUES (?, 'Hi Yaw', 'Pastor', ?)").run(yawOld.id, Date.now());
assert.equal((await post('/api/admin/members/merge', { keepId: yawOld.id, removeId: yawOld.id }, auth)).status, 400);
assert.equal((await post('/api/admin/members/merge', { keepId: yawOld.id, removeId: yawNew.id })).status, 401); ok('merge needs leader login');
assert.equal((await post('/api/admin/members/merge', { keepId: yawOld.id, removeId: yawNew.id }, auth)).status, 200); ok('merge works');
const merged = db.prepare('SELECT * FROM members WHERE id = ?').get(yawOld.id);
assert.equal(merged.username, 'yaw.b'); assert.equal(merged.device_id, 'e'.repeat(32)); assert.equal(merged.location, 'Tema'); ok('kept profile gets sign-in, newest phone, own details');
assert.equal(db.prepare('SELECT COUNT(*) c FROM member_messages WHERE member_id = ?').get(yawOld.id).c, 1);
assert.equal((await post('/api/members/login', { username: 'yaw.b', password: 'longenough3' }, dev('f'.repeat(32)))).status, 200); ok('merged account can sign in');

// pastor resets / creates sign-in
const r1 = await (await put(`/api/admin/members/${yawOld.id}/account`, {}, auth)).json();
assert.equal(r1.username, 'yaw.b'); assert.equal(r1.password.length, 10); assert.equal(r1.generated, true); ok('reset generates a temporary password');
assert.equal((await post('/api/members/login', { username: 'yaw.b', password: r1.password }, dev('g'.repeat(32)))).status, 200); ok('temporary password works');
assert.equal((await post('/api/members/login', { username: 'yaw.b', password: 'longenough3' }, dev('h'.repeat(32)))).status, 401); ok('old password stops working');
assert.equal((await put(`/api/admin/members/${yawOld.id}/account`, { password: 'short' }, auth)).status, 400);
const r2 = await (await put(`/api/admin/members/${yawOld.id}/account`, { password: 'Chosen-by-pastor1' }, auth)).json();
assert.equal(r2.generated, false); ok('pastor can type a password');
await put('/api/members/me', { name: 'No Login', phone: '0270000000', group: 'Youth' }, dev('i'.repeat(32)));
const nl = db.prepare("SELECT id FROM members WHERE name = 'No Login'").get().id;
const r3 = await (await put(`/api/admin/members/${nl}/account`, {}, auth)).json();
assert.match(r3.username, /^no\.0000/); ok('member without sign-in gets one created: ' + r3.username);
assert.equal((await put(`/api/admin/members/${nl}/account`, {})).status, 401); ok('reset needs leader login');
console.log(`\nAll ${n} checks passed.`);

// ---- per-church groups and web origin (tenancy groundwork)
{
  const jireh = { ...env, CHURCH_NAME: 'Jireh Temple', CHURCH_GROUPS: 'Men,Women,Youth,Children', WEB_ORIGIN: 'https://jireh.pages.dev' };
  const callJ = (path, init = {}) => worker.fetch(new Request(`https://x.test${path}`, init), jireh, ctx);
  const putJ = (path, body, headers = {}) => callJ(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await putJ('/api/members/me', { name: 'Kid One', phone: '0200000001', group: 'Children' }, dev('k'.repeat(32)))).status, 200); ok('church with a Children group accepts it');
  assert.equal((await put('/api/members/me', { name: 'Kid Two', phone: '0200000002', group: 'Children' }, dev('l'.repeat(32)))).status, 400); ok('default church still rejects a group it does not have');
  assert.equal((await put('/api/members/me', { name: 'Man One', phone: '0200000003', group: 'Men' }, dev('m'.repeat(32)))).status, 200); ok('default groups unchanged');
  const cors = (e, origin) => worker.fetch(new Request('https://x.test/health', { headers: { origin } }), e, ctx).then((r) => r.headers.get('access-control-allow-origin'));
  assert.equal(await cors(env, 'https://calvarytemple.pages.dev'), 'https://calvarytemple.pages.dev'); ok('original Calvary deployment keeps its web address');
  assert.equal(await cors(jireh, 'https://calvarytemple.pages.dev'), null); ok("another church's site is NOT allowed by default");
  assert.equal(await cors(jireh, 'https://jireh.pages.dev'), 'https://jireh.pages.dev'); ok("church's own WEB_ORIGIN is allowed");
  const pr = await (await callJ('/pay/return?reference=abcdef123456')).text();
  assert.ok(pr.includes('Jireh Temple') && !pr.includes('Calvary')); ok('payment return page uses the church name');
  console.log(`\nAll ${n} checks passed (incl. tenancy).`);
}
