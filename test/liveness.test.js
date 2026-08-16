import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveness } from '../lib/liveness.js';
import { loadConfig } from '../lib/config.js';

const config = loadConfig();
const NOW = new Date('2026-09-01T12:00:00.000Z');

/** A canary that resolved `daysAgo` days before NOW. */
const canary = (daysAgo) => ({
  lane: 'canary',
  question: { id: `canary-${daysAgo}`, created_utc: '2026-08-30T00:00:00.000Z' },
  resolution: { resolved_utc: new Date(NOW.getTime() - daysAgo * 86400000).toISOString() },
});

/** A market shaped the way loadMarket returns one, with everything healthy. */
function healthy(overrides = {}) {
  return {
    config,
    questions: [{ lane: 'standard', question: { id: 'q1', created_utc: '2026-08-30T00:00:00.000Z' } }, canary(0)],
    roundsAwaitingClear: [],
    awaitingResolution: [],
    openRounds: [],
    ...overrides,
  };
}

const check = (r, id) => r.checks.find((c) => c.id === id);
const authored = (createdUtc) => ({ lane: 'standard', question: { id: `q-${createdUtc}`, created_utc: createdUtc } });

test('a market doing everything on time reports running', () => {
  const r = liveness(healthy(), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'running');
  assert.deepEqual(r.stalled, []);
});

test('a market with no questions at all is not-started, not stalled', () => {
  // The distinction matters: nothing is broken before the first batch is written,
  // and shouting "stalled" on day one would train everyone to ignore the notice.
  const r = liveness(healthy({ questions: [] }), { now: NOW });
  assert.equal(r.state, 'not-started');
  assert.equal(check(r, 'authoring').severity, 'never-run');
});

test('a daily canary must not hold the authoring check green', () => {
  // The failure this guards against: canaries are written every day, so if they
  // counted as "questions written" the weekly batch could stop for a month and
  // the check would never go red. Monitoring that masks its own failure is worse
  // than none, because it is trusted.
  const r = liveness(healthy({ questions: [authored('2026-08-01T00:00:00.000Z'), canary(0)] }), { now: NOW });
  assert.equal(check(r, 'authoring').ok, false, 'a fresh canary must not stand in for a stale weekly batch');
  assert.equal(check(r, 'canary').ok, true, 'and the canary check itself is still green');
});

test('the canary is the check that fires within days rather than months', () => {
  const q = { lane: 'standard', question: { id: 'q1', created_utc: '2026-08-30T00:00:00.000Z' } };

  const fresh = liveness(healthy({ questions: [q, canary(1)] }), { now: NOW });
  assert.equal(check(fresh, 'canary').ok, true);

  const stale = liveness(healthy({ questions: [q, canary(4)] }), { now: NOW });
  assert.equal(check(stale, 'canary').ok, false);
  assert.equal(stale.state, 'stalled');
  assert.match(check(stale, 'canary').detail, /4 days/);
});

test('canaries written but never resolved is a stall, not a pass', () => {
  // The dangerous version of this bug: canaries pile up unresolved and the check
  // reads "canaries exist" as "the pipeline works".
  const written = { lane: 'canary', question: { id: 'c1', created_utc: '2026-08-31T00:00:00.000Z' }, resolution: null };
  const r = liveness(healthy({ questions: [written] }), { now: NOW });
  assert.equal(check(r, 'canary').ok, false);
  assert.match(check(r, 'canary').detail, /none resolved/);
});

test('the newest canary decides, so one old resolved canary cannot mask a broken pipeline', () => {
  const q = { lane: 'standard', question: { id: 'q1', created_utc: '2026-08-30T00:00:00.000Z' } };
  const r = liveness(healthy({ questions: [q, canary(30), canary(1)] }), { now: NOW });
  assert.equal(check(r, 'canary').ok, true);

  const broken = liveness(healthy({ questions: [q, canary(30), canary(9)] }), { now: NOW });
  assert.equal(check(broken, 'canary').ok, false);
});

test('questions written weekly are stale after eight days', () => {
  const ok = liveness(healthy({ questions: [authored('2026-08-24T00:00:00.000Z'), canary(0)] }), { now: NOW });
  assert.equal(check(ok, 'authoring').ok, true, 'eight days is still within the weekly cycle');

  const stale = liveness(healthy({ questions: [authored('2026-08-23T00:00:00.000Z'), canary(0)] }), { now: NOW });
  assert.equal(check(stale, 'authoring').ok, false);
  assert.equal(stale.state, 'stalled');
});

test('the newest question decides staleness, not the first one found', () => {
  const r = liveness(
    healthy({ questions: [authored('2026-06-01T00:00:00.000Z'), authored('2026-08-31T00:00:00.000Z'), canary(0)] }),
    { now: NOW },
  );
  assert.equal(check(r, 'authoring').ok, true);
});

test('a round more than twelve hours past its close has not been picked up', () => {
  const waiting = (closes) => [{ question: { id: 'q1' }, round: { id: 'r2', closes_utc: closes } }];

  const recent = liveness(healthy({ roundsAwaitingClear: waiting('2026-09-01T06:00:00.000Z') }), { now: NOW });
  assert.equal(check(recent, 'clearing').ok, true, 'six hours is inside the clearing cycle');

  const overdue = liveness(healthy({ roundsAwaitingClear: waiting('2026-08-31T12:00:00.000Z') }), { now: NOW });
  assert.equal(check(overdue, 'clearing').ok, false);
  assert.match(check(overdue, 'clearing').detail, /q1\/r2/, 'the notice names the round so it can be chased');
});

test('a question past its resolution date plus grace means the resolver stopped', () => {
  const past = new Date(NOW.getTime() - (config.resolution.grace_period_days + 2) * 86400000)
    .toISOString()
    .slice(0, 10);
  const r = liveness(healthy({ awaitingResolution: [{ question: { id: 'q1', resolution_date: past } }] }), { now: NOW });
  assert.equal(check(r, 'resolution').ok, false);
  assert.equal(r.state, 'stalled');

  // Inside the grace period is a question waiting on its source, not a stall.
  const today = NOW.toISOString().slice(0, 10);
  const fresh = liveness(healthy({ awaitingResolution: [{ question: { id: 'q1', resolution_date: today } }] }), { now: NOW });
  assert.equal(check(fresh, 'resolution').ok, true);
});

test('an open round past halfway with no orders is quiet, and quiet is not stalled', () => {
  const round = (opens, closes, commitment_count) => [{ question: { id: 'q1' }, round: { id: 'r1', opens_utc: opens, closes_utc: closes, commitment_count } }];

  const early = liveness(healthy({ openRounds: round('2026-09-01T10:00:00.000Z', '2026-09-02T10:00:00.000Z', 0) }), { now: NOW });
  assert.equal(check(early, 'participation').ok, true, 'no orders yet is normal early in the window');

  const late = liveness(healthy({ openRounds: round('2026-09-01T00:00:00.000Z', '2026-09-01T14:00:00.000Z', 0) }), { now: NOW });
  assert.equal(check(late, 'participation').ok, false);
  assert.equal(check(late, 'participation').severity, 'quiet');

  const traded = liveness(healthy({ openRounds: round('2026-09-01T00:00:00.000Z', '2026-09-01T14:00:00.000Z', 3) }), { now: NOW });
  assert.equal(check(traded, 'participation').ok, true);
});

test('every check reports an id, a label and a human-readable detail', () => {
  const r = liveness(healthy(), { now: NOW });
  assert.deepEqual(r.checks.map((c) => c.id), ['authoring', 'clearing', 'resolution', 'canary', 'participation']);
  for (const c of r.checks) {
    assert.ok(c.label && c.detail, `${c.id} must explain itself: a check nobody can read is a check nobody acts on`);
  }
});
