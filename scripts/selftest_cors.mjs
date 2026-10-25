// Checks the CORS rules the web app depends on. Run with: node scripts/selftest_cors.mjs
import worker from '../src/index.js';
import assert from 'node:assert/strict';
const env = {};
const ctx = { waitUntil() {} };
const call = (method, path, origin) => worker.fetch(new Request('https://w.example' + path, { method, headers: origin ? { origin } : {} }), env, ctx);

let r = await call('OPTIONS', '/api/members/me', 'https://calvarytemple.pages.dev');
assert.equal(r.status, 204);
assert.equal(r.headers.get('access-control-allow-origin'), 'https://calvarytemple.pages.dev');
assert.match(r.headers.get('access-control-allow-headers'), /x-device-id/);
console.log('  ✓ preflight allowed for the Pages site');

r = await call('GET', '/health', 'https://abc123.calvarytemple.pages.dev');
assert.equal(r.headers.get('access-control-allow-origin'), 'https://abc123.calvarytemple.pages.dev');
console.log('  ✓ Pages preview URLs allowed');

r = await call('GET', '/health', 'https://evil.example');
assert.equal(r.headers.get('access-control-allow-origin'), null);
r = await call('OPTIONS', '/health', 'https://evil.example');
assert.equal(r.headers.get('access-control-allow-origin'), null);
console.log('  ✓ other sites get no CORS headers');

r = await call('GET', '/health');
assert.equal((await r.json()).ok, true);
console.log('  ✓ /health still works without an Origin\n\nAll CORS checks passed.');
