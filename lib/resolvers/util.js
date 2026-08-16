/** Shared helpers for resolvers. No third-party dependencies anywhere in this repo. */

/** A recoverable failure: the source could not be read. Triggers the grace-period retry. */
export class SourceError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.cause = cause;
  }
}

/** An unrecoverable failure: the criterion itself is broken. Never retried into a YES/NO. */
export class CriterionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CriterionError';
  }
}

export const USER_AGENT =
  'wrong.aecs.io forecasting ledger (+https://github.com/elpabl0/Claude-wrong)';

/**
 * HTTP GET with a timeout and bounded retries on transient failures.
 * Every non-2xx or network failure becomes a SourceError, so the caller cannot
 * mistake "the site was down" for "the thing did not happen".
 */
export async function httpGet(url, { fetchFn = globalThis.fetch, timeoutMs = 20000, retries = 2, headers = {}, accept = 'application/json' } = {}) {
  let lastErr = null;
  let sendHeaders = { 'user-agent': USER_AGENT, accept, ...headers };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: ac.signal, redirect: 'follow', headers: sendHeaders });
      // A stale or wrong-scoped credential is worse than none: it turns a source
      // that would have answered anonymously into a hard failure, and eventually
      // into a void. If a request with a credential is refused, drop it and try
      // again as an anonymous caller before giving up.
      if ((res.status === 401 || res.status === 403) && sendHeaders.authorization) {
        const { authorization, ...anonymous } = sendHeaders;
        sendHeaders = anonymous;
        throw new SourceError(`HTTP ${res.status} from ${url} with credentials; retrying anonymously`);
      }
      if (!res.ok) throw new SourceError(`HTTP ${res.status} from ${url}`);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      lastErr = err instanceof SourceError ? err : new SourceError(`request to ${url} failed: ${err.message}`, { cause: err });
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Credentials for the two hosts that refuse anonymous datacenter traffic.
 * GitHub rate-limits unauthenticated calls from Actions runners to zero, and
 * Metaculus returns 403/429 without a token. Both are optional: without them the
 * resolver simply fails as a SourceError and the grace period does its job.
 */
export function authHeadersFor(url, env = process.env) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return {};
  }
  if (host === 'api.github.com') {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    return token ? { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } : {};
  }
  if (host.endsWith('metaculus.com')) {
    const token = env.METACULUS_TOKEN;
    return token ? { authorization: `Token ${token}` } : {};
  }
  return {};
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function httpGetJson(url, opts = {}) {
  const { text } = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SourceError(`response from ${url} was not valid JSON: ${err.message}`);
  }
}

/**
 * RFC 6901 JSON Pointer resolution, with `-` disallowed (no appending).
 * Returns { found, value }.
 */
export function jsonPointer(doc, pointer) {
  if (pointer === '' || pointer === '/') return { found: true, value: doc };
  if (!pointer.startsWith('/')) throw new CriterionError(`JSON pointer must start with "/" (got ${JSON.stringify(pointer)})`);
  let cur = doc;
  for (const rawTok of pointer.slice(1).split('/')) {
    const tok = rawTok.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(tok)) return { found: false, value: undefined };
      const i = Number(tok);
      if (i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return { found: false, value: undefined };
      cur = cur[tok];
    }
  }
  return { found: true, value: cur };
}

export const OPS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/** Compare an observed value to a threshold. Numeric ops require numbers on both sides. */
export function compare(observed, op, value) {
  const fn = OPS[op];
  if (!fn) throw new CriterionError(`unknown comparison operator ${JSON.stringify(op)}`);
  if (['==', '!='].includes(op)) return fn(observed, value);
  const a = typeof observed === 'string' ? Number(observed) : observed;
  if (typeof a !== 'number' || !Number.isFinite(a)) {
    throw new SourceError(`observed value ${JSON.stringify(observed)} is not numeric, cannot apply \`${op}\``);
  }
  if (typeof value !== 'number') throw new CriterionError(`threshold for \`${op}\` must be a number`);
  return fn(a, value);
}

/** Basic shape validation shared by several resolvers. */
export function requireString(cfg, key, errors, { pattern = null } = {}) {
  const v = cfg[key];
  if (typeof v !== 'string' || v.length === 0) errors.push(`\`${key}\` must be a non-empty string`);
  else if (pattern && !pattern.test(v)) errors.push(`\`${key}\` does not match ${pattern}`);
}

export function requireHttpsUrl(cfg, key, errors) {
  const v = cfg[key];
  if (typeof v !== 'string') return errors.push(`\`${key}\` must be a string`);
  let u;
  try {
    u = new URL(v);
  } catch {
    return errors.push(`\`${key}\` is not a valid URL`);
  }
  if (u.protocol !== 'https:') errors.push(`\`${key}\` must use https (got ${u.protocol})`);
}

/** Compile a user-supplied regex, refusing patterns that can blow up the runner. */
export function compileRegex(source, flags = '') {
  if (typeof source !== 'string') throw new CriterionError('regex must be a string');
  if (source.length > 300) throw new CriterionError('regex is too long (max 300 characters)');
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new CriterionError(`invalid regex: ${err.message}`);
  }
}
