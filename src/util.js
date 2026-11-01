const encoder = new TextEncoder();

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (message, status = 400) => json({ success: false, message }, status);

export function toB64Url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(str) {
  const p = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time comparison of two equal-purpose strings. */
export function safeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Reads a small JSON body. Returns null when missing, too large or malformed. */
export async function readJson(request, maxBytes = 20_000) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const MIN_PASSWORD = 8;

/** Random password from characters that are hard to mix up when read aloud (no 0/O, 1/l/I). */
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function randomPassword(length = 10) {
  let out = '';
  const limit = 256 - (256 % PW_ALPHABET.length); // reject values that would bias the pick
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += PW_ALPHABET[b % PW_ALPHABET.length];
    }
  }
  return out;
}

/**
 * Same person, different way of typing the number (024 123 4567, 0241234567, +233 24 123 4567) -> same key.
 * Uses the last 9 digits. Returns '' when there are too few digits to compare.
 */
export function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length < 7 ? '' : digits.slice(-9);
}

/**
 * The church's fellowship groups. Set per church with the CHURCH_GROUPS variable (comma separated ids, e.g. "Men,Women,Youth,Children");
 * the ids must match "groups" in the app's church.json. Defaults to the original three.
 */
export function groupsOf(env) {
  const ids = String(env?.CHURCH_GROUPS || 'Men,Women,Youth').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z]{2,20}$/.test(x));
  return ids.length ? ids : ['Men', 'Women', 'Youth'];
}
