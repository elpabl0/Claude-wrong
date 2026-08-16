#!/usr/bin/env node
/**
 * Validate the whole market: record schemas, batch quotas, the crowd slate join,
 * bankroll solvency, and the arithmetic of every cleared round.
 *
 * Runs in CI on every push, so a malformed question, an over-staked seat, or a
 * clearing that does not add up cannot land.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, daysBetween, horizonBucket, todayUTC } from '../lib/config.js';
import { loadMarket, loadQuestions, loadSeats, loadResolutions, readJsonl, commitmentsFile } from '../lib/market.js';
import { validateQuestion, validateSeat, validateResolution } from '../lib/schema.js';
import { clearRound } from '../lib/auction.js';

const strictQuotas = !process.argv.includes('--no-strict-quotas');
const config = loadConfig();
const errors = [];
const warnings = [];

const questionFiles = loadQuestions();
const seatFiles = loadSeats();
const resolutionFiles = loadResolutions();

/* -------------------------------------------------------------------- seats */
const seatIds = new Set();
for (const { file, record } of seatFiles) {
  errors.push(...validateSeat(record, { filename: `seats/${file}` }).errors);
  if (record?.id && `${record.id}.json` !== file) errors.push(`seats/${file}: filename must be \`${record.id}.json\``);
  if (record?.id) {
    if (seatIds.has(record.id)) errors.push(`seats/${file}: duplicate seat id`);
    seatIds.add(record.id);
  }
}

/* ---------------------------------------------------------------- questions */
const seen = new Set();
for (const { file, record } of questionFiles) {
  errors.push(...validateQuestion(record, { config, filename: `questions/${file}` }).errors);
  if (record?.id && `${record.id}.json` !== file) errors.push(`questions/${file}: filename must be \`${record.id}.json\``);
  if (record?.id) {
    if (seen.has(record.id)) errors.push(`questions/${file}: duplicate id`);
    seen.add(record.id);
  }
}

/* ------------------------------------------------- mirrored questions vs slate
 * The crowd's probability is the one number in this market the house must not be
 * able to choose. It has to come from a slate that was fetched and committed,
 * and it has to match that slate exactly. */
const slates = new Map();
if (existsSync(paths.slates)) {
  for (const f of readdirSync(paths.slates).filter((f) => f.endsWith('.json'))) {
    try {
      const slate = JSON.parse(readFileSync(join(paths.slates, f), 'utf8'));
      slates.set(slate.batch ?? f.replace(/\.json$/, ''), slate);
    } catch (err) {
      errors.push(`market-slates/${f}: not valid JSON (${err.message})`);
    }
  }
}
for (const { file, record } of questionFiles) {
  if (record?.origin !== 'mirrored') continue;
  const x = record.external_reference;
  if (!x || typeof x !== 'object') continue; // already reported by the schema
  const day = record.created_utc?.slice(0, 10);
  const slate = slates.get(day);
  if (!slate) {
    errors.push(`questions/${file}: mirrors a crowd forecast but there is no fetched slate at market-slates/${day}.json`);
    continue;
  }
  const q = (slate.questions ?? []).find((s) => s.platform === x.platform && String(s.question_id) === String(x.question_id));
  if (!q) {
    errors.push(`questions/${file}: ${x.platform} question ${x.question_id} is not in the ${day} slate`);
    continue;
  }
  if (q.community_probability !== x.community_probability) {
    errors.push(`questions/${file}: records the crowd at ${x.community_probability} but the ${day} slate fetched ${q.community_probability}`);
  }
  if (slate.fetched_utc !== x.snapshot_utc) {
    errors.push(`questions/${file}: snapshot_utc ${x.snapshot_utc} does not match the slate's fetched_utc ${slate.fetched_utc}`);
  }
}

/* ------------------------------------------------------------ batch quotas */
const batches = new Map();
for (const { record } of questionFiles) {
  const day = record?.created_utc?.slice(0, 10);
  if (!day) continue;
  if (!batches.has(day)) batches.set(day, []);
  batches.get(day).push(record);
}
for (const [day, recs] of [...batches.entries()].sort()) {
  const report = strictQuotas ? errors : warnings;
  const label = `batch ${day}`;
  if (recs.length !== config.questions.per_batch) {
    report.push(`${label}: has ${recs.length} questions, the protocol fixes the batch at ${config.questions.per_batch}`);
  }
  for (const [cat, spec] of Object.entries(config.questions.categories)) {
    const n = recs.filter((r) => r.category === cat).length;
    if (n !== spec.quota_per_batch) report.push(`${label}: category \`${cat}\` has ${n}, quota is exactly ${spec.quota_per_batch}`);
  }
  const mirrored = recs.filter((r) => r.origin === 'mirrored').length;
  if (mirrored < config.questions.min_mirrored_per_batch) {
    report.push(`${label}: ${mirrored} mirrored question(s), protocol requires at least ${config.questions.min_mirrored_per_batch}`);
  }
  const long = recs.filter((r) => horizonBucket(daysBetween(r.created_utc.slice(0, 10), r.resolution_date), config) === 'long').length;
  if (long < config.questions.min_long_horizon_per_batch) {
    report.push(`${label}: ${long} long-horizon question(s), protocol requires at least ${config.questions.min_long_horizon_per_batch}`);
  }
  const claims = recs.map((r) => String(r.claim).trim().toLowerCase());
  if (new Set(claims).size !== claims.length) errors.push(`${label}: contains duplicate claims`);
}

/* -------------------------------------------------------------- resolutions */
const questionsById = new Map(questionFiles.map(({ record }) => [record?.id, record]));
for (const { file, record } of resolutionFiles) {
  const q = questionsById.get(record?.question_id) ?? null;
  if (!q) errors.push(`resolutions/${file}: no matching question (${JSON.stringify(record?.question_id)})`);
  errors.push(...validateResolution(record, q, { filename: `resolutions/${file}` }).errors);
  if (record?.question_id && `${record.question_id}.json` !== file) errors.push(`resolutions/${file}: filename must be \`${record.question_id}.json\``);
  if (q && record?.resolved_utc && record.resolved_utc.slice(0, 10) < q.resolution_date) {
    errors.push(`resolutions/${file}: resolved on ${record.resolved_utc.slice(0, 10)}, before its own resolution date ${q.resolution_date}`);
  }
}

/* --------------------------------------------- clearings and market solvency */
const market = loadMarket({ config, today: todayUTC() });

for (const entry of market.questions) {
  for (const round of entry.rounds) {
    if (!round.clearing) continue;
    const c = round.clearing;
    const commitments = readJsonl(commitmentsFile(entry.question.id, round.id));

    // Re-run the auction on the published book. If the recorded clearing price
    // is not what the committed book produces, the record has been edited.
    if (c.cleared) {
      const replay = clearRound(
        (c.book ?? []).map((o) => ({ order_id: o.order_id, seat: o.seat, side: o.side, limit_price: o.limit_price, size: o.size })),
        { minOrders: config.rounds.min_orders_to_clear, priorPrice: c.prior_price },
      );
      if (!replay.cleared || Math.abs(replay.clearing_price - c.clearing_price) > 1e-6 || replay.volume !== c.volume) {
        errors.push(
          `rounds/${entry.question.id}/${round.id}: the published book does not reproduce the recorded clearing (recorded ${c.clearing_price} on ${c.volume}, replay ${replay.cleared ? `${replay.clearing_price} on ${replay.volume}` : 'no clear'})`,
        );
      }
      const bought = c.fills.filter((f) => f.side === 'yes').reduce((a, f) => a + f.filled, 0);
      const sold = c.fills.filter((f) => f.side === 'no').reduce((a, f) => a + f.filled, 0);
      if (bought !== sold) errors.push(`rounds/${entry.question.id}/${round.id}: ${bought} contracts bought but ${sold} sold`);
    }

    if (c.commitments !== commitments.length) {
      warnings.push(`rounds/${entry.question.id}/${round.id}: clearing recorded ${c.commitments} commitments, the log now holds ${commitments.length}`);
    }
  }

  // The log score is zero-sum by construction; if it is not, the settlement is wrong.
  if (entry.settlement && !entry.settlement.invariants.zero_sum_ok) {
    errors.push(`${entry.question.id}: settlement is not zero-sum (log ${entry.settlement.invariants.log_score_sum}, points ${entry.settlement.invariants.points_pnl_sum})`);
  }
}

for (const [id, b] of market.bankrolls) {
  if (b.available < -1e-6) errors.push(`seat ${id} is over-staked: ${b.available.toFixed(2)} points available`);
}
for (const seatId of market.positionsBySeat.keys()) {
  if (!seatIds.has(seatId)) errors.push(`orders exist for unregistered seat \`${seatId}\``);
}

/* ------------------------------------------------------------------- output */
for (const w of warnings) console.warn(`warning  ${w}`);
for (const e of errors) console.error(`error    ${e}`);

const summary = `${questionFiles.length} questions, ${seatFiles.length} seats, ${resolutionFiles.length} resolutions, ${market.questions.reduce((a, q) => a + q.clearings.length, 0)} cleared rounds`;
if (errors.length) {
  console.error(`\nFAILED: ${errors.length} error(s), ${warnings.length} warning(s). ${summary}`);
  process.exit(1);
}
console.log(`OK: ${summary}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
