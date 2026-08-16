import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, daysBetween, horizonBucket, todayUTC } from './config.js';
import { settleQuestion } from './settle.js';
import { scoredPositions } from './scoring.js';

/** Read a directory of JSON records, sorted by filename for reproducibility. */
function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map((f) => {
      const full = join(dir, f);
      try {
        return { file: f, path: full, record: JSON.parse(readFileSync(full, 'utf8')) };
      } catch (err) {
        throw new Error(`${full} is not valid JSON: ${err.message}`);
      }
    });
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${file}:${i + 1} is not valid JSON: ${err.message}`);
      }
    });
}

export const loadQuestions = () => readJsonDir(paths.questions);
export const loadSeats = () => readJsonDir(paths.seats);
export const loadResolutions = () => readJsonDir(paths.resolutions);

export const roundDir = (questionId, roundId) => join(paths.rounds, questionId, roundId);
export const commitmentsFile = (questionId, roundId) => join(roundDir(questionId, roundId), 'commitments.jsonl');
export const revealsFile = (questionId, roundId) => join(roundDir(questionId, roundId), 'reveals.jsonl');
export const clearingFile = (questionId, roundId) => join(roundDir(questionId, roundId), 'clearing.json');

export function loadPostmortems() {
  const out = new Map();
  if (!existsSync(paths.postmortems)) return out;
  for (const f of readdirSync(paths.postmortems).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()) {
    out.set(f.replace(/\.md$/, ''), readFileSync(join(paths.postmortems, f), 'utf8'));
  }
  return out;
}

/** State of a round right now, from its schedule and what has been written. */
export function roundState(question, round, nowISO) {
  const cleared = existsSync(clearingFile(question.id, round.id));
  if (cleared) return 'cleared';
  if (nowISO < round.opens_utc) return 'scheduled';
  if (nowISO <= round.closes_utc) return 'open';
  return 'awaiting-clear';
}

/**
 * Load the entire market and settle everything that has resolved.
 *
 * The whole state is a pure function of the committed files. There is no
 * database, and nothing here can differ from what is in git.
 */
export function loadMarket({ config = loadConfig(), today = todayUTC(), now = new Date().toISOString() } = {}) {
  const seats = new Map(loadSeats().map(({ record }) => [record.id, record]));
  const resolutions = new Map(loadResolutions().map(({ record }) => [record.question_id, record]));
  const postmortems = loadPostmortems();

  const questions = [];
  const positionsBySeat = new Map();

  for (const { record: q } of loadQuestions()) {
    const resolution = resolutions.get(q.id) ?? null;
    const outcome = resolution ? (resolution.status === 'void' ? null : resolution.status === 'yes' ? 1 : 0) : undefined;

    const clearings = [];
    const rounds = (q.rounds ?? []).map((r) => {
      const state = roundState(q, r, now);
      let clearing = null;
      if (existsSync(clearingFile(q.id, r.id))) {
        clearing = JSON.parse(readFileSync(clearingFile(q.id, r.id), 'utf8'));
        clearings.push({ ...clearing, round_id: r.id });
      }
      const commitments = readJsonl(commitmentsFile(q.id, r.id));
      return { ...r, state, clearing, commitment_count: commitments.length };
    });

    // The price path: the primary scientific output, so it is assembled once,
    // here, and everything downstream reads it rather than recomputing it.
    let last = config.rounds.opening_price;
    const pricePath = rounds
      .filter((r) => r.clearing)
      .map((r) => {
        const price = r.clearing.cleared ? r.clearing.clearing_price : last;
        const point = {
          round_id: r.id,
          t_minus_days: r.t_minus_days,
          closes_utc: r.closes_utc,
          price,
          cleared: r.clearing.cleared,
          volume: r.clearing.volume ?? 0,
          orders: r.clearing.orders ?? 0,
          reason: r.clearing.reason ?? null,
        };
        last = price;
        return point;
      });

    const settlement =
      outcome === undefined
        ? null
        : settleQuestion({ question: q, clearings, outcome, config });

    // Per-seat positions, joined to the price path so update speed is measurable.
    const seatPositions = new Map();
    for (const c of clearings) {
      if (!c.cleared) continue;
      for (const f of c.fills) {
        if (!seatPositions.has(f.seat)) seatPositions.set(f.seat, { round_probabilities: [], contracts: 0, staked: 0 });
        const sp = seatPositions.get(f.seat);
        sp.contracts += f.filled;
        sp.staked += f.filled * f.fill_price;
      }
    }
    for (const c of clearings) {
      if (!c.cleared) continue;
      for (const seatId of seatPositions.keys()) {
        const own = c.fills.filter((f) => f.seat === seatId);
        const den = own.reduce((a, f) => a + f.filled, 0);
        seatPositions.get(seatId).round_probabilities.push(
          den ? own.reduce((a, f) => a + (f.side === 'yes' ? f.limit_price : 1 - f.limit_price) * f.filled, 0) / den : null,
        );
      }
    }

    // Carried on every position so scoring can separate a two-day question from
    // a ninety-day one without going back to the question record.
    const qHorizon = daysBetween(q.created_utc.slice(0, 10), q.resolution_date);
    const qLane = q.lane ?? 'standard';
    const qScored = config.lanes?.[qLane]?.scored ?? true;

    for (const [seatId, sp] of seatPositions) {
      const settled = settlement?.seats.find((s) => s.seat === seatId) ?? null;
      const position = {
        question_id: q.id,
        seat: seatId,
        category: q.category,
        origin: q.origin,
        lane: qLane,
        scored: qScored,
        horizon_days: qHorizon,
        horizon_bucket: horizonBucket(qHorizon, config),
        contracts: sp.contracts,
        staked: Number(sp.staked.toFixed(4)),
        round_probabilities: sp.round_probabilities,
        outcome: outcome === undefined ? null : outcome,
        stated_probability: settled?.stated_probability ?? null,
        log_score: settled?.log_score ?? null,
        points_pnl: settled?.points_pnl ?? null,
        wins: settled?.wins ?? 0,
        losses: settled?.losses ?? 0,
      };
      if (!positionsBySeat.has(seatId)) positionsBySeat.set(seatId, []);
      positionsBySeat.get(seatId).push(position);
    }

    const horizonDays = qHorizon;
    questions.push({
      question: q,
      lane: qLane,
      scored: qScored,
      rounds,
      clearings,
      pricePath,
      resolution,
      settlement,
      postmortem: postmortems.get(q.id) ?? null,
      outcome: outcome === undefined ? null : outcome,
      state: resolution ? (resolution.status === 'void' ? 'void' : 'resolved') : q.resolution_date <= today ? 'awaiting-resolution' : 'open',
      currentPrice: pricePath.length ? pricePath[pricePath.length - 1].price : config.rounds.opening_price,
      horizonDays,
      horizonBucket: horizonBucket(horizonDays, config),
      openRound: rounds.find((r) => r.state === 'open') ?? null,
      nextRound: rounds.find((r) => r.state === 'scheduled') ?? null,
    });
  }

  questions.sort((a, b) => (a.question.created_utc < b.question.created_utc ? 1 : -1));

  // Bankroll: initial grant plus flat weekly top-ups, less what is at stake,
  // plus realised P&L. Flat rather than proportional, so early luck cannot
  // compound into a permanent advantage.
  const bankrolls = new Map();
  for (const [id, seat] of seats) {
    const weeks = Math.max(0, Math.floor(daysBetween(seat.registered_utc.slice(0, 10), today) / 7));
    const granted = config.bankroll.initial_points + weeks * config.bankroll.weekly_topup_points;
    // Unscored lanes do not touch the bankroll either, and this is load-bearing
    // rather than tidiness. A canary that cost points but paid no score would be
    // strictly negative-value to trade, every seat would rationally skip it, the
    // round would never clear for want of a counterparty - and the daily pipeline
    // test would go quiet while looking exactly like a market nobody turned up to.
    // The incentive has to match the intent or the check quietly stops working.
    const positions = scoredPositions(positionsBySeat.get(id) ?? [], config);
    const settledPnl = positions.reduce((a, p) => a + (p.points_pnl ?? 0), 0);
    const atRisk = positions.filter((p) => p.outcome === null && p.points_pnl === null).reduce((a, p) => a + p.staked, 0);
    bankrolls.set(id, {
      seat: id,
      granted,
      top_ups: weeks,
      realised_pnl: Number(settledPnl.toFixed(2)),
      at_risk: Number(atRisk.toFixed(2)),
      available: Number((granted + settledPnl - atRisk).toFixed(2)),
    });
  }

  return {
    config,
    today,
    now,
    seats,
    questions,
    questionsById: new Map(questions.map((q) => [q.question.id, q.question])),
    positionsBySeat,
    bankrolls,
    open: questions.filter((q) => q.state === 'open'),
    awaitingResolution: questions.filter((q) => q.state === 'awaiting-resolution'),
    resolved: questions.filter((q) => q.state === 'resolved'),
    voided: questions.filter((q) => q.state === 'void'),
    openRounds: questions.flatMap((q) => q.rounds.filter((r) => r.state === 'open').map((r) => ({ question: q.question, round: r }))),
    roundsAwaitingClear: questions.flatMap((q) => q.rounds.filter((r) => r.state === 'awaiting-clear').map((r) => ({ question: q.question, round: r }))),
  };
}
