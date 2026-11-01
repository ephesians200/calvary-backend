#!/usr/bin/env node
// Adds or replaces a church's secrets on its existing Worker (e.g. the Firebase key once the church has one).
//   FCM_SERVICE_ACCOUNT_JSON=... PAYSTACK_SECRET_KEY=... node scripts/set-secrets.mjs jireh [--rotate-jwt]
// Only the secrets you provide are changed; the others stay as they are. --rotate-jwt signs everyone out.
import { writeFileSync, rmSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler } from './lib/wrangler.mjs';
import { ROOT, loadTenants, renderWranglerToml, randomSecret, checkFcm, checkPaystack } from './lib/tenant.mjs';

export function setSecrets(slug, { env = process.env, rotateJwt = false } = {}) {
  const t = loadTenants().find((x) => x.slug === slug);
  if (!t) throw new Error(`No church "${slug}" in tenants/.`);
  if (t.managedBy !== 'churchdome') throw new Error(`${slug} is managed by ${t.managedBy}: set its secrets in the Cloudflare dashboard (Worker > Settings > Variables and Secrets).`);
  const secrets = {};
  const fcm = (env.FCM_SERVICE_ACCOUNT_JSON || '').trim(), paystack = (env.PAYSTACK_SECRET_KEY || '').trim();
  if (fcm) { checkFcm(fcm); secrets.FCM_SERVICE_ACCOUNT_JSON = fcm; }
  if (paystack) { checkPaystack(paystack); secrets.PAYSTACK_SECRET_KEY = paystack; }
  if (rotateJwt) secrets.JWT_SECRET = randomSecret();
  if (!Object.keys(secrets).length) throw new Error(`Nothing to set. Add a GitHub secret named FCM_${slug.toUpperCase()} and/or PAYSTACK_${slug.toUpperCase()} first (or run with --rotate-jwt).`);
  const work = mkdtempSync(join(tmpdir(), 'churchdome-sec-'));
  const configPath = join(ROOT, `.wrangler-${slug}.toml`);
  try {
    writeFileSync(configPath, renderWranglerToml(t));
    writeFileSync(join(work, 's.json'), JSON.stringify(secrets), { mode: 0o600 });
    wrangler(['secret', 'bulk', join(work, 's.json'), '--config', configPath]);
  } finally { rmSync(work, { recursive: true, force: true }); rmSync(configPath, { force: true }); }
  return Object.keys(secrets);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const set = setSecrets(process.argv[2], { rotateJwt: process.argv.includes('--rotate-jwt') });
    const md = `## Secrets updated for ${process.argv[2]}\n\nSet: ${set.map((x) => `\`${x}\``).join(', ')}\n`;
    console.log(md); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  } catch (e) { console.error('STOPPED: ' + e.message); process.exit(1); }
}
