#!/usr/bin/env node
/**
 * Validate the whole ledger: record schemas, batch quotas, and the join between
 * predictions and resolutions. Run in CI on every push, so a malformed or
 * quota-dodging batch cannot land.
 *
 * Usage: node scripts/validate.js [--strict-quotas=false]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, daysBetween, horizonBucket } from '../lib/config.js';
import { loadPredictionFiles, loadResolutionFiles } from '../lib/ledger.js';
import { validatePrediction, validateResolution } from '../lib/schema.js';

const args = new Set(process.argv.slice(2));
const strictQuotas = !args.has('--no-strict-quotas');

const config = loadConfig();
const errors = [];
const warnings = [];

const predFiles = loadPredictionFiles();
const resFiles = loadResolutionFiles();

// ---------------------------------------------------------------- predictions
const seen = new Map();
for (const { file, record } of predFiles) {
  const { errors: errs } = validatePrediction(record, { config, filename: file });
  errors.push(...errs);

  if (record?.id && `${record.id}.json` !== file) {
    errors.push(`${file}: filename must be \`${record.id}.json\``);
  }
  if (record?.id) {
    if (seen.has(record.id)) errors.push(`${file}: duplicate id, also in ${seen.get(record.id)}`);
    else seen.set(record.id, file);
  }
}

// --------------------------------------------------- mirrored questions
// The crowd's probability is the one number on this site the forecaster must not
// be able to choose. It has to come from a slate that was fetched and committed,
// and it has to match that slate exactly.
const slates = new Map();
const slateDir = join(paths.root, 'ledger', 'mirror-slates');
if (existsSync(slateDir)) {
  for (const f of readdirSync(slateDir).filter((f) => f.endsWith('.json'))) {
    try {
      const slate = JSON.parse(readFileSync(join(slateDir, f), 'utf8'));
      slates.set(slate.batch ?? f.replace(/\.json$/, ''), slate);
    } catch (err) {
      errors.push(`ledger/mirror-slates/${f}: not valid JSON (${err.message})`);
    }
  }
}

for (const { file, record } of predFiles) {
  if (record?.origin !== 'crowd-mirror') continue;
  const x = record.external_reference;
  if (!x || typeof x !== 'object') continue; // already reported by the schema check

  const slate = slates.get(record.batch);
  if (!slate) {
    errors.push(`${file}: mirrors a crowd forecast but there is no fetched slate at ledger/mirror-slates/${record.batch}.json`);
    continue;
  }
  const q = (slate.questions ?? []).find(
    (s) => s.platform === x.platform && String(s.question_id) === String(x.question_id),
  );
  if (!q) {
    errors.push(`${file}: ${x.platform} question ${x.question_id} is not in the ${record.batch} slate - a mirrored question must be drawn from the slate that was fetched that day`);
    continue;
  }
  if (q.community_probability !== x.community_probability) {
    errors.push(`${file}: records the community at ${x.community_probability} but the ${record.batch} slate fetched ${q.community_probability}`);
  }
  if (slate.fetched_utc !== x.snapshot_utc) {
    errors.push(`${file}: snapshot_utc ${x.snapshot_utc} does not match the slate's fetched_utc ${slate.fetched_utc}`);
  }
}

// -------------------------------------------------------------- batch quotas
const batches = new Map();
for (const { record } of predFiles) {
  if (!record?.batch) continue;
  if (!batches.has(record.batch)) batches.set(record.batch, []);
  batches.get(record.batch).push(record);
}

const q = config.quotas;
for (const [batch, recs] of [...batches.entries()].sort()) {
  const label = `batch ${batch}`;
  const report = strictQuotas ? errors : warnings;

  if (recs.length !== config.cadence.batch_size) {
    report.push(`${label}: has ${recs.length} predictions, the protocol fixes the batch at ${config.cadence.batch_size}`);
  }

  for (const [cat, spec] of Object.entries(config.categories)) {
    const n = recs.filter((r) => r.category === cat).length;
    if (n !== spec.quota_per_batch) {
      report.push(`${label}: category \`${cat}\` has ${n} predictions, quota is exactly ${spec.quota_per_batch}`);
    }
  }

  const count = (fn) => recs.filter(fn).length;
  const checks = [
    ['continuity claims', count((r) => r.claim_type === 'continuity'), q.min_continuity_claims_per_batch],
    ['mirrored questions', count((r) => r.origin === 'crowd-mirror'), q.min_mirrored_per_batch],
    ['short-horizon questions', count((r) => horizonBucket(daysBetween(r.batch, r.resolution_date), config) === 'short'), q.min_short_horizon_per_batch],
    ['long-horizon questions', count((r) => horizonBucket(daysBetween(r.batch, r.resolution_date), config) === 'long'), q.min_long_horizon_per_batch],
  ];
  for (const [what, got, min] of checks) {
    if (got < min) report.push(`${label}: ${got} ${what}, protocol requires at least ${min}`);
  }

  const confident = count((r) => r.probability >= 0.9 || r.probability <= 0.1);
  if (confident > q.max_probability_mass_above_0_9) {
    report.push(`${label}: ${confident} predictions sit outside [0.1, 0.9], the protocol allows at most ${q.max_probability_mass_above_0_9} - a batch of near-certainties is not a forecast`);
  }

  const questions = recs.map((r) => r.question.trim().toLowerCase());
  if (new Set(questions).size !== questions.length) {
    errors.push(`${label}: contains duplicate questions`);
  }
  if (recs.some((r) => r.protocol_version !== config.protocol_version)) {
    warnings.push(`${label}: written under a different protocol_version than the current one (${config.protocol_version}) - scoring will segment on it`);
  }
}

// --------------------------------------------------------------- resolutions
const byId = new Map(predFiles.map(({ record }) => [record?.id, record]));
for (const { file, record } of resFiles) {
  const pred = byId.get(record?.id) ?? null;
  if (!pred) {
    errors.push(`${file}: resolution has no matching prediction (id ${JSON.stringify(record?.id)})`);
  }
  const { errors: errs } = validateResolution(record, pred, { filename: file });
  errors.push(...errs);
  if (record?.id && `${record.id}.json` !== file) {
    errors.push(`${file}: filename must be \`${record.id}.json\``);
  }
  if (pred && record?.resolved_utc && record.resolved_utc.slice(0, 10) < pred.resolution_date) {
    errors.push(`${file}: resolved on ${record.resolved_utc.slice(0, 10)}, before its own resolution date ${pred.resolution_date}`);
  }
}

// -------------------------------------------------------------------- output
for (const w of warnings) console.warn(`warning  ${w}`);
for (const e of errors) console.error(`error    ${e}`);

const summary = `${predFiles.length} predictions, ${resFiles.length} resolutions, ${batches.size} batches`;
if (errors.length) {
  console.error(`\nFAILED: ${errors.length} error(s), ${warnings.length} warning(s). ${summary}`);
  process.exit(1);
}
console.log(`OK: ${summary}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
