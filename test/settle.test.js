import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleQuestion, statedProbability, logScore } from '../lib/settle.js';
import { clearRound } from '../lib/auction.js';
import { seatSummary, errorCorrelationMatrix, correlate, selectivity, updateSpeed } from '../lib/scoring.js';

const question = { id: '2026-09-01-example' };

/** Run a real auction so settlement is tested against real clearing output. */
function round(roundId, orders) {
  const r = clearRound(orders);
  return { ...r, round_id: roundId };
}
let n = 0;
const order = (seat, side, limit_price, size) => ({ order_id: `${roundTag}-${String(++n).padStart(2, '0')}`, seat, side, limit_price, size });
let roundTag = 'r1';

test('a stated probability is read in YES space whichever side was taken', () => {
  assert.equal(statedProbability({ side: 'yes', limit_price: 0.7 }), 0.7);
  assert.ok(Math.abs(statedProbability({ side: 'no', limit_price: 0.7 }) - 0.3) < 1e-9);
});

test('the log score is zero-sum between counterparties, whichever way it goes', () => {
  const clearing = round('r1', [order('a', 'yes', 0.8, 10), order('b', 'no', 0.6, 10)]);
  for (const outcome of [1, 0]) {
    const s = settleQuestion({ question, clearings: [clearing], outcome });
    assert.ok(s.invariants.zero_sum_ok, `outcome ${outcome}: ${JSON.stringify(s.invariants)}`);
    const a = s.seats.find((x) => x.seat === 'a');
    const b = s.seats.find((x) => x.seat === 'b');
    assert.ok(Math.abs(a.log_score + b.log_score) < 1e-9);
    // Whoever was on the right side gains, the other loses exactly as much.
    if (outcome === 1) assert.ok(a.log_score > 0 && b.log_score < 0);
    else assert.ok(a.log_score < 0 && b.log_score > 0);
  }
});

test('points are zero-sum too, and a contract always pays exactly one', () => {
  const clearing = round('r1', [order('a', 'yes', 0.75, 20), order('b', 'no', 0.5, 20)]);
  const s = settleQuestion({ question, clearings: [clearing], outcome: 1 });
  assert.ok(Math.abs(s.invariants.points_pnl_sum) < 1e-6);
  const a = s.seats.find((x) => x.seat === 'a');
  assert.equal(a.payout, a.contracts, 'a winning contract pays exactly 1 point');
});

test('being right at long odds pays more than being right at short odds', () => {
  // Same size, same outcome. The bold seat buys YES cheap from a seller who
  // thinks it will not happen; the safe seat buys YES at a price already close
  // to certain. Both are right.
  n = 0;
  const longOdds = settleQuestion({
    question,
    clearings: [round('r1', [order('bold', 'yes', 0.45, 10), order('crowd', 'no', 0.6, 10)])],
    outcome: 1,
  }).seats.find((s) => s.seat === 'bold');

  n = 0;
  const shortOdds = settleQuestion({
    question,
    clearings: [round('r1', [order('safe', 'yes', 0.95, 10), order('other', 'no', 0.1, 10)])],
    outcome: 1,
  }).seats.find((s) => s.seat === 'safe');

  assert.ok(longOdds && shortOdds, 'both scenarios must actually cross and fill');

  assert.ok(
    longOdds.points_pnl > shortOdds.points_pnl,
    `taking the 0.25 side and being right (${longOdds.points_pnl}) must pay more than the 0.90 side (${shortOdds.points_pnl})`,
  );
});

test('an honest probability beats an exaggerated one in expectation', () => {
  // The counterparty says 0.5 every time. Across many outcomes drawn at the true
  // rate of 0.7, stating 0.7 must score better than stating 0.95.
  const expected = (stated) => {
    const truth = 0.7;
    return truth * logScore(stated, 1) + (1 - truth) * logScore(stated, 0);
  };
  assert.ok(expected(0.7) > expected(0.95));
  assert.ok(expected(0.7) > expected(0.5));
  assert.ok(expected(0.7) > expected(0.85));
});

test('a void returns every stake and scores nothing', () => {
  const clearing = round('r1', [order('a', 'yes', 0.8, 10), order('b', 'no', 0.6, 10)]);
  const s = settleQuestion({ question, clearings: [clearing], outcome: null });
  for (const seat of s.seats) {
    assert.equal(seat.points_pnl, 0, 'a void must not move a bankroll');
    assert.equal(seat.log_score, 0, 'a void must not move a leaderboard');
    assert.equal(seat.wins + seat.losses, 0);
  }
});

test('a round that did not clear contributes nothing to settlement', () => {
  const noClear = { cleared: false, reason: 'one-sided', round_id: 'r1' };
  const s = settleQuestion({ question, clearings: [noClear], outcome: 1 });
  assert.equal(s.seats.length, 0);
});

test('positions across several rounds accumulate into one weighted view', () => {
  n = 0;
  const r1 = round('r1', [order('a', 'yes', 0.6, 10), order('b', 'no', 0.5, 10)]);
  n = 0;
  roundTag = 'r2';
  const r2 = round('r2', [order('a', 'yes', 0.8, 10), order('b', 'no', 0.3, 10)]);
  const s = settleQuestion({ question, clearings: [r1, r2], outcome: 1 });
  const a = s.seats.find((x) => x.seat === 'a');
  assert.equal(a.contracts, 20);
  assert.ok(a.stated_probability > 0.6 && a.stated_probability < 0.8, 'weighted between the two rounds');
});

test('seat summary reports calibration in the honest direction', () => {
  const positions = [
    { question_id: 'q1', stated_probability: 0.9, outcome: 0, log_score: -1, points_pnl: -9, contracts: 10, staked: 9, wins: 0, losses: 1 },
    { question_id: 'q2', stated_probability: 0.9, outcome: 0, log_score: -1, points_pnl: -9, contracts: 10, staked: 9, wins: 0, losses: 1 },
  ];
  const s = seatSummary(positions);
  assert.ok(s.calibration_gap.mean > 0.85, 'positive gap means it said yes far more than yes happened');
  assert.equal(s.wins, 0);
  assert.equal(s.losses, 2);
});

test('error correlation finds seats that are wrong in the same direction', () => {
  const mk = (errors) => errors.map((e, i) => ({ question_id: `q${i}`, stated_probability: 0.5 + e, outcome: 0, log_score: 0 }));
  const together = new Map([
    ['a', mk([0.1, 0.2, 0.3, 0.4, 0.15])],
    ['b', mk([0.1, 0.2, 0.3, 0.4, 0.15])],
  ]);
  const m = errorCorrelationMatrix(together);
  const cell = m.cells.find((c) => c.a === 'a' && c.b === 'b');
  assert.ok(cell.r > 0.99, 'identical errors must correlate at 1');
  assert.equal(cell.enough, true);

  const opposed = new Map([
    ['a', mk([0.1, 0.2, 0.3, 0.4, 0.15])],
    ['b', mk([0.4, 0.3, 0.2, 0.1, 0.35])],
  ]);
  assert.ok(errorCorrelationMatrix(opposed).cells.find((c) => c.a === 'a' && c.b === 'b').r < -0.9);
});

test('correlation refuses to report on too few shared questions', () => {
  assert.equal(correlate([1, 2], [1, 2]).r, null);
  assert.equal(correlate([1, 1, 1, 1], [1, 2, 3, 4]).r, null, 'no variance means no correlation');
});

test('selectivity is silent until there is something to say', () => {
  assert.equal(selectivity([]).stake_score_correlation, null);
  const positions = Array.from({ length: 6 }, (_, i) => ({
    question_id: `q${i}`, outcome: 1, staked: (i + 1) * 10, contracts: 10, log_score: (i + 1) * 0.1, stated_probability: 0.6,
  }));
  assert.ok(selectivity(positions).stake_score_correlation > 0.9, 'staking more where it was more right');
});

test('update speed measures whether revisions moved toward the truth', () => {
  const m = new Map([
    ['learner', [{ question_id: 'q1', outcome: 1, round_probabilities: [0.4, 0.6, 0.8] }]],
    ['anchored', [{ question_id: 'q1', outcome: 1, round_probabilities: [0.4, 0.4, 0.4] }]],
  ]);
  const rows = updateSpeed(m);
  const learner = rows.find((r) => r.seat === 'learner');
  const anchored = rows.find((r) => r.seat === 'anchored');
  assert.ok(learner.mean_revision_toward_outcome > 0);
  assert.equal(learner.share_of_revisions_correct, 1);
  assert.equal(anchored.mean_absolute_revision, 0);
});
