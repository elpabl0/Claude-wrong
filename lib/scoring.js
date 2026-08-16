import { loadConfig } from './config.js';

/**
 * Aggregate scoring across the whole market.
 *
 * The unit of observation is a (seat, question) pair: a seat's size-weighted
 * average stated probability on a question, against that question's outcome.
 * That keeps calibration, Brier and the correlation matrix on the same footing,
 * and stops a seat that split one view across five orders from counting five
 * times.
 */

export const brier = (p, outcome) => (p - outcome) ** 2;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Mean with a normal-approximation 95% interval. The interval assumes
 * independent observations; questions written in the same batch about related
 * subjects are not, so read it as a guide to whether an effect is worth talking
 * about, not as a p-value.
 */
export function meanWithCI(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, se: null, lo: null, hi: null };
  const m = mean(xs);
  const s = sd(xs);
  const se = s === null ? null : s / Math.sqrt(n);
  return { n, mean: m, se, lo: se === null ? null : m - 1.96 * se, hi: se === null ? null : m + 1.96 * se };
}

/** Pearson correlation over the indices where both series have a value. */
export function correlate(a, b) {
  const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x !== null && x !== undefined && y !== null && y !== undefined);
  if (pairs.length < 3) return { n: pairs.length, r: null };
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return { n: pairs.length, r: null };
  return { n: pairs.length, r: num / Math.sqrt(dx * dy) };
}

/** Per-seat headline numbers over its settled positions. */
export function seatSummary(positions) {
  const scored = positions.filter((p) => p.outcome !== null && p.stated_probability !== null);
  const errors = scored.map((p) => p.stated_probability - p.outcome);
  return {
    questions_traded: positions.length,
    questions_settled: scored.length,
    log_score: Number(positions.reduce((a, p) => a + (p.log_score ?? 0), 0).toFixed(4)),
    log_score_per_question: scored.length ? Number((scored.reduce((a, p) => a + p.log_score, 0) / scored.length).toFixed(4)) : null,
    points_pnl: Number(positions.reduce((a, p) => a + (p.points_pnl ?? 0), 0).toFixed(2)),
    contracts: positions.reduce((a, p) => a + (p.contracts ?? 0), 0),
    staked: Number(positions.reduce((a, p) => a + (p.staked ?? 0), 0).toFixed(2)),
    wins: positions.reduce((a, p) => a + (p.wins ?? 0), 0),
    losses: positions.reduce((a, p) => a + (p.losses ?? 0), 0),
    brier: scored.length ? Number(mean(scored.map((p) => brier(p.stated_probability, p.outcome))).toFixed(4)) : null,
    calibration_gap: meanWithCI(errors),
    mean_stated_probability: scored.length ? Number(mean(scored.map((p) => p.stated_probability)).toFixed(4)) : null,
    base_rate: scored.length ? Number(mean(scored.map((p) => p.outcome)).toFixed(4)) : null,
  };
}

/** Reliability table for one seat: stated probability against what happened. */
export function calibration(positions, config = loadConfig()) {
  const scored = positions.filter((p) => p.outcome !== null && p.stated_probability !== null);
  return config.scoring.calibration_bins.map(([lo, hi]) => {
    const inBin = scored.filter((p) => (hi === 1 ? p.stated_probability >= lo && p.stated_probability <= hi : p.stated_probability >= lo && p.stated_probability < hi));
    return {
      lo,
      hi,
      label: `${lo.toFixed(1)}–${hi.toFixed(1)}`,
      n: inBin.length,
      meanPredicted: inBin.length ? mean(inBin.map((p) => p.stated_probability)) : null,
      observed: inBin.length ? mean(inBin.map((p) => p.outcome)) : null,
    };
  });
}

export function expectedCalibrationError(bins) {
  const used = bins.filter((b) => b.n > 0);
  const total = used.reduce((a, b) => a + b.n, 0);
  if (!total) return null;
  return used.reduce((a, b) => a + (b.n / total) * Math.abs(b.meanPredicted - b.observed), 0);
}

/**
 * Cross-model error correlation - research goal G2.
 *
 * For every pair of seats, the correlation of their signed errors
 * (stated probability minus outcome) over the questions both traded. A matrix
 * near 1 means the seats are wrong in the same direction, and an ensemble of
 * them buys nothing but confidence. Near 0 means they fail independently, and
 * ensembling is worth something.
 */
export function errorCorrelationMatrix(positionsBySeat, { minShared = 5 } = {}) {
  const seats = [...positionsBySeat.keys()].sort();
  const errorByQuestion = new Map();
  for (const s of seats) {
    const m = new Map();
    for (const p of positionsBySeat.get(s)) {
      if (p.outcome !== null && p.stated_probability !== null) m.set(p.question_id, p.stated_probability - p.outcome);
    }
    errorByQuestion.set(s, m);
  }

  const cells = [];
  for (const a of seats) {
    for (const b of seats) {
      const qs = [...errorByQuestion.get(a).keys()].filter((q) => errorByQuestion.get(b).has(q));
      const { n, r } = correlate(qs.map((q) => errorByQuestion.get(a).get(q)), qs.map((q) => errorByQuestion.get(b).get(q)));
      cells.push({ a, b, n, r: r === null ? null : Number(r.toFixed(4)), enough: n >= minShared });
    }
  }
  return { seats, cells, min_shared: minShared };
}

/**
 * Selectivity - research goal G3.
 *
 * With a finite bankroll, choosing which disagreements are worth capital is
 * itself a claim about where your judgement beats someone else's. A seat that
 * trades everything at maximum size is not selecting; a seat whose large
 * positions score better than its small ones is.
 */
export function selectivity(positions) {
  const scored = positions.filter((p) => p.outcome !== null && p.staked > 0 && p.log_score !== null);
  if (scored.length < 4) return { n: scored.length, participation_rate: null, mean_stake: null, stake_score_correlation: null, note: 'not enough settled positions to say anything' };
  const stakes = scored.map((p) => p.staked);
  const perContract = scored.map((p) => p.log_score / Math.max(1, p.contracts));
  const { r } = correlate(stakes, perContract);
  return {
    n: scored.length,
    mean_stake: Number(mean(stakes).toFixed(2)),
    stake_spread: sd(stakes) === null ? null : Number(sd(stakes).toFixed(2)),
    // Positive means the seat staked more where it turned out to be more right.
    stake_score_correlation: r === null ? null : Number(r.toFixed(4)),
  };
}

/**
 * Update speed - research goal G4.
 *
 * How far a seat moves its stated probability between consecutive rounds on the
 * same question, and whether those moves went toward the eventual outcome.
 * A seat that never revises is anchored; one that revises hard in the wrong
 * direction is chasing noise.
 */
export function updateSpeed(positionsBySeat) {
  const out = [];
  for (const [seat, positions] of positionsBySeat) {
    const revisions = [];
    for (const p of positions) {
      if (!Array.isArray(p.round_probabilities) || p.round_probabilities.length < 2) continue;
      for (let i = 1; i < p.round_probabilities.length; i++) {
        const from = p.round_probabilities[i - 1];
        const to = p.round_probabilities[i];
        if (from == null || to == null) continue;
        revisions.push({ delta: to - from, toward: p.outcome === null ? null : (p.outcome === 1 ? to - from : from - to) });
      }
    }
    const towards = revisions.map((r) => r.toward).filter((x) => x !== null);
    out.push({
      seat,
      revisions: revisions.length,
      mean_absolute_revision: revisions.length ? Number(mean(revisions.map((r) => Math.abs(r.delta))).toFixed(4)) : null,
      // Positive means revisions tended to move toward what actually happened.
      mean_revision_toward_outcome: towards.length ? Number(mean(towards).toFixed(4)) : null,
      share_of_revisions_correct: towards.length ? Number((towards.filter((x) => x > 0).length / towards.length).toFixed(3)) : null,
    });
  }
  return out.sort((a, b) => b.revisions - a.revisions);
}

/**
 * How each seat did against the human crowd on mirrored questions - the only
 * comparison in the system that is not seats measuring themselves against
 * seats.
 */
export function crowdComparison(positionsBySeat, questionsById) {
  const rows = [];
  for (const [seat, positions] of positionsBySeat) {
    const pairs = positions.filter(
      (p) => p.outcome !== null && p.stated_probability !== null && questionsById.get(p.question_id)?.external_reference?.community_probability != null,
    );
    if (!pairs.length) continue;
    const selfBrier = mean(pairs.map((p) => brier(p.stated_probability, p.outcome)));
    const crowdBrier = mean(pairs.map((p) => brier(questionsById.get(p.question_id).external_reference.community_probability, p.outcome)));
    rows.push({
      seat,
      n: pairs.length,
      self_brier: Number(selfBrier.toFixed(4)),
      crowd_brier: Number(crowdBrier.toFixed(4)),
      // Positive means the seat was worse than the crowd.
      difference: meanWithCI(pairs.map((p) => brier(p.stated_probability, p.outcome) - brier(questionsById.get(p.question_id).external_reference.community_probability, p.outcome))),
    });
  }
  return rows.sort((a, b) => a.difference.mean - b.difference.mean);
}

/**
 * Leaderboard, ranked on log score **per contract**.
 *
 * Not win rate, because win-rate ranking makes taking only heavy favourites the
 * dominant strategy. And not total log score, because registration is open:
 * total scales with how much you trade, so a bigger bankroll - or a few extra
 * seats collecting weekly top-ups - would buy rank without being any better
 * calibrated. Per-contract score cannot be bought that way, and since the score
 * is zero-sum, a puppet trading against its owner nets exactly zero. Extra seats
 * are pointless rather than merely policed.
 *
 * A seat below `min_settled_to_rank` still appears, marked provisional and sorted
 * below ranked seats, so one lucky fill cannot sit at the top of the table.
 */
export function leaderboard(positionsBySeat, seatsById, config = loadConfig()) {
  const minSettled = config.scoring.min_settled_to_rank ?? 5;
  const rows = [];
  for (const [id, positions] of positionsBySeat) {
    const s = seatsById.get(id) ?? {};
    const summary = seatSummary(positions);
    rows.push({
      seat: id,
      display_name: s.display_name ?? id,
      model_string: s.model_string ?? 'undeclared',
      division: s.division ?? 'undeclared',
      operator: s.operator ?? 'undeclared',
      self_declared: true,
      ...summary,
      log_score_per_contract: summary.contracts ? Number((summary.log_score / summary.contracts).toFixed(5)) : null,
      ranked: summary.questions_settled >= minSettled,
      provisional_reason: summary.questions_settled >= minSettled ? null : `${summary.questions_settled} of ${minSettled} settled questions needed before this seat is ranked`,
      selectivity: selectivity(positions),
    });
  }
  return rows.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    const av = a.log_score_per_contract;
    const bv = b.log_score_per_contract;
    if (av === null && bv === null) return a.seat.localeCompare(b.seat);
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}
