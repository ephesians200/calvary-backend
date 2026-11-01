#!/usr/bin/env node
// Rolls the current code out to every church: applies any new database migrations, then deploys the Worker.
//   node scripts/update-churches.mjs            all churches
//   node scripts/update-churches.mjs jireh      one church
// A failure in one church never stops the others; the exit code is 1 if any failed.
import { appendFileSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler, d1Rows } from './lib/wrangler.mjs';
import { ROOT, loadTenants, renderWranglerToml, MIGRATIONS_TABLE_SQL, migrationFiles } from './lib/tenant.mjs';

export function updateChurch(t) {
  const db = t.database.name;
  const work = mkdtempSync(join(tmpdir(), 'churchdome-up-'));
  const configPath = join(ROOT, `.wrangler-${t.slug}.toml`);
  try {
    // 1. migrations first. They must be additive (new tables/columns) so the old code keeps working until the deploy lands.
    wrangler(['d1', 'execute', db, '--remote', '--yes', '--command', MIGRATIONS_TABLE_SQL]);
    const applied = new Set(d1Rows(wrangler(['d1', 'execute', db, '--remote', '--json', '--command', 'SELECT name FROM schema_migrations'])).map((r) => r.name));
    const ran = [];
    for (const f of migrationFiles().filter((f) => !applied.has(f))) {
      wrangler(['d1', 'execute', db, '--remote', '--yes', '--file', join(ROOT, 'migrations', f)]);
      const mark = join(work, 'mark.sql');
      writeFileSync(mark, `INSERT INTO schema_migrations (name, applied_at) VALUES ('${f}', ${Date.now()});\n`);
      wrangler(['d1', 'execute', db, '--remote', '--yes', '--file', mark]);
      ran.push(f);
    }
    // 2. deploy
    writeFileSync(configPath, renderWranglerToml(t));
    wrangler(['deploy', '--config', configPath]);
    return { ok: true, ran };
  } catch (e) {
    return { ok: false, error: e.message.split('\n').slice(0, 6).join('\n') };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(configPath, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const all = loadTenants().filter((t) => !only || t.slug === only);
  if (only && !all.length) { console.error(`No church "${only}" in tenants/.`); process.exit(1); }
  const rows = [];
  for (const t of all) {
    if (t.managedBy !== 'churchdome') { rows.push([t.slug, 'skipped', `managed by ${t.managedBy} (updates itself when you push to GitHub)`]); continue; }
    if (t.status !== 'active') { rows.push([t.slug, 'skipped', `status is "${t.status}": finish creating it first`]); continue; }
    process.stdout.write(`Updating ${t.slug} ... `);
    const r = updateChurch(t);
    console.log(r.ok ? 'ok' : 'FAILED');
    rows.push([t.slug, r.ok ? 'updated' : 'FAILED', r.ok ? (r.ran.length ? `migrations: ${r.ran.join(', ')}` : 'no new migrations') : r.error]);
  }
  const md = `## Church updates\n\n| Church | Result | Details |\n|---|---|---|\n${rows.map(([a, b, c]) => `| ${a} | ${b} | ${String(c).replace(/\n/g, ' ').replace(/\|/g, '/')} |`).join('\n')}\n`;
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(rows.some((r) => r[1] === 'FAILED') ? 1 : 0);
}
