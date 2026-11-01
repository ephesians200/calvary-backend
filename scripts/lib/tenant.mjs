// Shared rules for ChurchDome tenants (one church = one Worker + one D1 database + one R2 bucket).
// Everything here is plain functions so it can be tested without touching Cloudflare.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../src/auth.js';

export const ROOT = process.env.CHURCHDOME_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COMPATIBILITY_DATE = '2025-06-01';
export const BACKUP_BUCKET = 'churchdome-backups';

// ---- names -----------------------------------------------------------------------------------------------------
// Cloudflare limits: Worker names 63 chars, [a-z0-9-]; D1 names similar; R2 bucket names 3-63, lowercase letters, digits, hyphens.
export const SLUG_RE = /^[a-z][a-z0-9]{1,24}$/;
export const names = (slug) => ({
  workerName: `churchdome-${slug}`,
  databaseName: `churchdome-${slug}-db`,
  bucket: `churchdome-${slug}-media`,
});

export function validateInput(i) {
  const errors = [];
  const slug = String(i.slug || '');
  if (!SLUG_RE.test(slug)) errors.push('slug: 2-25 lowercase letters/digits, starting with a letter (e.g. "jireh"). It must match the folder name in the Android app (src/<slug>/).');
  const name = String(i.displayName || '').trim();
  if (name.length < 2 || /[<>&"'\\]/.test(name)) errors.push('display name: required, and must not contain < > & quotes or backslashes');
  const groups = String(i.groups || '').split(',').map((g) => g.trim()).filter(Boolean);
  if (!groups.length || groups.some((g) => !/^[A-Za-z]{2,20}$/.test(g))) errors.push('groups: comma separated ids, each 2-20 letters, no spaces (e.g. Men,Women,Youth). They must match "groups" in church.json');
  if (new Set(groups).size !== groups.length) errors.push('groups: two groups have the same id');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(String(i.appId || ''))) errors.push('app id: must look like com.churchdome.yourchurch (same as "appId" in church.json)');
  if (!/^[a-z][a-z0-9+.-]*$/.test(String(i.scheme || i.slug || ''))) errors.push('app scheme: lowercase letters/digits');
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(String(i.pastorUsername || 'pastor'))) errors.push('pastor username: 3-32 lowercase letters, digits, dots, dashes or underscores');
  const origin = String(i.webOrigin || '');
  if (origin && !/^https:\/\/[a-z0-9.-]+$/.test(origin.replace(/\/$/, ''))) errors.push('web origin: must look like https://something.pages.dev (no path)');
  return errors;
}

// ---- registry --------------------------------------------------------------------------------------------------
export const tenantsDir = () => join(ROOT, 'tenants');
export function loadTenants() {
  const dir = tenantsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}
export function saveTenant(t) {
  mkdirSync(tenantsDir(), { recursive: true });
  writeFileSync(join(tenantsDir(), `${t.slug}.json`), JSON.stringify(t, null, 2) + '\n');
}

// ---- generated files -------------------------------------------------------------------------------------------
const tomlStr = (s) => JSON.stringify(String(s)); // JSON strings are valid TOML basic strings

/** The wrangler config for one church. Variables come from the registry file (tenants/<slug>.json), never from the dashboard. */
export function renderWranglerToml(t) {
  const vars = Object.entries(t.vars || {}).filter(([, v]) => String(v || '').trim() !== '');
  return [
    `# Generated for ${t.slug} by scripts/lib/tenant.mjs. Do not edit: change tenants/${t.slug}.json instead.`,
    `name = ${tomlStr(t.workerName)}`,
    `main = "src/index.js"`,
    `compatibility_date = ${tomlStr(COMPATIBILITY_DATE)}`,
    `workers_dev = true`,
    ``,
    `[observability]`,
    `enabled = true`,
    ``,
    `[vars]`,
    ...vars.map(([k, v]) => `${k} = ${tomlStr(v)}`),
    ``,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = ${tomlStr(t.database.name)}`,
    `database_id = ${tomlStr(t.database.id)}`,
    ``,
    `[[r2_buckets]]`,
    `binding = "MEDIA"`,
    `bucket_name = ${tomlStr(t.bucket)}`,
    ``,
  ].join('\n');
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Leader (pastor) account. Only the hash goes into SQL; the password itself is never written to a file. */
export async function renderAdminSql({ username, name, password }) {
  const hash = await hashPassword(password);
  return `INSERT INTO admins (username, name, role, password_hash, permissions, created_at) VALUES (${sqlStr(username)}, ${sqlStr(name)}, 'admin', ${sqlStr(hash)}, '*', ${Date.now()}) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, name = excluded.name, active = 1;\n`;
}

export const MIGRATIONS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);';
export const migrationFiles = () => {
  const dir = join(ROOT, 'migrations');
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort() : [];
};

// ---- secrets ---------------------------------------------------------------------------------------------------
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function randomPassword(length = 14) {
  let out = '';
  while (out.length < length) for (const b of randomBytes(length * 2)) if (b < 224 && out.length < length) out += PW_ALPHABET[b % PW_ALPHABET.length];
  return out;
}
export const randomSecret = () => randomBytes(36).toString('base64url'); // 48 characters

// ---- secret checks (used before anything is created or changed) ------------------------------------------------
export function checkFcm(text) {
  let j; try { j = JSON.parse(text); } catch { throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole Firebase service-account file.'); }
  if (!j.client_email || !j.private_key) throw new Error('FCM_SERVICE_ACCOUNT_JSON is missing client_email / private_key: is it the service-account key (Firebase > Project settings > Service accounts > Generate new private key)?');
}
export function checkPaystack(key) {
  if (!/^sk_(test|live)_/.test(key)) throw new Error('PAYSTACK_SECRET_KEY must start with sk_test_ or sk_live_ (the SECRET key, not the public one).');
}
