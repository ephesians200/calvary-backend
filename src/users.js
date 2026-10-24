import { json, fail, readJson, clean, randomHex } from './util.js';
import { hashPassword, PERMISSIONS, parsePermissions, serializePermissions, can } from './auth.js';

const GROUPS = ['Men', 'Women', 'Youth'];
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

const cleanPassword = (v) => (typeof v === 'string' ? v.slice(0, 100) : '');

async function usernameTaken(env, username) {
  const a = await env.DB.prepare('SELECT 1 AS x FROM admins WHERE username = ?').bind(username).first();
  if (a) return true;
  const m = await env.DB.prepare('SELECT 1 AS x FROM members WHERE username = ?').bind(username).first();
  return !!m;
}

/** What the new admin may be granted: never more than the creator holds. */
function grantable(creator, body) {
  if (body?.fullAccess === true) return creator.permissions.includes('*') ? ['*'] : null;
  const asked = Array.isArray(body?.permissions) ? body.permissions.filter((p) => PERMISSIONS.includes(p)) : [];
  const list = [...new Set(asked)];
  if (list.some((p) => !can(creator, p))) return null;
  return list;
}

/** Handles /api/admin/users*. The caller must already hold the 'users' permission. */
export async function usersRoute(request, env, admin, pathname) {
  const method = request.method;
  const parts = pathname.split('/').filter(Boolean); // api, admin, users, <kind?>, <id?>
  if (parts.length === 3 && method === 'GET') return listUsers(env);
  if (parts.length === 3 && method === 'POST') return createUser(request, env, admin);
  const kind = parts[3];
  const id = Number(parts[4]);
  if (parts.length === 5 && method === 'PUT' && Number.isInteger(id) && id > 0) {
    if (kind === 'admin') return updateAdmin(request, env, admin, id);
    if (kind === 'member') return resetMemberPassword(request, env, id);
  }
  return fail('Not found', 404);
}

async function listUsers(env) {
  const admins = await env.DB.prepare('SELECT id, username, name, active, permissions, created_at AS createdAt FROM admins ORDER BY id').all();
  const members = await env.DB.prepare(
    'SELECT id, name, username, phone, created_at AS createdAt FROM members WHERE username IS NOT NULL ORDER BY id DESC LIMIT 500',
  ).all();
  return json({
    success: true,
    admins: admins.results.map((a) => ({ ...a, active: !!a.active, permissions: parsePermissions(a.permissions) })),
    members: members.results,
  });
}

async function createUser(request, env, admin) {
  const b = await readJson(request);
  const type = b?.type;
  const name = clean(b?.name, 80);
  const username = clean(b?.username, 32).toLowerCase();
  const password = cleanPassword(b?.password);
  if (type !== 'member' && type !== 'admin') return fail('Choose member or admin');
  if (!name) return fail('Full name is required');
  if (!USERNAME_RE.test(username)) return fail('Username must be 3-32 letters, numbers, dots, dashes or underscores');
  if (password.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters`);
  if (await usernameTaken(env, username)) return fail('That username is already taken', 409);

  const hash = await hashPassword(password);
  const now = Date.now();

  if (type === 'admin') {
    const perms = grantable(admin, b);
    if (perms === null) return fail('You can only give access to buttons you have yourself', 403);
    if (!perms.length) return fail('Switch on at least one button for this admin');
    const res = await env.DB.prepare(
      "INSERT INTO admins (username, name, role, password_hash, permissions, created_at) VALUES (?, ?, 'admin', ?, ?, ?)",
    ).bind(username, name, hash, serializePermissions(perms), now).run();
    return json({ success: true, id: res.meta.last_row_id, message: 'Admin account created' }, 201);
  }

  const phone = clean(b?.phone, 25);
  const group = GROUPS.includes(b?.group) ? b.group : null;
  if (phone.replace(/\D/g, '').length < 7) return fail('A valid phone number is required');
  if (!group) return fail('Choose a fellowship group');
  const res = await env.DB.prepare(
    `INSERT INTO members (device_id, name, dob, location, hometown, house_number, phone, group_name, username, password_hash, seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(`acct-${randomHex(12)}`, name, clean(b?.dob, 20), clean(b?.location, 120), clean(b?.hometown, 120), clean(b?.houseNumber, 40),
    phone, group, username, hash, now, now).run();
  return json({ success: true, id: res.meta.last_row_id, message: 'Member account created' }, 201);
}

async function updateAdmin(request, env, admin, id) {
  const target = await env.DB.prepare('SELECT id, permissions, active FROM admins WHERE id = ?').bind(id).first();
  if (!target) return fail('Not found', 404);
  const targetIsFull = parsePermissions(target.permissions).includes('*');
  if (targetIsFull && !admin.permissions.includes('*')) return fail('Only a full-access admin can change this account', 403);

  const b = await readJson(request);
  const sets = [];
  const args = [];

  if (b && 'permissions' in b || b?.fullAccess !== undefined) {
    if (id === admin.id) return fail('You cannot change your own access', 403);
    const perms = grantable(admin, b);
    if (perms === null) return fail('You can only give access to buttons you have yourself', 403);
    if (!perms.length) return fail('Switch on at least one button');
    sets.push('permissions = ?'); args.push(serializePermissions(perms));
  }
  if (typeof b?.active === 'boolean') {
    if (id === admin.id) return fail('You cannot disable your own account', 403);
    sets.push('active = ?'); args.push(b.active ? 1 : 0);
  }
  if (b?.password !== undefined) {
    const pw = cleanPassword(b.password);
    if (pw.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters`);
    sets.push('password_hash = ?'); args.push(await hashPassword(pw));
  }
  if (!sets.length) return fail('Nothing to change');
  await env.DB.prepare(`UPDATE admins SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
  return json({ success: true, message: 'Account updated' });
}

async function resetMemberPassword(request, env, id) {
  const b = await readJson(request);
  const pw = cleanPassword(b?.password);
  if (pw.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters`);
  const res = await env.DB.prepare('UPDATE members SET password_hash = ? WHERE id = ? AND username IS NOT NULL').bind(await hashPassword(pw), id).run();
  if (!res.meta.changes) return fail('Not found', 404);
  return json({ success: true, message: 'Password changed' });
}
