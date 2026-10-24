import { safeEqual, toHex } from './util.js';

const enc = new TextEncoder();
const API = 'https://api.paystack.co';

export class PaystackError extends Error {}

async function call(env, path, init = {}) {
  const key = String(env.PAYSTACK_SECRET_KEY || '').trim();
  if (!key) throw new PaystackError('PAYSTACK_SECRET_KEY is not set on the server');
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'CalvaryTemple-Worker/1.2',
    },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !data?.status) {
    throw new PaystackError(data?.message || `Paystack returned HTTP ${res.status}${data ? '' : ' (not JSON)'}`);
  }
  return data.data;
}

export const initializeTransaction = (env, { email, amountPesewas, reference, fundType, callbackUrl }) =>
  call(env, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: amountPesewas, // integer pesewas, validated by the caller
      currency: 'GHS',
      reference,
      callback_url: callbackUrl,
      metadata: { fund_type: fundType },
    }),
  });

export const verifyTransaction = (env, reference) =>
  call(env, `/transaction/verify/${encodeURIComponent(reference)}`);

/** Paystack signs the raw body with HMAC-SHA512 using your secret key. */
export async function verifyWebhookSignature(env, rawBody, signatureHex) {
  if (!signatureHex || !env.PAYSTACK_SECRET_KEY) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(String(env.PAYSTACK_SECRET_KEY).trim()), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return safeEqual(toHex(mac), signatureHex.toLowerCase());
}
