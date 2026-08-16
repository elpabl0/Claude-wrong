#!/usr/bin/env node
/**
 * The briefing the scheduled authoring instance reads before writing a batch.
 * It states what the protocol requires, what is already on the books, and what
 * still needs a post-mortem - so that none of that is decided in the moment.
 *
 *   node scripts/status.js            human-readable
 *   node scripts/status.js --json     machine-readable
 */
import { loadConfig, todayUTC } from '../lib/config.js';
import { loadLedger } from '../lib/ledger.js';
import { fullReport } from '../lib/scoring.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/config.js';

const asJson = process.argv.includes('--json');
const config = loadConfig();
const today = process.argv.find((a) => a.startsWith('--today='))?.split('=')[1] ?? todayUTC();
const ledger = loadLedger({ config, today });
const report = fullReport(ledger);

/** Next Monday (or today, if today is Monday) in UTC. */
function nextBatchDate(from = today) {
  const d = new Date(`${from}T00:00:00Z`);
  const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .indexOf(config.cadence.batch_day_utc.toLowerCase());
  const delta = (target - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const batchDate = nextBatchDate();
const alreadyWritten = ledger.entries.filter((e) => e.prediction.batch === batchDate);

const requirements = {
  batch_date: batchDate,
  batch_size: config.cadence.batch_size,
  already_written: alreadyWritten.length,
  still_needed: Math.max(0, config.cadence.batch_size - alreadyWritten.length),
  categories: Object.fromEntries(
    Object.entries(config.categories).map(([k, v]) => [
      k,
      {
        quota: v.quota_per_batch,
        written: alreadyWritten.filter((e) => e.prediction.category === k).length,
        remaining: Math.max(0, v.quota_per_batch - alreadyWritten.filter((e) => e.prediction.category === k).length),
      },
    ]),
  ),
  minimums: {
    continuity: config.quotas.min_continuity_claims_per_batch,
    mirrored: config.quotas.min_mirrored_per_batch,
    short_horizon: config.quotas.min_short_horizon_per_batch,
    long_horizon: config.quotas.min_long_horizon_per_batch,
  },
  probability_bounds: config.quotas.forbid_probability_extremes,
};

// Questions already asked, so a batch does not quietly re-ask an easy one.
const recentQuestions = ledger.entries
  .slice(0, 60)
  .map((e) => ({ id: e.prediction.id, batch: e.prediction.batch, category: e.prediction.category, question: e.prediction.question }));

const postmortemsNeeded = ledger.scored
  .filter((e) => e.brier !== null && e.brier > config.postmortem.trigger_brier_above && !e.postmortem)
  .map((e) => ({ id: e.prediction.id, brier: e.brier, probability: e.prediction.probability, outcome: e.outcome, question: e.prediction.question }));

const probeFile = join(paths.root, 'ledger', 'probe-status.json');
const probe = existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, 'utf8')) : null;
const failingSources = (probe?.results ?? []).filter((r) => !r.ok);

const payload = {
  today,
  protocol_version: config.protocol_version,
  counts: report.counts,
  requirements,
  recent_questions: recentQuestions,
  postmortems_needed: postmortemsNeeded,
  overdue_within_grace: ledger.overdue.map((e) => ({ id: e.prediction.id, resolution_date: e.prediction.resolution_date })),
  failing_sources: failingSources,
  headline: {
    mean_brier: report.overall.meanBrier,
    n_resolved: report.overall.n,
    skill_vs_base_rate: report.overall.skillVsBaseRate,
    expected_calibration_error: report.expected_calibration_error,
  },
  hypotheses: Object.fromEntries(
    Object.entries(report.hypotheses).map(([k, v]) => [k, { claim: v.claim, n: v.n, estimate: v.mean, ci: [v.lo, v.hi], verdict: v.verdict }]),
  ),
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 4) => (x === null || x === undefined ? '—' : x.toFixed(d));

console.log(`wrong.aecs.io — status for ${today} (protocol v${config.protocol_version})\n`);
console.log(`Ledger: ${report.counts.total} predictions · ${report.counts.open} open · ${report.counts.resolved} resolved · ${report.counts.void} void (${pct(report.counts.void_rate)})`);
console.log(`Score:  mean Brier ${num(report.overall.meanBrier)} over ${report.overall.n} resolved · ECE ${num(report.expected_calibration_error, 3)} · skill vs base rate ${num(report.overall.skillVsBaseRate, 3)}\n`);

console.log(`Next batch: ${batchDate} — ${requirements.still_needed} of ${config.cadence.batch_size} still to write`);
for (const [cat, r] of Object.entries(requirements.categories)) {
  console.log(`  ${cat.padEnd(20)} ${r.written}/${r.quota}${r.remaining ? `  (${r.remaining} needed)` : '  ✓'}`);
}
console.log(`  minimums: ≥${requirements.minimums.continuity} continuity, ≥${requirements.minimums.mirrored} mirrored, ≥${requirements.minimums.short_horizon} short-horizon, ≥${requirements.minimums.long_horizon} long-horizon`);
console.log(`  probabilities must sit inside [${requirements.probability_bounds.min}, ${requirements.probability_bounds.max}]\n`);

if (ledger.overdue.length) {
  console.log(`Overdue but still inside the grace period (${ledger.overdue.length}):`);
  for (const e of ledger.overdue) console.log(`  ${e.prediction.id} (due ${e.prediction.resolution_date})`);
  console.log('');
}

if (postmortemsNeeded.length) {
  console.log(`Post-mortems owed (Brier > ${config.postmortem.trigger_brier_above}) — ${postmortemsNeeded.length}:`);
  for (const p of postmortemsNeeded) console.log(`  ${p.id}  p=${p.probability} outcome=${p.outcome} Brier=${num(p.brier)}`);
  console.log('');
}

if (failingSources.length) {
  console.log(`Sources not responding as of the last probe (${probe.checked_utc}):`);
  for (const f of failingSources) console.log(`  ${f.id} (${f.type}): ${f.detail}`);
  console.log('');
}

console.log('Pre-registered hypotheses:');
for (const [k, h] of Object.entries(report.hypotheses)) {
  console.log(`  ${k} [${h.verdict.status}] n=${h.n} estimate=${num(h.mean, 3)} 95% CI [${num(h.lo, 3)}, ${num(h.hi, 3)}]`);
  console.log(`      ${h.claim}`);
}
