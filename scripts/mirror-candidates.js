#!/usr/bin/env node
/**
 * Fetch a slate of open crowd-forecasting questions and commit it alongside the
 * batch that draws from it.
 *
 * The mirrored questions are the only external reference point this ledger has,
 * and they are worth nothing if the community probability is recalled rather
 * than read. So the number is never typed by hand: this script fetches the
 * slate, writes it to market-slates/<batch>.json, and scripts/validate.js
 * then refuses any mirrored prediction whose recorded community probability does
 * not match its slate exactly. The forecaster picks which questions to mirror;
 * it does not get to pick what the crowd said.
 *
 * Two platforms are supported. Metaculus is the better benchmark, but its API
 * returns 403/429 to datacenter traffic unless METACULUS_TOKEN is set, and a
 * scheduled ledger cannot depend on a source that refuses its own runner.
 * Manifold's API is open. The slate takes whichever answers, and records which
 * platform each question came from.
 *
 *   node scripts/mirror-candidates.js --batch=2026-08-24 [--n=30] [--stdout]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC, daysBetween } from '../lib/config.js';
import { httpGetJson, authHeadersFor, SourceError } from '../lib/resolvers/util.js';
import { communityProbability as metaculusCrowd } from '../lib/resolvers/metaculus.js';
import { communityProbability as manifoldCrowd } from '../lib/resolvers/manifold.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const config = loadConfig();
const batch = arg('batch', todayUTC());
const want = Number(arg('n', 30));
const toStdout = process.argv.includes('--stdout');

const maxDays = config.scoring.horizon_buckets[config.scoring.horizon_buckets.length - 1].max_days;

/** Shared admissibility rules, whichever platform a question came from. */
function admissible({ close, crowd }) {
  if (!close) return false;
  const horizon = daysBetween(batch, close);
  if (horizon < 7 || horizon > maxDays) return false;
  // A market already pinned to a near-certainty is not a test of judgement.
  return crowd !== null && crowd >= 0.05 && crowd <= 0.95;
}

/* --------------------------------------------------------------- Metaculus */

const METACULUS_QUERIES = [
  'https://www.metaculus.com/api/posts/?statuses=open&forecast_type=binary&limit=100&order_by=-hotness',
  'https://www.metaculus.com/api/posts/?statuses=open&limit=100&order_by=-hotness',
  'https://www.metaculus.com/api2/questions/?status=open&type=forecast&limit=100&order_by=-activity',
];

async function fetchMetaculus() {
  const failures = [];
  for (const url of METACULUS_QUERIES) {
    try {
      const doc = await httpGetJson(url, { retries: 2, timeoutMs: 30000, headers: authHeadersFor(url) });
      const results = doc.results ?? doc.posts ?? (Array.isArray(doc) ? doc : null);
      if (!Array.isArray(results) || results.length === 0) {
        failures.push(`${url}: no results array`);
        continue;
      }
      const questions = results
        .map((post) => {
          const q = post.question ?? post;
          const type = q.type ?? post.type ?? q.possibilities?.type;
          if (type && !String(type).toLowerCase().includes('binary')) return null;
          if (q.resolution !== null && q.resolution !== undefined && q.resolution !== '') return null;

          const id = post.id ?? q.post_id ?? q.id;
          if (!Number.isInteger(id)) return null;
          const close = String(q.scheduled_close_time ?? q.close_time ?? post.scheduled_close_time ?? post.close_time ?? '').slice(0, 10) || null;
          const crowd = metaculusCrowd(q);
          if (!admissible({ close, crowd })) return null;

          return {
            platform: 'metaculus',
            question_id: String(id),
            title: String(post.title ?? q.title ?? '').trim(),
            url: `https://www.metaculus.com/questions/${id}/`,
            community_probability: Number(crowd.toFixed(4)),
            forecaster_count: q.forecaster_count ?? post.nr_forecasters ?? null,
            scheduled_close: close,
            horizon_days: daysBetween(batch, close),
            resolver: { type: 'metaculus', post_id: id },
          };
        })
        .filter(Boolean);
      return { ok: true, endpoint: url, scanned: results.length, questions };
    } catch (err) {
      failures.push(`${url}: ${err.message}`);
    }
  }
  return { ok: false, endpoint: null, scanned: 0, questions: [], error: failures.join('; ') };
}

/* ---------------------------------------------------------------- Manifold */

// `/v0/markets` returns newest-first, which is mostly thin, joky markets nobody
// is trading. Searching by liquidity and popularity instead gets the markets
// that actually have a crowd behind them - which is the entire point of using
// one as a benchmark. The plain listing stays as a fallback.
const MANIFOLD_SEARCHES = ['liquidity', 'most-popular', 'close-date'].map(
  (sort) => `https://api.manifold.markets/v0/search-markets?term=&sort=${sort}&filter=open&contractType=BINARY&limit=250`,
);
const MANIFOLD_FALLBACK = 'https://api.manifold.markets/v0/markets?limit=1000';

/** A market nobody is trading is not a crowd. */
const MIN_TRADERS = 25;

async function fetchManifold() {
  const endpoints = [];
  const raw = new Map();
  const failures = [];

  for (const url of [...MANIFOLD_SEARCHES, MANIFOLD_FALLBACK]) {
    // The fallback is only worth paying for if the searches produced nothing.
    if (url === MANIFOLD_FALLBACK && raw.size > 0) break;
    try {
      const list = await httpGetJson(url, { retries: 1, timeoutMs: 30000 });
      if (!Array.isArray(list)) {
        failures.push(`${url}: response was not an array`);
        continue;
      }
      endpoints.push(url);
      for (const m of list) if (m && typeof m.id === 'string') raw.set(m.id, m);
    } catch (err) {
      failures.push(`${url}: ${err.message}`);
    }
  }

  if (raw.size === 0) {
    return { ok: false, endpoint: null, scanned: 0, questions: [], error: failures.join('; ') || 'no markets returned' };
  }

  try {
    const results = [...raw.values()];
    const questions = results
      .map((m) => {
        if (m.outcomeType !== 'BINARY' || m.isResolved) return null;
        if (typeof m.id !== 'string') return null;
        const close = Number.isFinite(m.closeTime) ? new Date(m.closeTime).toISOString().slice(0, 10) : null;
        const crowd = manifoldCrowd(m);
        if (!admissible({ close, crowd })) return null;
        if ((m.uniqueBettorCount ?? 0) < MIN_TRADERS) return null;

        return {
          platform: 'manifold',
          question_id: m.id,
          title: String(m.question ?? '').trim(),
          url: m.url ?? `https://manifold.markets/market/${m.id}`,
          community_probability: Number(crowd.toFixed(4)),
          forecaster_count: m.uniqueBettorCount ?? null,
          volume: typeof m.volume === 'number' ? Math.round(m.volume) : null,
          scheduled_close: close,
          horizon_days: daysBetween(batch, close),
          resolver: { type: 'manifold', market_id: m.id },
        };
      })
      .filter(Boolean)
      // Deepest crowds first, so the reference point is as strong as available.
      .sort((a, b) => (b.forecaster_count ?? 0) - (a.forecaster_count ?? 0));
    return { ok: true, endpoint: endpoints.join(' + '), scanned: results.length, questions };
  } catch (err) {
    return { ok: false, endpoint: endpoints.join(' + ') || null, scanned: raw.size, questions: [], error: err.message };
  }
}

/* -------------------------------------------------------------------- main */

const [metaculus, manifold] = await Promise.all([fetchMetaculus(), fetchManifold()]);
const sources = { metaculus, manifold };

const all = [...metaculus.questions, ...manifold.questions];
if (all.length === 0) {
  throw new SourceError(
    `no crowd questions could be fetched.\n  metaculus: ${metaculus.error ?? 'no usable questions'}\n  manifold: ${manifold.error ?? 'no usable questions'}`,
  );
}

// Take the deepest crowds first, but round-robin across platform and horizon
// bucket so a slate is never accidentally all one source or all short-dated -
// the batch quotas need long-horizon questions to draw from too.
const buckets = new Map();
for (const q of all) {
  const bucket = config.scoring.horizon_buckets.find((b) => q.horizon_days <= b.max_days)?.id ?? 'long';
  const key = `${q.platform}:${bucket}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(q);
}
for (const list of buckets.values()) list.sort((a, b) => (b.forecaster_count ?? 0) - (a.forecaster_count ?? 0));

const picked = [];
const lists = [...buckets.values()];
for (let i = 0; picked.length < want && lists.some((l) => l[i]); i++) {
  for (const list of lists) {
    if (list[i] && picked.length < want) picked.push(list[i]);
  }
}
picked.sort((a, b) => a.horizon_days - b.horizon_days || a.platform.localeCompare(b.platform));

const slate = {
  batch,
  fetched_utc: new Date().toISOString(),
  sources: Object.fromEntries(
    Object.entries(sources).map(([k, v]) => [k, { ok: v.ok, endpoint: v.endpoint, scanned: v.scanned, usable: v.questions.length, error: v.error ?? null }]),
  ),
  note:
    'Community probabilities are recorded here as fetched. A mirrored prediction must cite one of these question_ids and reproduce its community_probability and this fetched_utc exactly; scripts/validate.js enforces that.',
  questions: picked,
};

if (toStdout) {
  console.log(JSON.stringify(slate, null, 2));
} else {
  // paths.slates, not a path spelled out again here. This wrote to
  // ledger/mirror-slates/ while validate.js, verify-integrity.js and slate.yml
  // all read market-slates/, so no slate was ever committed - and because
  // validate.js rejects a mirrored question with no committed slate, the two
  // mirrored questions every batch is required to carry could not be written at
  // all. A silent path disagreement blocked the whole weekly run.
  const dir = paths.slates;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${batch}.json`);
  writeFileSync(file, JSON.stringify(slate, null, 2) + '\n');
  console.log(`Wrote ${file}: ${picked.length} candidates`);
  for (const [name, s] of Object.entries(sources)) {
    console.log(`  ${name.padEnd(10)} ${s.ok ? `${s.questions.length} usable of ${s.scanned} scanned` : `UNAVAILABLE — ${s.error}`}`);
  }
  for (const q of picked.slice(0, 40)) {
    console.log(`  ${q.platform.padEnd(9)} ${String(q.question_id).padStart(8)}  crowd ${String(q.community_probability).padEnd(6)}  ${String(q.forecaster_count ?? '?').padStart(4)} forecasters  closes ${q.scheduled_close} (${q.horizon_days}d)  ${q.title.slice(0, 70)}`);
  }
}
