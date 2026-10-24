import { fromB64Url, toB64Url, safeEqual } from './util.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 100_000; // Workers WebCrypto caps PBKDF2 at 100k iterations
export const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

const hmacKey = (secret, usage) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);

export async function signJwt(payload, secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const data = `${toB64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${toB64Url(enc.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(data));
  return { token: `${data}.${toB64Url(sig)}`, expiresAt: body.exp * 1000 };
}

export async function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(fromB64Url(parts[0])));
    if (header.alg !== 'HS256') return null;
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, ['verify']),
      fromB64Url(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(fromB64Url(parts[1])));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

/** Format: pbkdf2$<iterations>$<saltB64url>$<hashB64url> */
export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64Url(salt)}$${toB64Url(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const bits = await derive(password, fromB64Url(salt), Math.min(Number(iter) || PBKDF2_ITERATIONS, PBKDF2_ITERATIONS));
  return safeEqual(toB64Url(bits), hash);
}

/** Every leader-portal button that can be switched on or off for an account. '*' means all of them. */
export const PERMISSIONS = ['members', 'calendar', 'prayer', 'testimonies', 'pastor', 'announcements', 'upload', 'notice', 'users'];

export function parsePermissions(raw) {
  const text = String(raw ?? '*').trim();
  if (text === '*' || text === '') return ['*'];
  const list = text.split(',').map((x) => x.trim()).filter((x) => PERMISSIONS.includes(x));
  return [...new Set(list)];
}

export const serializePermissions = (list) => (list.includes('*') ? '*' : list.join(','));
export const can = (admin, perm) => !perm || admin.permissions.includes('*') || admin.permissions.includes(perm);

/** Returns { id, name, role, permissions[] } for a valid, still-active admin; otherwise null. */
export async function requireAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const payload = await verifyJwt(header.slice(7), env.JWT_SECRET);
  if (!payload || payload.role !== 'admin') return null;
  const row = await env.DB.prepare('SELECT id, name, role, permissions FROM admins WHERE id = ? AND active = 1').bind(payload.sub).first();
  if (!row || row.role !== 'admin') return null;
  return { id: row.id, name: row.name, role: row.role, permissions: parsePermissions(row.permissions) };
}
