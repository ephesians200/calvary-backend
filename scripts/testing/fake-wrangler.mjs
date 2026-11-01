// A stand-in for `wrangler` used only by selftest_tenancy.mjs. It mimics the commands the scripts use and keeps
// real SQLite databases on disk, so the generated SQL (tables, pastor account, migrations) is genuinely executed.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR; mkdirSync(dir, { recursive: true });
const a = process.argv.slice(2);
appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(a) + '\n');
const state = () => (existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) : { dbs: [], buckets: [], workers: [] });
const save = (s) => writeFileSync(join(dir, 'state.json'), JSON.stringify(s));
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const has = (n) => a.includes(n);
const banner = ' ⛅️ wrangler 4.0.0 (fake)\n──────────────────\n';
const fail = (m) => { console.error(m); process.exit(1); };
if (process.env.FAKE_FAIL && a.join(' ').includes(process.env.FAKE_FAIL)) fail('Simulated failure for: ' + process.env.FAKE_FAIL);

const [c1, c2] = a;
const s = state();
if (c1 === 'd1' && c2 === 'list') { console.log(banner + JSON.stringify(s.dbs)); }
else if (c1 === 'd1' && c2 === 'create') { s.dbs.push({ uuid: `uuid-${a[2]}`, name: a[2] }); save(s); console.log(banner + `✅ Successfully created DB '${a[2]}'`); }
else if (c1 === 'd1' && c2 === 'execute') {
  if (!s.dbs.find((d) => d.name === a[2])) fail(`no such database ${a[2]}`);
  if (!has('--remote')) fail('must pass --remote');
  const db = new DatabaseSync(join(dir, `${a[2]}.sqlite`));
  if (flag('--file')) { db.exec(readFileSync(flag('--file'), 'utf8')); console.log(banner + 'executed file'); }
  else {
    const q = flag('--command');
    if (/^\s*select/i.test(q)) console.log(banner + JSON.stringify([{ results: db.prepare(q).all(), success: true }]));
    else { db.exec(q); console.log(banner + 'executed'); }
  }
}
else if (c1 === 'd1' && c2 === 'export') {
  if (!s.dbs.find((d) => d.name === a[2])) fail(`no such database ${a[2]}`);
  const db = new DatabaseSync(join(dir, `${a[2]}.sqlite`));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  writeFileSync(flag('--output'), `-- fake export of ${a[2]}\n-- tables: ${tables.join(',')}\n`);
}
else if (c1 === 'r2' && c2 === 'bucket') {
  if (s.buckets.includes(a[3])) fail(`✘ [ERROR] The bucket you tried to create already exists. [code: 10004]`);
  s.buckets.push(a[3]); save(s); console.log(banner + `Created bucket '${a[3]}'`);
}
else if (c1 === 'r2' && c2 === 'object') {
  const [bucket, ...key] = a[3].split('/'); const dest = join(dir, 'r2', bucket, ...key.slice(0, -1));
  mkdirSync(dest, { recursive: true }); copyFileSync(flag('--file'), join(dest, key.at(-1)));
}
else if (c1 === 'deploy') {
  const cfg = readFileSync(flag('--config'), 'utf8'); const name = cfg.match(/^name = "(.+)"/m)[1];
  if (!/database_id = "uuid-/.test(cfg)) fail('config has no real database_id');
  if (!s.dbs.length) fail('no database');
  if (!s.workers.includes(name)) s.workers.push(name); save(s);
  writeFileSync(join(dir, `${name}.toml`), cfg); appendFileSync(join(dir, 'deploys.log'), name + '\n');
  console.log(banner + `Total Upload: 120 KiB\nUploaded ${name}\nDeployed ${name} triggers (1.0 sec)\n  https://${name}.fake-sub.workers.dev\nCurrent Version ID: abc`);
}
else if (c1 === 'secret' && c2 === 'bulk') {
  const name = readFileSync(flag('--config'), 'utf8').match(/^name = "(.+)"/m)[1];
  if (!s.workers.includes(name)) fail('Worker does not exist yet: deploy first');
  copyFileSync(a[2], join(dir, `${name}.secrets.json`)); console.log(banner + 'Success! Uploaded secrets');
}
else fail(`fake wrangler: unsupported command ${a.join(' ')}`);
