import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const paths = {
  root: ROOT,
  config: join(ROOT, 'config', 'ledger.json'),
  predictions: join(ROOT, 'ledger', 'predictions'),
  resolutions: join(ROOT, 'ledger', 'resolutions'),
  postmortems: join(ROOT, 'ledger', 'postmortems'),
  site: join(ROOT, 'site'),
  siteStatic: join(ROOT, 'site-static'),
  docs: join(ROOT, 'docs'),
};

let cached = null;

export function loadConfig() {
  if (!cached) cached = JSON.parse(readFileSync(paths.config, 'utf8'));
  return cached;
}

/** Horizon bucket id for a span in days, per config. */
export function horizonBucket(days, config = loadConfig()) {
  for (const b of config.horizon_buckets) {
    if (days <= b.max_days) return b.id;
  }
  return config.horizon_buckets[config.horizon_buckets.length - 1].id;
}

/** Whole days between two ISO dates (UTC, calendar days). */
export function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO.slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(toISO.slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
