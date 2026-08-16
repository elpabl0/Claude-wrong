#!/usr/bin/env node
/**
 * Fetch a slate of open crowd-forecasting questions and commit it alongside the
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

const maxDays = config.horizon_buckets[config.horizon_buckets.length - 1].max_days;

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

const MANIFOLD_URL = 'https://api.manifold.markets/v0/markets?limit=1000';

async function fetchManifold() {
  try {
    const results = await httpGetJson(MANIFOLD_URL, { retries: 2, timeoutMs: 30000 });
    if (!Array.isArray(results)) return { ok: false, endpoint: MANIFOLD_URL, scanned: 0, questions: [], error: 'response was not an array' };

    const questions = results
      .map((m) => {
        if (m.outcomeType !== 'BINARY' || m.isResolved) return null;
        if (typeof m.id !== 'string') return null;
        const close = Number.isFinite(m.closeTime) ? new Date(m.closeTime).toISOString().slice(0, 10) : null;
        const crowd = manifoldCrowd(m);
        if (!admissible({ close, crowd })) return null;
        // A market nobody is trading is not a crowd.
        if ((m.uniqueBettorCount ?? 0) < 15) return null;

        return {
          platform: 'manifold',
          question_id: m.id,
          title: String(m.question ?? '').trim(),
          url: m.url ?? `https://manifold.markets/market/${m.id}`,
          community_probability: Number(crowd.toFixed(4)),
          forecaster_count: m.uniqueBettorCount ?? null,
          scheduled_close: close,
          horizon_days: daysBetween(batch, close),
          resolver: { type: 'manifold', market_id: m.id },
        };
      })
      .filter(Boolean);
    return { ok: true, endpoint: MANIFOLD_URL, scanned: results.length, questions };
  } catch (err) {
    return { ok: false, endpoint: MANIFOLD_URL, scanned: 0, questions: [], error: err.message };
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

// Interleave the platforms so a slate is never accidentally single-source, then
// order by horizon so short-dated questions are easy to find.
const byPlatform = { metaculus: [], manifold: [] };
for (const q of all) byPlatform[q.platform].push(q);
for (const list of Object.values(byPlatform)) list.sort((a, b) => a.horizon_days - b.horizon_days);

const picked = [];
for (let i = 0; picked.length < want && (byPlatform.metaculus[i] || byPlatform.manifold[i]); i++) {
  if (byPlatform.metaculus[i] && picked.length < want) picked.push(byPlatform.metaculus[i]);
  if (byPlatform.manifold[i] && picked.length < want) picked.push(byPlatform.manifold[i]);
}

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
  const dir = join(paths.root, 'ledger', 'mirror-slates');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${batch}.json`);
  writeFileSync(file, JSON.stringify(slate, null, 2) + '\n');
  console.log(`Wrote ${file}: ${picked.length} candidates`);
  for (const [name, s] of Object.entries(sources)) {
    console.log(`  ${name.padEnd(10)} ${s.ok ? `${s.questions.length} usable of ${s.scanned} scanned` : `UNAVAILABLE — ${s.error}`}`);
  }
  for (const q of picked.slice(0, 40)) {
    console.log(`  ${q.platform.padEnd(9)} ${String(q.question_id).padStart(8)}  crowd ${String(q.community_probability).padEnd(6)}  closes ${q.scheduled_close} (${q.horizon_days}d)  ${q.title.slice(0, 80)}`);
  }
}
