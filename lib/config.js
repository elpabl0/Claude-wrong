import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const paths = {
  root: ROOT,
  config: join(ROOT, 'config', 'market.json'),
  questions: join(ROOT, 'questions'),
  rounds: join(ROOT, 'rounds'),
  positions: join(ROOT, 'positions'),
  resolutions: join(ROOT, 'resolutions'),
  postmortems: join(ROOT, 'postmortems'),
  seats: join(ROOT, 'seats'),
  attempts: join(ROOT, 'attempts'),
  slates: join(ROOT, 'market-slates'),
  analysis: join(ROOT, 'analysis'),
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
  for (const b of config.scoring.horizon_buckets) {
    if (days <= b.max_days) return b.id;
  }
  return config.scoring.horizon_buckets[config.scoring.horizon_buckets.length - 1].id;
}

/** Whole calendar days between two ISO dates, in UTC. */
export function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO.slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(toISO.slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Shift an ISO date by a number of days, staying in UTC. */
export function addDays(dateISO, days) {
  const d = new Date(`${dateISO.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
