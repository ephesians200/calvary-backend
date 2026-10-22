import { json, fail, readJson, clean, randomHex } from './util.js';
import { hashPassword, verifyPassword, signJwt, requireAdmin } from './auth.js';
import { initializeTransaction, verifyTransaction, verifyWebhookSignature } from './paystack.js';
import { sendTopicPush } from './fcm.js';
import { portalRoute } from './portal.js';

const CATEGORIES = ['General', 'Service', 'Event', 'Prayer', 'Youth', 'Women', 'Men', 'Children'];
const FUNDS = ['Offering', 'Tithe', 'Missions', 'Building'];
const EXT = {
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mp4a-latm': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};
const MAX_PART_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES = 300 * 1024 * 1024;
const KEY_RE = /^(sermon|flyer)\/[A-Za-z0-9._-]{1,120}$/;
const REF_RE = /^[A-Za-z0-9_-]{6,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error('Unhandled error', err);
      return fail('Server error', 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const m = (verb, path) => method === verb && pathname === path;

  if (m('GET', '/health')) return json({ ok: true });

  // ---- public ----
  if (m('GET', '/api/announcements')) return listAnnouncements(request, env);
  if (m('GET', '/api/media')) return listMedia(url, env);
  if (method === 'GET' && pathname.startsWith('/media/')) return serveMedia(request, env, pathname.slice(7));
  if (m('POST', '/api/auth/login')) return login(request, env);
  if (m('POST', '/api/payments/init')) return initPayment(request, env, url);
  if (m('POST', '/api/paystack/webhook')) return paystackWebhook(request, env);
  if (method === 'GET' && pathname.startsWith('/api/payments/')) return paymentStatus(env, pathname.slice('/api/payments/'.length));
  if (m('GET', '/pay/return')) return payReturn(url, env);

  // ---- members, prayer, testimonies, calendar, pastor words (handles its own auth) ----
  const portal = await portalRoute(request, env, ctx, url);
  if (portal) return portal;

  // ---- admin (JWT + active admin row required) ----
  const isAnnouncementEdit = (method === 'PUT' || method === 'DELETE') && pathname.startsWith('/api/announcements/');
  const isAdminRoute = pathname.startsWith('/api/admin/') || m('POST', '/api/announcements') || isAnnouncementEdit;
  if (isAdminRoute) {
    const admin = await requireAdmin(request, env);
    if (!admin) return fail('Unauthorized', 401);

    if (m('POST', '/api/announcements')) return createAnnouncement(request, env, ctx, admin);
    if (method === 'DELETE' && isAnnouncementEdit) return deleteAnnouncement(env, pathname.split('/').pop());
    if (method === 'PUT' && isAnnouncementEdit) return updateAnnouncement(request, env, pathname.split('/').pop());
    if (m('GET', '/api/admin/stats')) return stats(env);
    if (m('POST', '/api/admin/media/multipart/start')) return uploadStart(request, env);
    if (m('PUT', '/api/admin/media/multipart/part')) return uploadPart(request, env, url);
    if (m('POST', '/api/admin/media/multipart/complete')) return uploadComplete(request, env, ctx, admin);
    if (m('POST', '/api/admin/media/multipart/abort')) return uploadAbort(request, env);
  }

  return fail('Not found', 404);
}

// ================= auth =================
async function login(request, env) {
  const body = await readJson(request);
  const username = clean(body?.username, 64).toLowerCase();
  const password = typeof body?.password === 'string' ? body.password.slice(0, 200) : '';
  if (!username || !password) return fail('Username and password are required');

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = `${ip}|${username}`;
  const now = Date.now();
  await env.DB.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(now - 24 * 3600 * 1000).run();
  const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE key = ? AND attempted_at > ?')
    .bind(key, now - LOGIN_WINDOW_MS).first();
  if (c >= MAX_LOGIN_FAILURES) return fail('Too many attempts. Try again in 15 minutes.', 429);

  const admin = await env.DB.prepare('SELECT id, name, role, password_hash FROM admins WHERE username = ? AND active = 1').bind(username).first();
  // Always run a hash so response time doesn't reveal whether the username exists.
  const ok = admin
    ? await verifyPassword(password, admin.password_hash)
    : (await verifyPassword(password, await hashPassword('dummy-password')), false);

  if (!ok) {
    await env.DB.prepare('INSERT INTO login_attempts (key, attempted_at) VALUES (?, ?)').bind(key, now).run();
    return fail('Invalid username or password', 401);
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  const { token, expiresAt } = await signJwt({ sub: admin.id, name: admin.name, role: admin.role }, env.JWT_SECRET);
  return json({ success: true, token, name: admin.name, role: admin.role, expiresAt });
}

// ================= announcements =================
async function listAnnouncements(request, env) {
  const { c, m } = await env.DB.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM announcements WHERE deleted = 0').first();
  const etag = `W/"${c}-${m}"`;
  const cacheHeaders = { etag, 'cache-control': 'public, max-age=0, must-revalidate' };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cacheHeaders });

  const { results } = await env.DB.prepare(
    'SELECT id, title, body, category, author, created_at AS createdAt FROM announcements WHERE deleted = 0 ORDER BY created_at DESC LIMIT 100',
  ).all();
  return json({ success: true, announcements: results }, 200, cacheHeaders);
}

async function createAnnouncement(request, env, ctx, admin) {
  const body = await readJson(request);
  const title = clean(body?.title, 120);
  const text = clean(body?.body, 2000);
  const category = CATEGORIES.includes(body?.category) ? body.category : 'General';
  if (!title || !text) return fail('Title and message are required');

  const now = Date.now();
  // Author comes from the verified token, never from the client.
  const res = await env.DB.prepare(
    'INSERT INTO announcements (title, body, category, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(title, text, category, admin.name, now, now).run();

  ctx.waitUntil(sendTopicPush(env, { title, body: text }).catch((e) => console.error('push failed', e.message)));
  return json({ success: true, message: 'Announcement posted', id: res.meta.last_row_id }, 201);
}

async function updateAnnouncement(request, env, idStr) {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return fail('Invalid id');
  const body = await readJson(request);
  const title = clean(body?.title, 120);
  const text = clean(body?.body, 2000);
  const category = CATEGORIES.includes(body?.category) ? body.category : 'General';
  if (!title || !text) return fail('Title and message are required');
  const res = await env.DB.prepare('UPDATE announcements SET title = ?, body = ?, category = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .bind(title, text, category, Date.now(), id).run();
  if (!res.meta.changes) return fail('Not found', 404);
  return json({ success: true, message: 'Announcement updated' });
}

async function deleteAnnouncement(env, idStr) {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return fail('Invalid id');
  await env.DB.prepare('UPDATE announcements SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ success: true });
}

async function stats(env) {
  const q = (sql) => env.DB.prepare(sql).first();
  const [a, s, f, g] = await Promise.all([
    q('SELECT COUNT(*) AS n FROM announcements WHERE deleted = 0'),
    q("SELECT COUNT(*) AS n FROM media WHERE kind = 'sermon'"),
    q("SELECT COUNT(*) AS n FROM media WHERE kind = 'flyer'"),
    q("SELECT COUNT(*) AS n FROM payments WHERE status = 'success'"),
  ]);
  return json({ success: true, announcements: a.n, sermons: s.n, flyers: f.n, gifts: g.n });
}

// ================= media (R2) =================
async function listMedia(url, env) {
  const kind = url.searchParams.get('kind');
  if (kind !== 'sermon' && kind !== 'flyer') return fail('kind must be sermon or flyer');
  const { results } = await env.DB.prepare(
    'SELECT id, kind, title, COALESCE(speaker, \'\') AS speaker, object_key AS objectKey, created_at AS createdAt FROM media WHERE kind = ? ORDER BY created_at DESC LIMIT 100',
  ).bind(kind).all();
  const items = results.map((r) => ({ ...r, url: `${url.origin}/media/${r.objectKey}` }));
  return json({ success: true, items }, 200, { 'cache-control': 'public, max-age=60' });
}

async function serveMedia(request, env, key) {
  if (!KEY_RE.test(key)) return fail('Not found', 404);
  const rangeHeader = request.headers.get('range');
  const obj = await env.MEDIA.get(key, rangeHeader ? { range: request.headers } : undefined);
  if (!obj) return fail('Not found', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable'); // keys are unique per upload

  if (rangeHeader && obj.range) {
    const offset = obj.range.offset ?? obj.size - obj.range.suffix;
    const length = obj.range.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}

async function uploadStart(request, env) {
  const body = await readJson(request);
  const kind = body?.kind;
  const contentType = clean(body?.contentType, 100).toLowerCase();
  const ext = EXT[contentType];
  if ((kind !== 'sermon' && kind !== 'flyer') || !ext) return fail('Unsupported file type');
  if ((kind === 'sermon') !== contentType.startsWith('audio/')) return fail('File type does not match upload kind');

  const key = `${kind}/${Date.now()}-${randomHex(8)}.${ext}`;
  const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } });
  return json({ success: true, key, uploadId: upload.uploadId });
}

async function uploadPart(request, env, url) {
  const key = url.searchParams.get('key') || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber'));
  if (!KEY_RE.test(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return fail('Bad request');
  if (Number(request.headers.get('content-length') || 0) > MAX_PART_BYTES) return fail('Part too large', 413);

  const data = await request.arrayBuffer();
  if (data.byteLength === 0 || data.byteLength > MAX_PART_BYTES) return fail('Invalid part size');
  const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, data);
  return json({ success: true, partNumber: part.partNumber, etag: part.etag });
}

async function uploadComplete(request, env, ctx, admin) {
  const body = await readJson(request, 200_000);
  const key = body?.key;
  const kind = body?.kind;
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  const title = clean(body?.title, 120);
  if (!KEY_RE.test(key || '') || !key.startsWith(`${kind}/`) || !body?.uploadId || !parts.length || !title) return fail('Bad request');

  const cleanParts = parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }));
  const obj = await env.MEDIA.resumeMultipartUpload(key, body.uploadId).complete(cleanParts);
  if (obj.size > MAX_MEDIA_BYTES) {
    await env.MEDIA.delete(key);
    return fail('File too large', 413);
  }
  await env.DB.prepare(
    'INSERT INTO media (kind, title, speaker, object_key, content_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(kind, title, clean(body.speaker, 80) || null, key, obj.httpMetadata?.contentType || 'application/octet-stream', obj.size, admin.id, Date.now()).run();
  const label = kind === 'sermon' ? 'New sermon uploaded' : 'New flyer uploaded';
  ctx.waitUntil(sendTopicPush(env, { type: 'media', title: label, body: title }).catch((e) => console.error('push failed', e.message)));
  return json({ success: true, message: 'Upload complete' }, 201);
}

async function uploadAbort(request, env) {
  const body = await readJson(request);
  if (!KEY_RE.test(body?.key || '') || !body?.uploadId) return fail('Bad request');
  await env.MEDIA.resumeMultipartUpload(body.key, body.uploadId).abort().catch(() => {});
  return json({ success: true });
}

// ================= payments (Paystack, server-side) =================
async function initPayment(request, env, url) {
  const body = await readJson(request);
  const amountPesewas = body?.amountPesewas;
  const email = clean(body?.email, 320).toLowerCase();
  const fundType = FUNDS.includes(body?.fundType) ? body.fundType : null;

  if (!Number.isInteger(amountPesewas) || amountPesewas < 100 || amountPesewas > 5_000_000) return fail('Amount must be between GHS 1 and GHS 50,000');
  if (!EMAIL_RE.test(email)) return fail('A valid email is required for your receipt');
  if (!fundType) return fail('Choose what you are giving towards');

  const reference = `CT-${randomHex(12)}`;
  try {
    const tx = await initializeTransaction(env, { email, amountPesewas, reference, fundType, callbackUrl: `${url.origin}/pay/return` });
    await env.DB.prepare('INSERT INTO payments (reference, email, amount_pesewas, fund_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(reference, email, amountPesewas, fundType, Date.now()).run();
    return json({ success: true, authorizationUrl: tx.authorization_url, reference });
  } catch (e) {
    console.error('init payment failed', e.message);
    return fail('Could not start the payment. Please try again.', 502);
  }
}

async function paystackWebhook(request, env) {
  const raw = await request.text();
  const valid = await verifyWebhookSignature(env, raw, request.headers.get('x-paystack-signature'));
  if (!valid) return new Response('invalid signature', { status: 401 });

  let event;
  try { event = JSON.parse(raw); } catch { return new Response('ok'); }
  if (event.event === 'charge.success' && event.data?.reference) {
    const d = event.data;
    const row = await env.DB.prepare('SELECT amount_pesewas, currency FROM payments WHERE reference = ?').bind(d.reference).first();
    if (row && row.amount_pesewas === d.amount && row.currency === d.currency && d.status === 'success') {
      await env.DB.prepare("UPDATE payments SET status = 'success', paid_at = ? WHERE reference = ?").bind(Date.now(), d.reference).run();
    } else {
      console.error('Webhook mismatch or unknown reference', d.reference);
    }
  }
  return new Response('ok'); // always 200 once the signature is valid so Paystack stops retrying
}

async function paymentStatus(env, reference) {
  if (!REF_RE.test(reference)) return fail('Not found', 404);
  let row = await env.DB.prepare('SELECT reference, status, amount_pesewas AS amountPesewas, fund_type AS fundType FROM payments WHERE reference = ?').bind(reference).first();
  if (!row) return fail('Not found', 404);

  if (row.status !== 'success') {
    // The webhook may be delayed, so ask Paystack directly.
    try {
      const tx = await verifyTransaction(env, reference);
      const ok = tx.status === 'success' && tx.amount === row.amountPesewas && tx.currency === 'GHS';
      const next = ok ? 'success' : tx.status === 'failed' ? 'failed' : tx.status === 'abandoned' ? 'abandoned' : 'pending';
      if (next !== row.status) {
        await env.DB.prepare('UPDATE payments SET status = ?, paid_at = ? WHERE reference = ?').bind(next, ok ? Date.now() : null, reference).run();
        row = { ...row, status: next };
      }
    } catch (e) {
      console.error('verify failed', e.message);
    }
  }
  return json({ success: true, ...row });
}

function payReturn(url, env) {
  const ref = url.searchParams.get('reference') || url.searchParams.get('trxref') || '';
  if (!REF_RE.test(ref)) return new Response('Invalid reference', { status: 400 });
  const deep = `${env.APP_SCHEME || 'calvarytemple'}://give/result?reference=${encodeURIComponent(ref)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Returning to the app</title><style>body{font-family:system-ui;text-align:center;padding:48px 24px}a{display:inline-block;margin-top:24px;padding:14px 28px;background:#1F3A68;color:#fff;border-radius:12px;text-decoration:none}</style></head>
<body><h2>Thank you for giving</h2><p>Return to the Calvary Temple app to see your receipt status.</p>
<a href="${deep}">Return to the app</a><script>setTimeout(function(){location.href=${JSON.stringify(deep)}},300)</script></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'cache-control': 'no-store' },
  });
}
