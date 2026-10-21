import { safeEqual, toHex } from './util.js';

const enc = new TextEncoder();
const API = 'https://api.paystack.co';

async function call(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.status) throw new Error(data?.message || `Paystack error ${res.status}`);
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
      channels: ['card', 'mobile_money'],
      metadata: { fund_type: fundType },
    }),
  });

export const verifyTransaction = (env, reference) =>
  call(env, `/transaction/verify/${encodeURIComponent(reference)}`);

/** Paystack signs the raw body with HMAC-SHA512 using your secret key. */
export async function verifyWebhookSignature(env, rawBody, signatureHex) {
  if (!signatureHex || !env.PAYSTACK_SECRET_KEY) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PAYSTACK_SECRET_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return safeEqual(toHex(mac), signatureHex.toLowerCase());
}
