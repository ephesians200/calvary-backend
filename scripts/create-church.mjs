#!/usr/bin/env node
// Creates a complete backend for one church: D1 database, R2 bucket, Worker, secrets and the pastor's login.
//
//   node scripts/create-church.mjs --slug jireh --name "Jireh Temple" --groups Men,Women,Youth,Children \
//        --app-id com.churchdome.royalhousejireh --pastor-name "Pastor Name"
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (the GitHub workflow sets them).
// Optional secrets, from the environment:  FCM_SERVICE_ACCOUNT_JSON   PAYSTACK_SECRET_KEY
// Safe to run again after a failure: it finds what was already created and carries on.
import { parseArgs } from 'node:util';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler, d1Rows, parseJson } from './lib/wrangler.mjs';
import {
  ROOT, validateInput, names, loadTenants, saveTenant, renderWranglerToml, renderAdminSql,
  MIGRATIONS_TABLE_SQL, migrationFiles, randomPassword, randomSecret, checkFcm, checkPaystack,
} from './lib/tenant.mjs';

const say = (m = '') => console.log(m);
let stepNo = 0;
const step = (m) => say(`\n[${++stepNo}] ${m}`);

export async function createChurch(input, { env = process.env } = {}) {
  const errors = validateInput(input);
  if (errors.length) throw new Error('Please fix:\n - ' + errors.join('\n - '));
  const slug = input.slug;
  const { workerName, databaseName, bucket } = names(slug);
  const scheme = input.scheme || slug;
  const pastorUsername = input.pastorUsername || 'pastor';
  const pastorName = (input.pastorName || 'Pastor').trim();

  const existing = loadTenants().find((t) => t.slug === slug);
  if (existing && existing.status !== 'creating') throw new Error(`"${slug}" already exists (tenants/${slug}.json). Nothing was changed.`);
  if (loadTenants().some((t) => t.workerName === workerName && t.slug !== slug)) throw new Error(`Worker name ${workerName} is already used by another church.`);

  const fcm = (env.FCM_SERVICE_ACCOUNT_JSON || '').trim();
  const paystack = (env.PAYSTACK_SECRET_KEY || '').trim();
  if (fcm) checkFcm(fcm);
  if (paystack) checkPaystack(paystack);

  // 1. database
  step(`Database ${databaseName}`);
  const list = parseJson(wrangler(['d1', 'list', '--json']));
  let db = list.find((d) => d.name === databaseName);
  if (db) say('  already exists, reusing it');
  else {
    wrangler(['d1', 'create', databaseName]);
    db = parseJson(wrangler(['d1', 'list', '--json'])).find((d) => d.name === databaseName);
    if (!db) throw new Error('The database was created but could not be found in the list. Run again.');
  }
  const dbId = db.uuid || db.id;

  // 2. storage
  step(`File storage ${bucket}`);
  const r2 = wrangler(['r2', 'bucket', 'create', bucket], { allowFail: true });
  if (r2.failed && !/already exists|10004/i.test(r2.output)) throw new Error(`Could not create the bucket:\n${r2.output}`);
  say(r2.failed ? '  already exists, reusing it' : '  created');

  const tenant = {
    slug, displayName: input.displayName.trim(), status: 'creating', managedBy: 'churchdome',
    workerName, database: { name: databaseName, id: dbId }, bucket, url: existing?.url || '',
    vars: {
      CHURCH_NAME: input.displayName.trim(), CHURCH_GROUPS: input.groups.split(',').map((g) => g.trim()).join(','),
      APP_SCHEME: scheme, APP_PACKAGE: input.appId, WEB_ORIGIN: (input.webOrigin || '').replace(/\/$/, ''),
    },
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  saveTenant(tenant); // saved early so a failure later does not lose the database id

  const work = mkdtempSync(join(tmpdir(), 'churchdome-'));
  const configPath = join(ROOT, `.wrangler-${slug}.toml`);
  try {
    // 3. tables
    step('Creating the tables');
    const has = d1Rows(wrangler(['d1', 'execute', databaseName, '--remote', '--json', '--command', "SELECT name FROM sqlite_master WHERE type='table' AND name='members'"]));
    if (has.length) say('  tables already there, skipping');
    else {
      wrangler(['d1', 'execute', databaseName, '--remote', '--yes', '--file', join(ROOT, 'schema.sql')]);
      say('  done');
    }
    // schema.sql is always the latest full schema, so every migration file so far counts as applied for a new church.
    const marks = migrationFiles().map((f) => `INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('${f}', ${Date.now()});`);
    const migFile = join(work, 'migrations.sql');
    writeFileSync(migFile, [MIGRATIONS_TABLE_SQL, ...marks].join('\n') + '\n');
    wrangler(['d1', 'execute', databaseName, '--remote', '--yes', '--file', migFile]);

    // 4. deploy
    step(`Deploying the Worker ${workerName}`);
    writeFileSync(configPath, renderWranglerToml(tenant));
    const out = wrangler(['deploy', '--config', configPath]);
    const url = (out.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/) || [])[0];
    if (!url) throw new Error(`The Worker deployed but its address was not found in the output:\n${out.slice(-800)}`);
    tenant.url = url;
    saveTenant(tenant);
    say(`  ${url}`);

    // 5. secrets
    step('Setting secrets');
    const secrets = { JWT_SECRET: randomSecret() };
    if (fcm) secrets.FCM_SERVICE_ACCOUNT_JSON = fcm;
    if (paystack) secrets.PAYSTACK_SECRET_KEY = paystack;
    const secretFile = join(work, 'secrets.json');
    writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
    wrangler(['secret', 'bulk', secretFile, '--config', configPath]);
    say(`  set: ${Object.keys(secrets).join(', ')}`);

    // 6. pastor
    step(`Pastor login "${pastorUsername}"`);
    const password = randomPassword(14);
    const adminFile = join(work, 'admin.sql');
    writeFileSync(adminFile, await renderAdminSql({ username: pastorUsername, name: pastorName, password }));
    wrangler(['d1', 'execute', databaseName, '--remote', '--yes', '--file', adminFile]);
    say('  created');

    // 7. prove it works
    step('Checking that it works');
    const checks = [];
    if (env.SKIP_SMOKE === '1') say('  skipped');
    else {
      let healthy = false;
      for (let i = 0; i < 8 && !healthy; i++) {
        try { healthy = (await (await fetch(`${url}/health`)).json()).ok === true; } catch { /* new Workers can take a few seconds to answer */ }
        if (!healthy) await new Promise((r) => setTimeout(r, 4000));
      }
      checks.push(['Worker answers /health', healthy]);
      if (healthy) {
        const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: pastorUsername, password }) });
        checks.push([`Pastor can sign in (HTTP ${res.status})`, res.status === 200]);
      }
      for (const [label, ok] of checks) say(`  ${ok ? 'OK ' : 'FAIL'} ${label}`);
    }

    tenant.status = 'active';
    saveTenant(tenant);
    const failed = checks.some(([, ok]) => !ok);
    return { tenant, url, pastorUsername, password, fcm: !!fcm, paystack: !!paystack, failed };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(configPath, { force: true });
  }
}

export function summary(r, input) {
  const t = r.tenant;
  const todo = [];
  if (!r.fcm) todo.push(`**Push notifications:** add the church's Firebase service-account key. Cloudflare > Workers > ${t.workerName} > Settings > Variables and Secrets > add secret \`FCM_SERVICE_ACCOUNT_JSON\` (or add GitHub secret \`FCM_${t.slug.toUpperCase()}\` and run "Set church secrets").`);
  if (!r.paystack) todo.push(`**Giving:** add secret \`PAYSTACK_SECRET_KEY\` (the church's own Paystack secret key) the same way, then set the Paystack webhook to \`${r.url}/api/paystack/webhook\`.`);
  if (!t.vars.WEB_ORIGIN) todo.push(`**Web app:** once the church's web app has an address, put it in \`tenants/${t.slug}.json\` as \`vars.WEB_ORIGIN\` and commit (the Worker redeploys itself).`);
  todo.push('**Rate limits / custom domain:** optional, see TENANCY.md.');
  return `## ${r.failed ? 'Created, but a check FAILED' : 'Church created'}: ${t.displayName}

| | |
|---|---|
| Server address | \`${r.url}/\` |
| Pastor username | \`${r.pastorUsername}\` |
| Pastor password | \`${r.password}\` (shown once, give it to the pastor) |
| Worker / database / storage | \`${t.workerName}\` / \`${t.database.name}\` / \`${t.bucket}\` |

### Put these in the Android app: \`src/${t.slug}/church.json\`
\`\`\`json
"appId": "${t.vars.APP_PACKAGE}",
"deepLinkScheme": "${t.vars.APP_SCHEME}",
"api": "${r.url}/",
\`\`\`
and make sure "groups" there has exactly these ids: \`${t.vars.CHURCH_GROUPS}\`

### Still to do
${todo.map((x) => `- ${x}`).join('\n')}
`;
}

// ---- command line -----------------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: v } = parseArgs({ options: {
    slug: { type: 'string' }, name: { type: 'string' }, groups: { type: 'string', default: 'Men,Women,Youth' }, 'app-id': { type: 'string' },
    scheme: { type: 'string' }, 'pastor-username': { type: 'string', default: 'pastor' }, 'pastor-name': { type: 'string', default: 'Pastor' }, 'web-origin': { type: 'string', default: '' },
  } });
  const input = { slug: v.slug, displayName: v.name, groups: v.groups, appId: v['app-id'], scheme: v.scheme, pastorUsername: v['pastor-username'], pastorName: v['pastor-name'], webOrigin: v['web-origin'] };
  try {
    if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.WRANGLER_BIN) throw new Error('CLOUDFLARE_API_TOKEN is not set (see TENANCY.md, one-time setup).');
    const r = await createChurch(input);
    const md = summary(r, input);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    else say('\n' + md);
    say('\nDone.' + (r.failed ? ' (a check failed, see above)' : ''));
    process.exit(r.failed ? 1 : 0);
  } catch (e) {
    console.error('\nSTOPPED: ' + e.message);
    console.error('\nNothing is lost: run the same command again and it will carry on from where it stopped.');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Church creation stopped\n\n\`\`\`\n${e.message}\n\`\`\`\nRun the workflow again with the same inputs: it carries on from where it stopped.\n`);
    process.exit(1);
  }
}
