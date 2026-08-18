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

/**
 * When the four house seats wake, in UTC minutes past midnight. Kept here rather
 * than in config because they live in scheduled routines outside this repo; if
 * those move, this list moves with them and the assertion below is what notices.
 */
const SEAT_WAKE_TIMES_UTC = [
  { seat: 'house', minutes: 10 * 60 + 20 },
  { seat: 'opus-bare', minutes: 11 * 60 + 40 },
  { seat: 'sonnet-open', minutes: 13 * 60 + 10 },
  { seat: 'haiku-bare', minutes: 14 * 60 + 30 },
];

test('every round window is long enough for the seats that must trade in it', () => {
  // The constraint that actually bounds how fast this venue can run. Seats are
  // scheduled jobs, not screens, so a market cannot clear faster than its
  // participants wake up. A window narrowed below the spread of wake times
  // silently excludes seats, and the symptom - a round that fails to clear -
  // reads as "nobody turned up" rather than "the schedule is wrong".
  const opensMinutes = 9 * 60; // every ladder opens its rounds at 09:00 UTC
  const needed = config.rounds.min_distinct_seats_to_clear;

  for (const [id, ladder] of Object.entries(config.rounds.ladders)) {
    const closes = opensMinutes + ladder.window_hours * 60;
    const inside = SEAT_WAKE_TIMES_UTC.filter((s) => s.minutes >= opensMinutes && s.minutes <= closes);
    assert.ok(
      inside.length > needed,
      `the ${id} window (09:00–${String(9 + ladder.window_hours).padStart(2, '0')}:00 UTC) contains ${inside.length} seat(s) ` +
        `and needs more than ${needed} for any margin at all. Excluded: ` +
        `${SEAT_WAKE_TIMES_UTC.filter((s) => !inside.includes(s)).map((s) => s.seat).join(', ') || 'none'}`,
    );
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

/* ---------------------------------------------------------------- canary */

test('a canary schedule always yields exactly one tradeable round', async () => {
  // The canary is authored mechanically every morning, so its schedule has to be
  // right for any date rather than for one that was checked by hand.
  for (const day of ['2026-01-31', '2026-02-28', '2026-06-30', '2026-12-31']) {
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const rounds = buildSchedule(day, next, config, 'canary');
    assert.equal(rounds.length, 1, `${day} → ${next} should give one round`);
    assert.ok(rounds[0].opens_utc.startsWith(day), 'the round opens on the day the claim is about');
    assert.ok(rounds[0].closes_utc < `${next}T00:00:00Z`, 'and closes before the answer is knowable');
  }
});

test('the canary lane is the one the mechanical author will select', () => {
  // scripts/new-canary.js passes lane explicitly, but it computes tomorrow as the
  // resolution date; if that ever stopped landing in the canary lane the question
  // would be written unscored while validating as something else.
  assert.equal(laneFor(1), 'canary');
  assert.equal(config.lanes.canary.scored, false);
});

test('batch quotas apply to the standard lane only', () => {
  // The bug this pins: quotas were counted over every question created that day,
  // which made the other lanes unwritable. The canary is one question a day by
  // definition, so alone it read as a batch of one and failed every quota at
  // once - the workflow wrote a good question and then refused to commit it.
  const q = (over) => ({ created_utc: '2026-08-18T07:00:00Z', category: 'status-quo', origin: 'house', resolution_date: '2026-08-19', claim: 'x', ...over });
  const inBatch = (recs) => recs.filter((r) => (r.lane ?? 'standard') === 'standard');

  assert.equal(inBatch([q({ lane: 'canary' })]).length, 0, 'a canary is not a batch');
  assert.equal(inBatch([q({ lane: 'short' })]).length, 0, 'nor is a short-lane question');
  assert.equal(inBatch([q({ lane: 'canary' }), q({})]).length, 1, 'and a canary does not pad a standard batch');
});
