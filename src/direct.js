// Sends a push to ONE phone (by its FCM token) instead of the whole "announcements" topic.
// Kept separate from fcm.js so the topic sender you already deployed is not touched.
import { toB64Url } from './util.js';

const enc = new TextEncoder();
let cached = { token: null, exp: 0 };

function pemToDer(pem) {
  const bin = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function accessToken(sa) {
  if (cached.token && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const data =
    toB64Url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) + '.' +
    toB64Url(enc.encode(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${data}.${toB64Url(sig)}` }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(`FCM auth failed: ${body.error_description || res.status}`);
  cached = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return cached.token;
}

/**
 * Data-only push to each token. `targets` = [{ device_id, token }].
 * Tokens FCM says are dead (app uninstalled) are deleted. Returns how many were accepted.
 */
export async function sendToTokens(env, targets, { type, title, body }) {
  if (!env.FCM_SERVICE_ACCOUNT_JSON || !targets.length) return 0;
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
  const auth = await accessToken(sa);
  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  let sent = 0;
  const dead = [];
  await Promise.all(targets.map(async (t) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t.token,
            data: { type, title: title.slice(0, 100), body: body.slice(0, 300) },
            android: { priority: 'HIGH' },
            webpush: { headers: { Urgency: 'high' } },
          },
        }),
      });
      if (res.ok) sent++;
      else if (res.status === 404) dead.push(t.device_id); // UNREGISTERED: app removed or token replaced
    } catch { /* one failed phone must not stop the others */ }
  }));
  for (const id of dead) await env.DB.prepare('DELETE FROM device_tokens WHERE device_id = ?').bind(id).run().catch(() => {});
  return sent;
}
