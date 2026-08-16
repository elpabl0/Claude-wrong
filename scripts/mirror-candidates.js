#!/usr/bin/env node
/**
 * Fetch a slate of open Metaculus binary questions and commit it alongside the
 * batch that draws from it.
 *
 * The mirrored questions are the only external reference point this ledger has,
 * and they are worth nothing if the community probability is recalled rather
 * than read. So the number is never typed by hand: this script fetches the
 * slate, writes it to ledger/mirror-slates/<batch>.json, and scripts/validate.js
 * then refuses any mirrored prediction whose recorded community probability does
 * not match its slate exactly. The forecaster picks which questions to mirror;
 * it does not get to pick what the crowd said.
 *
 *   node scripts/mirror-candidates.js --batch=2026-08-24 [--n=25] [--stdout]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC, daysBetween } from '../lib/config.js';
import { httpGetJson, SourceError } from '../lib/resolvers/util.js';
import { communityProbability } from '../lib/resolvers/metaculus.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const config = loadConfig();
const batch = arg('batch', todayUTC());
const want = Number(arg('n', 25));
const toStdout = process.argv.includes('--stdout');

const maxDays = config.horizon_buckets[config.horizon_buckets.length - 1].max_days;

// Several query shapes, because Metaculus has reorganised this API before.
const QUERIES = [
  'https://www.metaculus.com/api/posts/?statuses=open&forecast_type=binary&limit=100&order_by=-hotness',
  'https://www.metaculus.com/api/posts/?statuses=open&limit=100&order_by=-hotness',
  'https://www.metaculus.com/api2/questions/?status=open&type=forecast&limit=100&order_by=-activity',
];

async function fetchSlate() {
  const failures = [];
  for (const url of QUERIES) {
    try {
      const doc = await httpGetJson(url, { retries: 2, timeoutMs: 30000 });
      const results = doc.results ?? doc.posts ?? (Array.isArray(doc) ? doc : null);
      if (!Array.isArray(results) || results.length === 0) {
        failures.push(`${url}: no results array`);
        continue;
      }
      return { url, results };
    } catch (err) {
      failures.push(`${url}: ${err.message}`);
    }
  }
  throw new SourceError(`could not fetch a Metaculus slate.\n  ${failures.join('\n  ')}`);
}

/** Keep only what can actually be mirrored: open, binary, closing inside our horizon, with a crowd number. */
function usable(post) {
  const q = post.question ?? post;
  const type = q.type ?? post.type ?? q.possibilities?.type;
  if (type && !String(type).toLowerCase().includes('binary')) return null;
  if (q.resolution !== null && q.resolution !== undefined && q.resolution !== '') return null;

  const closeRaw = q.scheduled_close_time ?? q.close_time ?? post.scheduled_close_time ?? post.close_time ?? null;
  if (!closeRaw) return null;
  const close = String(closeRaw).slice(0, 10);
  const horizon = daysBetween(batch, close);
  if (horizon < 7 || horizon > maxDays) return null;

  const crowd = communityProbability(q);
  if (crowd === null) return null;
  // A market already pinned to a near-certainty is not a test of judgement.
  if (crowd < 0.05 || crowd > 0.95) return null;

  const id = post.id ?? q.post_id ?? q.id;
  if (!Number.isInteger(id)) return null;

  return {
    post_id: id,
    title: String(post.title ?? q.title ?? '').trim(),
    url: `https://www.metaculus.com/questions/${id}/`,
    community_probability: Number(crowd.toFixed(4)),
    forecaster_count: q.forecaster_count ?? post.nr_forecasters ?? null,
    scheduled_close: close,
    horizon_days: horizon,
  };
}

const { url: source, results } = await fetchSlate();
const questions = results.map(usable).filter(Boolean);

// Deduplicate, then spread across horizons so the slate is not all short-dated.
const byId = new Map(questions.map((q) => [q.post_id, q]));
const slateQuestions = [...byId.values()]
  .sort((a, b) => a.horizon_days - b.horizon_days)
  .slice(0, want);

const slate = {
  batch,
  fetched_utc: new Date().toISOString(),
  source_endpoint: source,
  scanned: results.length,
  usable: questions.length,
  note:
    'Community probabilities are recorded here as fetched. A mirrored prediction must cite one of these post_ids and reproduce its community_probability and this fetched_utc exactly; scripts/validate.js enforces that.',
  questions: slateQuestions,
};

if (toStdout) {
  console.log(JSON.stringify(slate, null, 2));
} else {
  const dir = join(paths.root, 'ledger', 'mirror-slates');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${batch}.json`);
  writeFileSync(file, JSON.stringify(slate, null, 2) + '\n');
  console.log(`Wrote ${file}: ${slateQuestions.length} usable of ${results.length} scanned, via ${source}`);
  for (const q of slateQuestions.slice(0, 40)) {
    console.log(`  ${String(q.post_id).padStart(7)}  crowd ${String(q.community_probability).padEnd(6)}  closes ${q.scheduled_close} (${q.horizon_days}d)  ${q.title.slice(0, 90)}`);
  }
}
