import { toB64Url } from './util.js';

const enc = new TextEncoder();
let cached = { token: null, exp: 0 };

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
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
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
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
 * Sends a DATA-ONLY message to the "announcements" topic. Data-only messages always reach
 * onMessageReceived() in the app (even in the background), so the app can refresh its cache
 * and show the notification on its own channel.
 */
export async function sendTopicPush(env, { title, body, type = 'announcement', topic = 'announcements' }) {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return { skipped: true };
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
  const token = await accessToken(sa);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        topic,
        data: { type, title: title.slice(0, 100), body: body.slice(0, 300) },
        android: { priority: 'HIGH' },
      },
    }),
  });
  if (!res.ok) throw new Error(`FCM send failed: ${res.status} ${await res.text()}`);
  return { sent: true };
}
