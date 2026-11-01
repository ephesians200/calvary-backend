#!/usr/bin/env node
// Gives a church's leader a new temporary password (lost password / locked out).
//   node scripts/reset-pastor.mjs jireh [username]      (username defaults to "pastor")
// The new password is shown once (in the GitHub run summary, or on screen).
import { writeFileSync, rmSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler, d1Rows } from './lib/wrangler.mjs';
import { loadTenants, randomPassword } from './lib/tenant.mjs';
import { hashPassword } from '../src/auth.js';

export async function resetPastor(slug, username = 'pastor') {
  const t = loadTenants().find((x) => x.slug === slug);
  if (!t) throw new Error(`No church "${slug}" in tenants/.`);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Invalid username.');
  const db = t.database.name;
  const found = d1Rows(wrangler(['d1', 'execute', db, '--remote', '--json', '--command', `SELECT username FROM admins WHERE username = '${username}'`]));
  if (!found.length) {
    const all = d1Rows(wrangler(['d1', 'execute', db, '--remote', '--json', '--command', 'SELECT username FROM admins ORDER BY id']));
    throw new Error(`No leader "${username}" in ${slug}. Existing leaders: ${all.map((r) => r.username).join(', ') || '(none)'}`);
  }
  const password = randomPassword(14);
  const work = mkdtempSync(join(tmpdir(), 'churchdome-rp-'));
  try {
    writeFileSync(join(work, 'r.sql'), `UPDATE admins SET password_hash = '${await hashPassword(password)}', active = 1 WHERE username = '${username}';\n`);
    wrangler(['d1', 'execute', db, '--remote', '--yes', '--file', join(work, 'r.sql')]);
  } finally { rmSync(work, { recursive: true, force: true }); }
  return { username, password, url: t.url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = await resetPastor(process.argv[2], process.argv[3] || 'pastor');
    const md = `## New password for ${process.argv[2]}\n\n| | |\n|---|---|\n| Username | \`${r.username}\` |\n| Temporary password | \`${r.password}\` (shown once) |\n`;
    console.log(md); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  } catch (e) { console.error('STOPPED: ' + e.message); process.exit(1); }
}
