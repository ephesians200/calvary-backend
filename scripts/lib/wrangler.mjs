// Thin wrapper around the wrangler command line. Tests point WRANGLER_BIN at a fake (scripts/testing/fake-wrangler.mjs).
import { spawnSync } from 'node:child_process';

export class WranglerError extends Error {
  constructor(args, result) {
    const out = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    super(`wrangler ${args.join(' ')} failed (exit ${result.status}):\n${out.slice(-1500)}`);
    this.output = out;
  }
}

/** Runs wrangler and returns its stdout. Throws WranglerError on failure unless { allowFail: true } (then returns { failed, output }). */
export function wrangler(args, { allowFail = false, cwd } = {}) {
  const bin = process.env.WRANGLER_BIN;
  const [cmd, cmdArgs] = bin ? [process.execPath, [bin, ...args]] : ['npx', ['--yes', 'wrangler@4', ...args]];
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', cwd, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    if (allowFail) return { failed: true, output: `${r.stdout || ''}\n${r.stderr || ''}` };
    throw new WranglerError(args, r);
  }
  return allowFail ? { failed: false, output: r.stdout } : r.stdout;
}

/** Wrangler prints a banner before JSON; take the first [ or { to the end. */
export function parseJson(text) {
  const i = text.search(/[\[{]/);
  if (i < 0) throw new Error(`Expected JSON from wrangler, got: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(i));
}

export function d1Rows(text) {
  const parsed = parseJson(text);
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.results || [];
}
