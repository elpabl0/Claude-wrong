import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, laneFor } from '../scripts/new-question.js';
import { leaderboard, leaderboardByHorizon, scoredPositions, calibration, errorCorrelationMatrix } from '../lib/scoring.js';
import { loadConfig } from '../lib/config.js';

const config = loadConfig();

/* ------------------------------------------------------------------ lanes */

test('a lane is chosen by horizon, not by whoever is writing the question', () => {
  assert.equal(laneFor(90), 'standard');
  assert.equal(laneFor(30), 'standard');
  assert.equal(laneFor(14), 'short');
  assert.equal(laneFor(2), 'short');
  assert.equal(laneFor(1), 'canary');
});

test('every lane produces at least one tradeable round at its own horizons', () => {
  // The bug this pins: the standard ladder starts ninety days out, so on a
  // three-day question every rung is filtered away and the question exists,
  // listed and untradeable, with no rounds at all.
  const cases = [
    ['2026-11-14', 5], // 90 days
    ['2026-08-23', 3], // 7 days
    ['2026-08-18', 1], // 2 days
    ['2026-08-17', 1], // 1 day, canary
  ];
  for (const [resolution, expected] of cases) {
    const rounds = buildSchedule('2026-08-16', resolution);
    assert.equal(rounds.length, expected, `${resolution} should get ${expected} round(s), got ${rounds.length}`);
  }
});

test('no round may open before the question is public or close after resolution', () => {
  for (const resolution of ['2026-11-14', '2026-08-23', '2026-08-18', '2026-08-17']) {
    for (const r of buildSchedule('2026-08-16', resolution)) {
      assert.ok(r.opens_utc > '2026-08-16T00:00:00Z', `${resolution} ${r.id} opens before the question exists`);
      assert.ok(r.closes_utc < `${resolution}T00:00:00Z`, `${resolution} ${r.id} closes after the answer is known`);
      assert.ok(r.closes_utc > r.opens_utc);
    }
  }
});

test('rounds tighten toward resolution on every ladder', () => {
  for (const resolution of ['2026-11-14', '2026-08-23']) {
    const t = buildSchedule('2026-08-16', resolution).map((r) => r.t_minus_days);
    assert.deepEqual(t, [...t].sort((a, b) => b - a), `${resolution} rungs must run from far to near`);
  }
});

/* ---------------------------------------------------------------- scoring */

const position = (over = {}) => ({
  question_id: 'q', seat: 's', lane: 'standard', scored: true, horizon_bucket: 'long',
  outcome: 1, stated_probability: 0.7, log_score: 0.5, contracts: 10, staked: 7,
  points_pnl: 3, wins: 1, losses: 0, round_probabilities: [0.7], ...over,
});

test('an unscored lane never reaches a score, however good it looks', () => {
  const mixed = [position({ log_score: 0.5 }), position({ lane: 'canary', scored: false, log_score: 99 })];
  assert.equal(scoredPositions(mixed, config).length, 1);

  const board = leaderboard(new Map([['s', mixed]]), new Map(), config);
  assert.equal(board[0].log_score, 0.5, 'the canary score must not be added in');
  assert.equal(board[0].contracts, 10);
});

test('an unscored lane is kept out of calibration and correlation too', () => {
  // Excluding it from the leaderboard alone would leave two other routes by
  // which easy questions could flatter the record.
  const mixed = [position(), position({ lane: 'canary', scored: false, stated_probability: 0.95 })];
  const bins = calibration(mixed, config).filter((b) => b.n > 0);
  assert.equal(bins.reduce((a, b) => a + b.n, 0), 1);

  const m = errorCorrelationMatrix(new Map([['a', mixed], ['b', mixed]]), { minShared: 1, config });
  assert.equal(m.cells.find((c) => c.a === 'a' && c.b === 'b').n, 1);
});

test('horizon buckets are ranked separately, so easy questions cannot buy rank', () => {
  // `sprinter` looks better pooled purely by trading only short questions.
  // Split by horizon, the comparison it was winning simply does not exist.
  const positions = new Map([
    ['sprinter', Array.from({ length: 6 }, (_, i) => position({ question_id: `s${i}`, horizon_bucket: 'short', log_score: 0.9 }))],
    ['marathon', Array.from({ length: 6 }, (_, i) => position({ question_id: `m${i}`, horizon_bucket: 'long', log_score: 0.3 }))],
  ]);

  const pooled = leaderboard(positions, new Map(), config);
  assert.equal(pooled[0].seat, 'sprinter', 'pooled, the easy-question seat leads');

  const byHorizon = leaderboardByHorizon(positions, new Map(), config);
  const short = byHorizon.find((b) => b.id === 'short');
  const long = byHorizon.find((b) => b.id === 'long');
  assert.deepEqual(short.rows.map((r) => r.seat), ['sprinter']);
  assert.deepEqual(long.rows.map((r) => r.seat), ['marathon']);
  assert.equal(short.seats, 1);
});

test('a seat appears in every bucket it actually traded in', () => {
  const positions = new Map([
    ['both', [
      ...Array.from({ length: 5 }, (_, i) => position({ question_id: `a${i}`, horizon_bucket: 'short' })),
      ...Array.from({ length: 5 }, (_, i) => position({ question_id: `b${i}`, horizon_bucket: 'long' })),
    ]],
  ]);
  const byHorizon = leaderboardByHorizon(positions, new Map(), config);
  assert.equal(byHorizon.find((b) => b.id === 'short').rows.length, 1);
  assert.equal(byHorizon.find((b) => b.id === 'long').rows.length, 1);
  assert.equal(byHorizon.find((b) => b.id === 'medium').rows.length, 0, 'and not in one it never traded');
});

test('the provisional threshold applies inside a bucket, not just overall', () => {
  // A seat with ten long-horizon settlements and one short one is not ranked on
  // the short table off the back of a single question.
  const positions = new Map([
    ['seat', [
      ...Array.from({ length: 10 }, (_, i) => position({ question_id: `l${i}`, horizon_bucket: 'long' })),
      position({ question_id: 's1', horizon_bucket: 'short' }),
    ]],
  ]);
  const byHorizon = leaderboardByHorizon(positions, new Map(), config);
  assert.equal(byHorizon.find((b) => b.id === 'long').rows[0].ranked, true);
  assert.equal(byHorizon.find((b) => b.id === 'short').rows[0].ranked, false);
});
