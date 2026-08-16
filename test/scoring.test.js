import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brier, summarise, calibration, expectedCalibrationError,
  murphyDecomposition, breakdown, mirrorComparison, hypothesisTests, meanWithCI,
} from '../lib/scoring.js';
import { loadConfig } from '../lib/config.js';

const config = loadConfig();

/** Build a scored ledger entry without touching disk. */
function entry(probability, outcome, over = {}) {
  const prediction = {
    id: `2026-01-01-${Math.random().toString(36).slice(2, 8)}`,
    batch: '2026-01-01',
    probability,
    category: 'ai-capability',
    claim_type: 'change',
    origin: 'self',
    model: 'test-model',
    protocol_version: 1,
    external_reference: null,
    ...(over.prediction ?? {}),
  };
  return {
    prediction,
    state: 'resolved',
    outcome,
    brier: brier(probability, outcome),
    horizonBucket: over.horizonBucket ?? 'medium',
    horizonDays: 60,
    resolution: { status: outcome ? 'yes' : 'no' },
  };
}

test('brier is the squared error and 0.5 always costs 0.25', () => {
  assert.equal(brier(1, 1), 0);
  assert.equal(brier(0, 1), 1);
  assert.equal(brier(0.5, 1), 0.25);
  assert.equal(brier(0.5, 0), 0.25);
  assert.equal(brier(0.7, 1).toFixed(4), '0.0900');
});

test('a perfectly calibrated forecaster scores its own variance', () => {
  // Ten questions at 0.7, seven of which happen: mean Brier should be 0.21.
  const entries = [...Array(7)].map(() => entry(0.7, 1)).concat([...Array(3)].map(() => entry(0.7, 0)));
  const s = summarise(entries);
  assert.equal(s.n, 10);
  assert.ok(Math.abs(s.meanBrier - 0.21) < 1e-9);
  assert.ok(Math.abs(s.calibrationGap.mean) < 1e-9, 'no calibration gap when forecasts match reality');
  assert.ok(Math.abs(s.baseRate - 0.7) < 1e-9);
});

test('summarise reports overconfidence as a positive calibration gap', () => {
  // Says 0.9 ten times; it happens five times.
  const entries = [...Array(5)].map(() => entry(0.9, 1)).concat([...Array(5)].map(() => entry(0.9, 0)));
  const s = summarise(entries);
  assert.ok(s.calibrationGap.mean > 0.39 && s.calibrationGap.mean < 0.41);
  assert.ok(s.meanBrier > 0.25, 'worse than a coin flip');
  assert.ok(s.skillVsCoinflip < 0);
});

test('skill against the base rate is zero for a forecaster that only knows the base rate', () => {
  const entries = [...Array(6)].map(() => entry(0.6, 1)).concat([...Array(4)].map(() => entry(0.6, 0)));
  const s = summarise(entries);
  assert.ok(Math.abs(s.skillVsBaseRate) < 1e-9);
});

test('calibration bins place probabilities in the right bucket, with 1.0 inclusive', () => {
  const bins = calibration([entry(0.05, 1), entry(0.15, 0), entry(0.95, 1), entry(1.0, 1)], config);
  assert.equal(bins[0].n, 1);
  assert.equal(bins[1].n, 1);
  assert.equal(bins[9].n, 2, 'the top bin includes both 0.95 and an exact 1.0');
});

test('expected calibration error is zero when every bin matches reality', () => {
  const entries = [
    ...[...Array(8)].map(() => entry(0.8, 1)), ...[...Array(2)].map(() => entry(0.8, 0)),
    ...[...Array(2)].map(() => entry(0.2, 1)), ...[...Array(8)].map(() => entry(0.2, 0)),
  ];
  assert.ok(Math.abs(expectedCalibrationError(calibration(entries, config))) < 1e-9);
});

test('Murphy decomposition reconstructs the Brier score', () => {
  const entries = [
    ...[...Array(7)].map(() => entry(0.75, 1)), ...[...Array(3)].map(() => entry(0.75, 0)),
    ...[...Array(2)].map(() => entry(0.25, 1)), ...[...Array(8)].map(() => entry(0.25, 0)),
  ];
  const m = murphyDecomposition(entries, config);
  assert.ok(Math.abs(m.residual) < 1e-9, `identity should hold when bins are pure, residual was ${m.residual}`);
  assert.ok(m.resolution > 0, 'these forecasts do discriminate');
  assert.ok(m.reliability >= 0);
});

test('a forecaster with no discrimination has zero resolution', () => {
  const entries = [...Array(5)].map(() => entry(0.5, 1)).concat([...Array(5)].map(() => entry(0.5, 0)));
  const m = murphyDecomposition(entries, config);
  assert.ok(Math.abs(m.resolution) < 1e-9);
});

test('breakdown groups and sorts by sample size', () => {
  const entries = [
    entry(0.6, 1, { prediction: { category: 'geopolitics' } }),
    entry(0.6, 0, { prediction: { category: 'geopolitics' } }),
    entry(0.6, 1, { prediction: { category: 'status-quo' } }),
  ];
  const rows = breakdown(entries, (e) => e.prediction.category);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, 'geopolitics');
  assert.equal(rows[0].n, 2);
});

test('mirror comparison pairs the model against the crowd on the same outcome', () => {
  const mk = (self, crowd, outcome) =>
    entry(self, outcome, {
      prediction: { origin: 'metaculus-mirror', external_reference: { community_probability: crowd, metaculus_post_id: 1 }, question: 'q' },
    });
  const m = mirrorComparison([mk(0.9, 0.6, 0), mk(0.8, 0.5, 0)]);
  assert.equal(m.n, 2);
  assert.ok(m.selfBrier > m.crowdBrier, 'the model was more confidently wrong');
  assert.ok(m.difference.mean > 0, 'positive difference means the model lost');
  assert.ok(Math.abs(m.meanAbsoluteDisagreement - 0.3) < 1e-9);
});

test('mirror comparison ignores self-authored questions', () => {
  assert.equal(mirrorComparison([entry(0.5, 1)]).n, 0);
});

test('hypotheses stay undecided until there is enough data', () => {
  const h = hypothesisTests([entry(0.9, 0), entry(0.9, 0)], config);
  assert.equal(h.H1.verdict.status, 'insufficient-data');
  assert.equal(h.H1.n, 2);
});

test('H2 detects under-rating continuity and can also be contradicted', () => {
  const continuity = (p, o) => entry(p, o, { prediction: { claim_type: 'continuity', category: 'status-quo' } });
  // Says 0.6 that nothing changes; nothing changes every time.
  const under = hypothesisTests([...Array(30)].map(() => continuity(0.6, 1)), config);
  assert.equal(under.H2.verdict.status, 'supported');
  assert.ok(under.H2.mean > 0.39);

  // The opposite world: says 0.9 and it only happens half the time.
  const over = hypothesisTests(
    [...[...Array(15)].map(() => continuity(0.9, 1)), ...[...Array(15)].map(() => continuity(0.9, 0))],
    config,
  );
  assert.equal(over.H2.verdict.status, 'contradicted');
});

test('meanWithCI degrades gracefully on empty and single-item samples', () => {
  assert.deepEqual(meanWithCI([]), { n: 0, mean: null, se: null, lo: null, hi: null });
  const one = meanWithCI([0.4]);
  assert.equal(one.n, 1);
  assert.equal(one.mean, 0.4);
  assert.equal(one.lo, null);
});

test('void predictions never reach the score', () => {
  const entries = [entry(0.5, 1), { ...entry(0.9, 0), state: 'void', outcome: null, brier: null }];
  assert.equal(summarise(entries).n, 1);
});
