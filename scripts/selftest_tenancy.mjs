// Offline test of the tenancy tooling (create / update / backup) using a fake wrangler with real SQLite databases.
// Run: node --no-warnings scripts/selftest_tenancy.mjs     (Node 22+)
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const sandbox = mkdtempSync(join(tmpdir(), 'cd-test-'));
for (const p of ['src', 'scripts', 'schema.sql', 'tenants']) cpSync(join(repo, p), join(sandbox, p), { recursive: true });
mkdirSync(join(sandbox, 'migrations'), { recursive: true });
writeFileSync(join(sandbox, 'migrations', '0005_old.sql'), 'ALTER TABLE members ADD COLUMN old_col TEXT;\n'); // already inside schema.sql for a NEW church? no: see below
rmSync(join(sandbox, 'migrations', '0005_old.sql')); // keep the first run clean; added later

const fake = join(sandbox, 'scripts/testing/fake-wrangler.mjs');
const fakeDir = join(sandbox, 'fake-cloudflare');
process.env.CHURCHDOME_ROOT = sandbox;
process.env.WRANGLER_BIN = fake;
process.env.FAKE_DIR = fakeDir;
process.env.SKIP_SMOKE = '1';

const { createChurch, summary } = await import(join(sandbox, 'scripts/create-church.mjs'));
const { updateChurch } = await import(join(sandbox, 'scripts/update-churches.mjs'));
const { loadTenants } = await import(join(sandbox, 'scripts/lib/tenant.mjs'));
const worker = (await import(join(sandbox, 'src/index.js'))).default;
const log = () => readFileSync(join(fakeDir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
let n = 0; const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);

const input = { slug: 'jireh', displayName: 'Jireh Temple', groups: 'Men,Women,Youth,Children', appId: 'com.churchdome.royalhousejireh', scheme: 'royalhousejireh', pastorUsername: 'pastor', pastorName: 'Pastor Kwame', webOrigin: '' };
const FCM = JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', project_id: 'jireh' });

// ---------- input validation
const { validateInput } = await import(join(sandbox, 'scripts/lib/tenant.mjs'));
assert.ok(validateInput({ ...input, slug: 'Bad Slug' }).length); ok('bad slug refused');
assert.ok(validateInput({ ...input, groups: 'Men,Women Fellowship' }).length); ok('group id with a space refused');
assert.ok(validateInput({ ...input, appId: 'jireh' }).length); ok('bad app id refused');
assert.deepEqual(validateInput(input), []); ok('good input accepted');
await assert.rejects(() => createChurch({ ...input, slug: 'x' }), /slug/); ok('createChurch stops on bad input before touching Cloudflare');
assert.ok(!existsSync(join(fakeDir, 'log.jsonl'))); 

// ---------- create
const r = await quiet(() => createChurch(input, { env: { ...process.env, FCM_SERVICE_ACCOUNT_JSON: FCM, PAYSTACK_SECRET_KEY: 'sk_test_abc123' } }));
assert.equal(r.url, 'https://churchdome-jireh.fake-sub.workers.dev'); ok('Worker address found in deploy output');
const cmds = log().map((c) => c.slice(0, 3).join(' '));
const order = ['d1 list --json', 'd1 create churchdome-jireh-db', 'r2 bucket create', 'd1 execute churchdome-jireh-db', 'deploy --config', 'secret bulk'];
let at = -1; for (const o of order) { const i = cmds.findIndex((c, idx) => idx > at && c.startsWith(o)); assert.ok(i > at, `missing/out of order: ${o}`); at = i; }
ok('steps happen in a safe order (database, storage, tables, deploy, secrets)');
const toml = readFileSync(join(fakeDir, 'churchdome-jireh.toml'), 'utf8');
assert.match(toml, /name = "churchdome-jireh"/); assert.match(toml, /CHURCH_GROUPS = "Men,Women,Youth,Children"/); assert.match(toml, /APP_SCHEME = "royalhousejireh"/);
assert.match(toml, /database_id = "uuid-churchdome-jireh-db"/); assert.match(toml, /binding = "MEDIA"/); assert.ok(!/WEB_ORIGIN/.test(toml)); ok('Worker config has the church\'s name, groups, scheme, database and bucket (empty WEB_ORIGIN left out)');
const secrets = JSON.parse(readFileSync(join(fakeDir, 'churchdome-jireh.secrets.json'), 'utf8'));
assert.deepEqual(Object.keys(secrets).sort(), ['FCM_SERVICE_ACCOUNT_JSON', 'JWT_SECRET', 'PAYSTACK_SECRET_KEY']); assert.ok(secrets.JWT_SECRET.length >= 40); ok('JWT secret generated (40+ chars); Firebase and Paystack secrets passed through');
const t = loadTenants().find((x) => x.slug === 'jireh');
assert.equal(t.status, 'active'); assert.equal(t.url, r.url); assert.equal(t.database.id, 'uuid-churchdome-jireh-db'); ok('church recorded in tenants/jireh.json');
assert.ok(!JSON.stringify(t).includes(r.password) && !JSON.stringify(t).includes(secrets.JWT_SECRET)); ok('registry file contains no password or secret');

// ---------- the generated database really works with the REAL worker code
const sqlite = new DatabaseSync(join(fakeDir, 'churchdome-jireh-db.sqlite'));
const D1 = { prepare(sql) { const st = sqlite.prepare(sql); let args = []; const api = { bind(...x) { args = x.map((v) => (v === undefined ? null : v)); return api; }, async first() { return st.get(...args) ?? null; }, async all() { return { results: st.all(...args) }; }, async run() { const q = st.run(...args); return { meta: { last_row_id: Number(q.lastInsertRowid), changes: q.changes } }; }, _run() { return st.run(...args); } }; return api; }, async batch(l) { for (const s of l) s._run(); return []; } };
const env = { DB: D1, MEDIA: {}, JWT_SECRET: secrets.JWT_SECRET, CHURCH_NAME: 'Jireh Temple', CHURCH_GROUPS: 'Men,Women,Youth,Children' };
const call = (path, init) => worker.fetch(new Request(`https://x.test${path}`, init), env, { waitUntil() {} });
const login = (pw) => call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'pastor', password: pw }) });
assert.equal((await login(r.password)).status, 200); ok('the pastor can sign in with the generated password (real Worker login code)');
assert.equal((await login('wrong-password-1')).status, 401); ok('a wrong password is rejected');
const row = sqlite.prepare("SELECT role, permissions, name FROM admins WHERE username='pastor'").get();
assert.equal(row.role, 'admin'); assert.equal(row.permissions, '*'); assert.equal(row.name, 'Pastor Kwame'); ok('pastor has full permissions');
const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
for (const need of ['members', 'announcements', 'admins', 'payments', 'schema_migrations']) assert.ok(tables.includes(need), need); ok('all tables created, plus the migration tracker');
const md = summary(r, input); assert.ok(md.includes(r.password) && md.includes('"api": "https://churchdome-jireh.fake-sub.workers.dev/"') && md.includes('Men,Women,Youth,Children') && md.includes('WEB_ORIGIN')); ok('summary tells you exactly what to put in church.json and what is still to do');

// ---------- refuses a duplicate; second church is separate
await assert.rejects(() => quiet(() => createChurch(input)), /already exists/); ok('creating the same church twice is refused, nothing changed');
const r2 = await quiet(() => createChurch({ ...input, slug: 'grace', displayName: 'Grace Chapel', appId: 'com.churchdome.grace', scheme: 'grace', groups: 'Men,Women' }));
assert.equal(r2.url, 'https://churchdome-grace.fake-sub.workers.dev');
assert.equal(new DatabaseSync(join(fakeDir, 'churchdome-grace-db.sqlite')).prepare("SELECT COUNT(*) c FROM admins").get().c, 1);
assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM admins").get().c, 1); ok('second church gets its own database (no data shared)');
assert.ok(!readFileSync(join(fakeDir, 'churchdome-grace.toml'), 'utf8').includes('Children'));
assert.notEqual(JSON.parse(readFileSync(join(fakeDir, 'churchdome-grace.secrets.json'), 'utf8')).JWT_SECRET, secrets.JWT_SECRET); ok("each church has its own JWT secret and its own groups");

// ---------- resume after a failure
rmSync(fakeDir, { recursive: true, force: true });
for (const f of ['jireh', 'grace']) rmSync(join(sandbox, 'tenants', `${f}.json`));
process.env.FAKE_FAIL = 'deploy';
await assert.rejects(() => quiet(() => createChurch({ ...input, slug: 'resume', displayName: 'Resume Church', appId: 'com.churchdome.resume' })), /failed/);
assert.equal(loadTenants().find((x) => x.slug === 'resume').status, 'creating'); ok('a failure midway leaves a "creating" record (database id kept)');
delete process.env.FAKE_FAIL;
const rr = await quiet(() => createChurch({ ...input, slug: 'resume', displayName: 'Resume Church', appId: 'com.churchdome.resume' }));
assert.equal(loadTenants().find((x) => x.slug === 'resume').status, 'active');
assert.equal(log().filter((c) => c[0] === 'd1' && c[1] === 'create').length, 1); ok('running again carries on: no second database, church becomes active');
assert.equal(new DatabaseSync(join(fakeDir, 'churchdome-resume-db.sqlite')).prepare("SELECT COUNT(*) c FROM admins").get().c, 1);

// ---------- bad secrets are caught before anything is created
rmSync(fakeDir, { recursive: true, force: true });
await assert.rejects(() => quiet(() => createChurch({ ...input, slug: 'badsecret', displayName: 'Bad Secret', appId: 'com.churchdome.badsecret' }, { env: { ...process.env, FCM_SERVICE_ACCOUNT_JSON: '{not json' } })), /not valid JSON/);
await assert.rejects(() => quiet(() => createChurch({ ...input, slug: 'badsecret', displayName: 'Bad Secret', appId: 'com.churchdome.badsecret' }, { env: { ...process.env, PAYSTACK_SECRET_KEY: 'pk_test_public' } })), /sk_test_/);
assert.ok(!existsSync(join(fakeDir, 'log.jsonl'))); ok('wrong Firebase / Paystack values are rejected before anything is created');

// ---------- updates + migrations (the fake cloud was wiped above, so create the church again first)
rmSync(join(sandbox, 'tenants', 'resume.json'));
await quiet(() => createChurch({ ...input, slug: 'resume', displayName: 'Resume Church', appId: 'com.churchdome.resume' }));
const tj = loadTenants().find((x) => x.slug === 'resume');
writeFileSync(join(sandbox, 'migrations', '0006_add_note.sql'), 'ALTER TABLE members ADD COLUMN note TEXT;\n');
const u1 = await quiet(() => updateChurch(tj));
assert.ok(u1.ok && u1.ran.join() === '0006_add_note.sql'); ok('a new migration is applied to the church');
const cols = new DatabaseSync(join(fakeDir, 'churchdome-resume-db.sqlite')).prepare('PRAGMA table_info(members)').all().map((c) => c.name);
assert.ok(cols.includes('note')); ok('...and the column really exists');
const u2 = await quiet(() => updateChurch(tj));
assert.ok(u2.ok && u2.ran.length === 0); ok('running the update again does not re-apply it');
writeFileSync(join(sandbox, 'migrations', '0007_broken.sql'), 'ALTER TABLE nope ADD COLUMN x TEXT;\n');
const u3 = await quiet(() => updateChurch(tj));
assert.equal(u3.ok, false); assert.match(u3.error, /nope|no such table|failed/i); ok('a broken migration fails clearly instead of deploying half-updated code');
rmSync(join(sandbox, 'migrations', '0007_broken.sql'));
// a NEW church created now must not replay old migrations (schema.sql already has them)
await quiet(() => createChurch({ ...input, slug: 'later', displayName: 'Later Church', appId: 'com.churchdome.later' }));
const marked = new DatabaseSync(join(fakeDir, 'churchdome-later-db.sqlite')).prepare('SELECT name FROM schema_migrations').all().map((x) => x.name);
assert.deepEqual(marked, ['0006_add_note.sql']); ok('a church created later has existing migrations marked done');


// ---------- set secrets later, reset a lost pastor password
const { setSecrets } = await import(join(sandbox, 'scripts/set-secrets.mjs'));
const { resetPastor } = await import(join(sandbox, 'scripts/reset-pastor.mjs'));
assert.throws(() => setSecrets('later', { env: {} }), /Nothing to set/); ok('set-secrets with nothing to set explains what to do');
assert.throws(() => setSecrets('calvary', { env: { PAYSTACK_SECRET_KEY: 'sk_test_x' } }), /managed by cloudflare-git/); ok('set-secrets refuses the legacy Calvary deployment (use the dashboard)');
assert.throws(() => setSecrets('later', { env: { PAYSTACK_SECRET_KEY: 'pk_test_public' } }), /sk_test_/); ok('set-secrets rejects a public Paystack key');
const setNow = setSecrets('later', { env: { PAYSTACK_SECRET_KEY: 'sk_test_newkey', FCM_SERVICE_ACCOUNT_JSON: FCM } });
assert.deepEqual(setNow.sort(), ['FCM_SERVICE_ACCOUNT_JSON', 'PAYSTACK_SECRET_KEY']);
assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(fakeDir, 'churchdome-later.secrets.json'), 'utf8'))).sort(), ['FCM_SERVICE_ACCOUNT_JSON', 'PAYSTACK_SECRET_KEY']); ok('only the secrets provided are sent (JWT_SECRET untouched)');
const rp = await quiet(() => resetPastor('later'));
const sqliteLater = new DatabaseSync(join(fakeDir, 'churchdome-later-db.sqlite'));
const envL = { DB: { prepare(sql) { const st = sqliteLater.prepare(sql); let args = []; const api = { bind(...x) { args = x.map((v) => (v === undefined ? null : v)); return api; }, async first() { return st.get(...args) ?? null; }, async all() { return { results: st.all(...args) }; }, async run() { const q = st.run(...args); return { meta: { last_row_id: Number(q.lastInsertRowid), changes: q.changes } }; } }; return api; } }, MEDIA: {}, JWT_SECRET: 'x'.repeat(40) };
const loginL = (pw) => worker.fetch(new Request('https://x.test/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'pastor', password: pw }) }), envL, { waitUntil() {} });
assert.equal((await loginL(rp.password)).status, 200); ok('reset-pastor: the new temporary password signs in');
await assert.rejects(() => quiet(() => resetPastor('later', 'nobody')), /No leader "nobody"/); ok('reset-pastor: unknown username lists the real leaders');

// ---------- CLI: update skips the original Calvary deployment; backup includes everyone
const run = (script, args = []) => spawnSync(process.execPath, ['--no-warnings', join(sandbox, 'scripts', script), ...args], { encoding: 'utf8', env: process.env });
const up = run('update-churches.mjs');
assert.equal(up.status, 0, up.stdout + up.stderr);
assert.match(up.stdout, /calvary \| skipped \| managed by cloudflare-git/); assert.match(up.stdout, /later \| updated/); ok('update-churches skips Calvary (it updates itself) and updates the rest');
const bk = run('backup-churches.mjs');
const day = new Date().toISOString().slice(0, 10);
assert.ok(existsSync(join(fakeDir, 'r2', 'churchdome-backups', 'later', `${day}.sql`)) && existsSync(join(fakeDir, 'r2', 'churchdome-backups', 'resume', `${day}.sql`))); ok('backup saved one file per active church');
assert.match(bk.stdout, /calvary \| FAILED/); ok('backup reports a church whose database it cannot reach (Calvary is not in the fake cloud) instead of hiding it');
assert.equal(bk.status, 1); ok('...and the backup run exits with an error code, so the nightly job shows red');
rmSync(sandbox, { recursive: true, force: true });
console.log(`\nAll ${n} tenancy checks passed.`);
