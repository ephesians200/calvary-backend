#!/usr/bin/env node
// Copies every church's database (members, messages, prayer requests, payments...) into a private R2 bucket in your account.
//   node scripts/backup-churches.mjs        (the nightly GitHub workflow runs this)
// Files: churchdome-backups/<church>/<YYYY-MM-DD>.sql   Restore: wrangler d1 execute <db> --remote --file <that file>
// NOT included: uploaded sermon/media files (they stay in each church's own media bucket).
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler } from './lib/wrangler.mjs';
import { loadTenants, BACKUP_BUCKET } from './lib/tenant.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const date = new Date().toISOString().slice(0, 10);
  const work = mkdtempSync(join(tmpdir(), 'churchdome-bk-'));
  const rows = [];
  try {
    const made = wrangler(['r2', 'bucket', 'create', BACKUP_BUCKET], { allowFail: true });
    if (made.failed && !/already exists|10004/i.test(made.output)) { console.error(`Cannot create the backup bucket:\n${made.output}`); process.exit(1); }
    for (const t of loadTenants().filter((t) => t.status === 'active')) {
      process.stdout.write(`Backing up ${t.slug} ... `);
      try {
        const file = join(work, `${t.slug}.sql`);
        wrangler(['d1', 'export', t.database.name, '--remote', '--output', file]);
        const bytes = statSync(file).size;
        wrangler(['r2', 'object', 'put', `${BACKUP_BUCKET}/${t.slug}/${date}.sql`, '--file', file, '--remote', '--content-type', 'application/sql']);
        console.log('ok');
        rows.push([t.slug, 'saved', `${BACKUP_BUCKET}/${t.slug}/${date}.sql (${(bytes / 1024).toFixed(1)} KB)`]);
      } catch (e) {
        console.log('FAILED');
        rows.push([t.slug, 'FAILED', e.message.split('\n').slice(0, 4).join(' ')]);
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const md = `## Backups ${date}\n\n| Church | Result | Details |\n|---|---|---|\n${rows.map(([a, b, c]) => `| ${a} | ${b} | ${String(c).replace(/\|/g, '/')} |`).join('\n')}\n`;
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(rows.some((r) => r[1] === 'FAILED') ? 1 : 0);
}
