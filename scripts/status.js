#!/usr/bin/env node
/**
 * The briefing every scheduled run reads before it does anything.
 *
 * It states what the protocol requires, what is already on the books, which
 * rounds are open right now, what each seat can afford, and what is owed. All of
 * that is decided by the committed rules rather than in the moment.
 *
 *   node scripts/status.js            human-readable
 *   node scripts/status.js --json     machine-readable
 *   node scripts/status.js --seat=house   what one seat can do right now
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC, addDays } from '../lib/config.js';
import { loadMarket } from '../lib/market.js';
import { leaderboard, errorCorrelationMatrix, crowdComparison, updateSpeed } from '../lib/scoring.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const asJson = process.argv.includes('--json');
const onlySeat = arg('seat');

const config = loadConfig();
const today = arg('today', todayUTC());
const now = arg('now', new Date().toISOString());
const market = loadMarket({ config, today, now });

/** Next batch day (Monday by default), or today if today is that day. */
function nextBatchDate(from = today) {
  const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(config.questions.batch_day_utc.toLowerCase());
  const d = new Date(`${from}T00:00:00Z`);
  return addDays(from, (target - d.getUTCDay() + 7) % 7);
}

const batchDate = nextBatchDate();
const written = market.questions.filter((q) => q.question.created_utc.slice(0, 10) === batchDate);

const requirements = {
  batch_date: batchDate,
  per_batch: config.questions.per_batch,
  already_written: written.length,
  still_needed: Math.max(0, config.questions.per_batch - written.length),
  categories: Object.fromEntries(
    Object.entries(config.questions.categories).map(([k, v]) => {
      const n = written.filter((q) => q.question.category === k).length;
      return [k, { quota: v.quota_per_batch, written: n, remaining: Math.max(0, v.quota_per_batch - n) }];
    }),
  ),
  min_mirrored: config.questions.min_mirrored_per_batch,
  mirrored_written: written.filter((q) => q.question.origin === 'mirrored').length,
  min_long_horizon: config.questions.min_long_horizon_per_batch,
};

const openRounds = market.openRounds.map(({ question, round }) => {
  const entry = market.questions.find((q) => q.question.id === question.id);
  return {
    question_id: question.id,
    claim: question.claim,
    category: question.category,
    round_id: round.id,
    t_minus_days: round.t_minus_days,
    closes_utc: round.closes_utc,
    current_price: entry.currentPrice,
    price_path: entry.pricePath.map((p) => ({ round_id: p.round_id, price: p.price, cleared: p.cleared })),
    orders_committed: round.commitment_count,
    resolution_criterion: question.resolution_criterion,
    resolution_date: question.resolution_date,
    // Deliberately absent: anything about who has submitted what. A seat reading
    // this before submitting must learn nothing about the current book.
  };
});

const board = leaderboard(market.positionsBySeat, market.seats, config);
const postmortemsOwed = market.questions
  .filter((q) => q.settlement)
  .flatMap((q) =>
    q.settlement.seats
      .filter((s) => s.log_score < config.postmortem.trigger_log_score_below && !q.postmortem)
      .map((s) => ({ question_id: q.question.id, seat: s.seat, log_score: s.log_score, claim: q.question.claim })),
  );

const healthFile = join(paths.analysis, 'source-health.json');
const health = existsSync(healthFile) ? JSON.parse(readFileSync(healthFile, 'utf8')) : null;

const payload = {
  today,
  now,
  protocol_version: config.protocol_version,
  phase: config.phase.current,
  counts: {
    questions: market.questions.length,
    open: market.open.length,
    awaiting_resolution: market.awaitingResolution.length,
    resolved: market.resolved.length,
    void: market.voided.length,
    void_rate: market.questions.length ? market.voided.length / market.questions.length : 0,
    seats: market.seats.size,
    cleared_rounds: market.questions.reduce((a, q) => a + q.clearings.filter((c) => c.cleared).length, 0),
  },
  requirements,
  open_rounds: onlySeat ? openRounds : openRounds,
  rounds_awaiting_clear: market.roundsAwaitingClear.map(({ question, round }) => ({ question_id: question.id, round_id: round.id, closed_utc: round.closes_utc })),
  bankrolls: [...market.bankrolls.values()].filter((b) => !onlySeat || b.seat === onlySeat),
  leaderboard: board,
  postmortems_owed: postmortemsOwed,
  failing_sources: (health?.results ?? []).filter((r) => !r.ok),
  cross_model_error_correlation: errorCorrelationMatrix(market.positionsBySeat),
  crowd_comparison: crowdComparison(market.positionsBySeat, market.questionsById),
  update_speed: updateSpeed(market.positionsBySeat),
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 3) => (x === null || x === undefined ? '—' : x.toFixed(d));

console.log(`wrong.aecs.io — status for ${today} (protocol v${config.protocol_version}, phase ${config.phase.current})\n`);
console.log(`Market: ${payload.counts.questions} questions · ${payload.counts.open} open · ${payload.counts.resolved} resolved · ${payload.counts.void} void (${pct(payload.counts.void_rate)})`);
console.log(`        ${payload.counts.seats} seats · ${payload.counts.cleared_rounds} rounds cleared\n`);

if (openRounds.length) {
  console.log(`Rounds open now (${openRounds.length}) — submit with: node scripts/submit-order.js --seat=<id> < orders.json`);
  for (const r of openRounds) {
    console.log(`  ${r.question_id} ${r.round_id}  closes ${r.closes_utc}  price ${num(r.current_price, 2)}  ${r.orders_committed} order(s) committed`);
    console.log(`      ${r.claim.slice(0, 100)}`);
  }
  console.log('');
} else {
  console.log('No round is open right now.\n');
}

if (market.roundsAwaitingClear.length) {
  console.log(`Rounds past their close and awaiting a clear (${market.roundsAwaitingClear.length}): run node scripts/clear-round.js\n`);
}

console.log(`Next batch: ${batchDate} — ${requirements.still_needed} of ${config.questions.per_batch} still to write`);
for (const [cat, r] of Object.entries(requirements.categories)) {
  console.log(`  ${cat.padEnd(20)} ${r.written}/${r.quota}${r.remaining ? `  (${r.remaining} needed)` : '  ✓'}`);
}
console.log(`  mirrored: ${requirements.mirrored_written}/${requirements.min_mirrored} minimum · long-horizon minimum ${requirements.min_long_horizon}\n`);

console.log('Bankrolls:');
for (const b of payload.bankrolls) {
  console.log(`  ${b.seat.padEnd(14)} available ${String(b.available).padStart(9)}  granted ${b.granted}  at risk ${b.at_risk}  realised ${b.realised_pnl >= 0 ? '+' : ''}${b.realised_pnl}`);
}
console.log('');

if (board.some((s) => s.questions_settled > 0)) {
  console.log('Leaderboard (ranked on log score — win rate rewards picking the obvious):');
  for (const s of board) {
    console.log(`  ${s.seat.padEnd(14)} log ${String(num(s.log_score, 2)).padStart(8)}  points ${String(s.points_pnl).padStart(8)}  Brier ${num(s.brier)}  ${s.wins}W-${s.losses}L over ${s.questions_settled} settled  [${s.division}, ${s.model_string}]`);
  }
  console.log('');
} else {
  console.log('Nothing has settled yet, so there is no leaderboard worth printing.\n');
}

if (postmortemsOwed.length) {
  console.log(`Post-mortems owed (${postmortemsOwed.length}):`);
  for (const p of postmortemsOwed) console.log(`  ${p.question_id} / ${p.seat}  log score ${num(p.log_score, 2)}`);
  console.log('');
}

if (payload.failing_sources.length) {
  console.log(`Sources not responding as of the last probe (${health.checked_utc}):`);
  for (const f of payload.failing_sources) console.log(`  ${f.question_id} (${f.type}): ${f.detail}`);
}
