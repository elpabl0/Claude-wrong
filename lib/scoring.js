import { loadConfig } from './config.js';

export const brier = (p, outcome) => (p - outcome) ** 2;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Sample standard deviation. Null below two observations. */
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Mean of a sample with a normal-approximation 95% interval.
 * The interval assumes independent observations; questions asked in the same
 * batch about the same subject are not fully independent, so treat it as a rough
 * guide to whether an effect is worth talking about, not as a p-value.
 */
export function meanWithCI(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, se: null, lo: null, hi: null };
  const m = mean(xs);
  const s = sd(xs);
  const se = s === null ? null : s / Math.sqrt(n);
  return {
    n,
    mean: m,
    se,
    lo: se === null ? null : m - 1.96 * se,
    hi: se === null ? null : m + 1.96 * se,
  };
}

/** Headline numbers for a set of scored entries. */
export function summarise(entries) {
  const scored = entries.filter((e) => e.brier !== null && e.outcome !== null);
  const briers = scored.map((e) => e.brier);
  const probs = scored.map((e) => e.prediction.probability);
  const outcomes = scored.map((e) => e.outcome);
  const baseRate = mean(outcomes);

  // Skill against two reference forecasters: the coin, and one that always
  // predicts the observed base rate (the hardest naive benchmark to beat).
  const briersVsHalf = outcomes.map((o) => brier(0.5, o));
  const briersVsBase = baseRate === null ? [] : outcomes.map((o) => brier(baseRate, o));
  const mb = mean(briers);

  return {
    n: scored.length,
    meanBrier: mb,
    brierCI: meanWithCI(briers),
    meanProbability: mean(probs),
    baseRate,
    calibrationGap: meanWithCI(scored.map((e) => e.prediction.probability - e.outcome)),
    meanBrierCoinflip: mean(briersVsHalf),
    meanBrierBaseRate: mean(briersVsBase),
    skillVsCoinflip: mb === null || !briersVsHalf.length ? null : 1 - mb / mean(briersVsHalf),
    skillVsBaseRate: mb === null || !briersVsBase.length || mean(briersVsBase) === 0 ? null : 1 - mb / mean(briersVsBase),
  };
}

/** Calibration table: predicted probability against observed frequency, per bin. */
export function calibration(entries, config = loadConfig()) {
  const scored = entries.filter((e) => e.brier !== null && e.outcome !== null);
  return config.calibration.bins.map(([lo, hi]) => {
    const inBin = scored.filter((e) => {
      const p = e.prediction.probability;
      return hi === 1.0 ? p >= lo && p <= hi : p >= lo && p < hi;
    });
    return {
      lo,
      hi,
      label: `${lo.toFixed(1)}–${hi.toFixed(1)}`,
      n: inBin.length,
      meanPredicted: mean(inBin.map((e) => e.prediction.probability)),
      observed: mean(inBin.map((e) => e.outcome)),
      ids: inBin.map((e) => e.prediction.id),
    };
  });
}

/**
 * Expected calibration error: bin-count-weighted mean gap between the average
 * forecast in a bin and what actually happened in it.
 */
export function expectedCalibrationError(bins) {
  const used = bins.filter((b) => b.n > 0);
  const total = used.reduce((a, b) => a + b.n, 0);
  if (!total) return null;
  return used.reduce((a, b) => a + (b.n / total) * Math.abs(b.meanPredicted - b.observed), 0);
}

/**
 * Murphy's three-way decomposition: Brier = reliability - resolution + uncertainty.
 *  - reliability (lower is better): how far forecasts sit from the truth within a bin.
 *  - resolution (higher is better): how much the forecasts separate events from non-events.
 *  - uncertainty: the base rate's own variance - a property of the questions, not the forecaster.
 * It is the honest way to tell "well calibrated but useless" from "informative but overconfident".
 */
export function murphyDecomposition(entries, config = loadConfig()) {
  const scored = entries.filter((e) => e.brier !== null && e.outcome !== null);
  if (scored.length === 0) return { n: 0, reliability: null, resolution: null, uncertainty: null, residual: null };
  const bins = calibration(scored, config).filter((b) => b.n > 0);
  const N = scored.length;
  const base = mean(scored.map((e) => e.outcome));

  let reliability = 0;
  let resolution = 0;
  for (const b of bins) {
    reliability += (b.n / N) * (b.meanPredicted - b.observed) ** 2;
    resolution += (b.n / N) * (b.observed - base) ** 2;
  }
  const uncertainty = base * (1 - base);
  const meanBrier = mean(scored.map((e) => e.brier));
  return {
    n: N,
    reliability,
    resolution,
    uncertainty,
    meanBrier,
    // Binning is lossy, so the identity only holds approximately; publishing the
    // residual keeps that visible instead of hiding it.
    residual: meanBrier - (reliability - resolution + uncertainty),
  };
}

/** Split entries by a key and summarise each group. */
export function breakdown(entries, keyFn) {
  const groups = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...summarise(group) }))
    .sort((a, b) => b.n - a.n || String(a.key).localeCompare(String(b.key)));
}

/**
 * Paired comparison against the Metaculus community on mirrored questions:
 * same question, same day, both scored on the same outcome.
 */
export function mirrorComparison(entries) {
  const pairs = entries.filter(
    (e) =>
      e.prediction.origin === 'metaculus-mirror' &&
      e.outcome !== null &&
      typeof e.prediction.external_reference?.community_probability === 'number',
  );
  const selfBriers = pairs.map((e) => brier(e.prediction.probability, e.outcome));
  const crowdBriers = pairs.map((e) => brier(e.prediction.external_reference.community_probability, e.outcome));
  const diffs = pairs.map((_, i) => selfBriers[i] - crowdBriers[i]);
  return {
    n: pairs.length,
    selfBrier: mean(selfBriers),
    crowdBrier: mean(crowdBriers),
    // Positive means the model was worse than the crowd.
    difference: meanWithCI(diffs),
    meanAbsoluteDisagreement: mean(
      pairs.map((e) => Math.abs(e.prediction.probability - e.prediction.external_reference.community_probability)),
    ),
    pairs: pairs.map((e, i) => ({
      id: e.prediction.id,
      question: e.prediction.question,
      self: e.prediction.probability,
      crowd: e.prediction.external_reference.community_probability,
      outcome: e.outcome,
      selfBrier: selfBriers[i],
      crowdBrier: crowdBriers[i],
    })),
  };
}

const MIN_N = 20;

function verdict({ n, lo, hi }, direction) {
  if (n < MIN_N) return { status: 'insufficient-data', text: `${n} resolved of ${MIN_N} needed before this is worth reading` };
  if (lo === null) return { status: 'insufficient-data', text: 'not enough variation to estimate an interval' };
  const supportsPositive = lo > 0;
  const supportsNegative = hi < 0;
  if (direction === 'positive') {
    if (supportsPositive) return { status: 'supported', text: 'the 95% interval excludes zero in the predicted direction' };
    if (supportsNegative) return { status: 'contradicted', text: 'the effect is significant in the opposite direction' };
  } else {
    if (supportsNegative) return { status: 'supported', text: 'the 95% interval excludes zero in the predicted direction' };
    if (supportsPositive) return { status: 'contradicted', text: 'the effect is significant in the opposite direction' };
  }
  return { status: 'undecided', text: 'the 95% interval still contains zero' };
}

/**
 * Evaluate the three hypotheses registered in config/ledger.json before the
 * first batch was written. Each is a signed quantity with an interval, so it can
 * come out against the forecaster.
 */
export function hypothesisTests(entries, config = loadConfig()) {
  const scored = entries.filter((e) => e.brier !== null && e.outcome !== null);

  // H1: overconfidence on technology timelines. Positive = predicted more than happened.
  const h1Set = scored.filter((e) => e.prediction.category === 'ai-capability' && e.prediction.claim_type === 'change');
  const h1 = meanWithCI(h1Set.map((e) => e.prediction.probability - e.outcome));

  // H2: under-rating continuity. Positive = the world stayed put more often than predicted.
  const h2Set = scored.filter((e) => e.prediction.claim_type === 'continuity');
  const h2 = meanWithCI(h2Set.map((e) => e.outcome - e.prediction.probability));

  // H3: worse than the crowd on identical questions. Positive = worse.
  const mirror = mirrorComparison(scored);

  return {
    H1: { ...config.hypotheses.H1, statistic: 'mean(predicted − observed)', ...h1, verdict: verdict(h1, 'positive') },
    H2: { ...config.hypotheses.H2, statistic: 'mean(observed − predicted)', ...h2, verdict: verdict(h2, 'positive') },
    H3: {
      ...config.hypotheses.H3,
      statistic: 'mean(self Brier − community Brier), paired',
      ...mirror.difference,
      selfBrier: mirror.selfBrier,
      crowdBrier: mirror.crowdBrier,
      verdict: verdict(mirror.difference, 'positive'),
    },
  };
}

/** Everything the site and the JSON API need, in one object. */
export function fullReport(ledger) {
  const { entries, config } = ledger;
  const scored = entries.filter((e) => e.state === 'resolved');
  const bins = calibration(scored, config);
  return {
    generated_utc: new Date().toISOString(),
    protocol_version: config.protocol_version,
    counts: {
      total: entries.length,
      open: ledger.open.length,
      overdue: ledger.overdue.length,
      resolved: scored.length,
      void: ledger.voided.length,
      void_rate: entries.length ? ledger.voided.length / entries.length : 0,
    },
    overall: summarise(scored),
    calibration: bins,
    expected_calibration_error: expectedCalibrationError(bins),
    murphy: murphyDecomposition(scored, config),
    by_category: breakdown(scored, (e) => e.prediction.category),
    by_claim_type: breakdown(scored, (e) => e.prediction.claim_type),
    by_horizon: breakdown(scored, (e) => e.horizonBucket),
    by_origin: breakdown(scored, (e) => e.prediction.origin),
    by_model: breakdown(scored, (e) => e.prediction.model),
    by_protocol_version: breakdown(scored, (e) => e.prediction.protocol_version),
    mirror: mirrorComparison(scored),
    hypotheses: hypothesisTests(scored, config),
  };
}
