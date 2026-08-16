/**
 * In-memory sliding-window rate limits.
 *
 * `register_seat` is an unauthenticated write on a public endpoint, which makes
 * it the obvious thing to abuse: every call creates a file and a commit, so a
 * loop could bloat the repository and burn the whole API quota without ever
 * placing a trade. Ordering is authenticated, but a token is free, so that needs
 * a ceiling too.
 *
 * Deliberately in-process and deliberately not durable. It resets on redeploy,
 * which is the honest trade for having no database: it stops a script, not a
 * determined distributed attacker. The protocol-level caps - orders per seat per
 * round, and the bankroll itself - are the limits that actually bound the record,
 * and those are enforced from committed state rather than from memory.
 */
export class RateLimiter {
  constructor(rules = {}) {
    this.rules = rules;
    this.hits = new Map();
  }

  /**
   * Record an attempt against a named rule.
   * Returns { ok } or { ok: false, retry_after_seconds }.
   */
  check(rule, key, now = Date.now()) {
    const spec = this.rules[rule];
    if (!spec) return { ok: true };
    const bucket = `${rule}:${key}`;
    const windowMs = spec.per_seconds * 1000;
    const times = (this.hits.get(bucket) ?? []).filter((t) => now - t < windowMs);

    if (times.length >= spec.max) {
      this.hits.set(bucket, times);
      return { ok: false, retry_after_seconds: Math.ceil((windowMs - (now - times[0])) / 1000), rule, limit: spec.max, per_seconds: spec.per_seconds };
    }
    times.push(now);
    this.hits.set(bucket, times);

    // Opportunistic sweep so a long-lived process does not accumulate buckets
    // for keys that stopped calling hours ago.
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) this.hits.delete(k);
      }
    }
    return { ok: true };
  }
}

/** Client address behind a proxy. Only the first hop is trusted-ish; it is a rate key, not an identity. */
export function clientKey(headers = {}, socketAddress = null) {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return socketAddress ?? 'unknown';
}
