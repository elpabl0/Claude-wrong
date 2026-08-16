import { loadConfig } from './config.js';

/**
 * Settlement and scoring of a single question.
 *
 * Two numbers come out of every fill, and they measure different things.
 *
 * **Points P&L** drives the bankroll. It is linear in probability, which makes
 * it a fine budget but a poor score: an agent maximises expected points by
 * betting maximum size whenever it disagrees with the price at all, however
 * slightly. Points reward the direction of a disagreement, not the honest
 * magnitude of it.
 *
 * **Pairwise log score** drives the ranking. For each traded contract there is a
 * named buyer and a named seller with stated probabilities p and q, and the
 * score is `size × (ls(p) − ls(q)) / 2` to the buyer and its negative to the
 * seller, where `ls(p) = ln p` if the claim resolved YES and `ln(1 − p)` if NO.
 * This is zero-sum by construction, and proper: a seat maximises its expected
 * score by stating the probability it actually believes, because the
 * counterparty's term does not depend on its own report. It also pays properly
 * for being right at long odds, which win-rate ranking does not.
 *
 * One honest caveat, stated here because it is easy to miss: a limit price is a
 * bound, not a belief. A seat bidding 0.70 for YES is saying "at least 0.70",
 * not "exactly 0.70". Scoring the limit as the stated probability is the
 * standard simplification, and it is what makes the rule proper - the seat
 * chooses the number it is scored on.
 */

/** A seat's stated probability that the claim resolves YES, from its own order. */
export function statedProbability(order) {
  return order.side === 'yes' ? order.limit_price : 1 - order.limit_price;
}

/** Log score of a stated probability against an outcome, clamped away from infinity. */
export function logScore(p, outcome, clamp = loadConfig().scoring.clamp_probability) {
  const q = Math.min(1 - clamp, Math.max(clamp, p));
  return outcome === 1 ? Math.log(q) : Math.log(1 - q);
}

/**
 * Settle every fill on a question.
 *
 * `outcome` is 1 (YES), 0 (NO) or null (void). A void returns every stake
 * untouched and scores nothing - it must never move a leaderboard, or voiding
 * would become a strategy.
 */
export function settleQuestion({ question, clearings, outcome, config = loadConfig() }) {
  const clamp = config.scoring.clamp_probability;
  const bySeat = new Map();

  const seat = (id) => {
    if (!bySeat.has(id)) {
      bySeat.set(id, {
        seat: id,
        contracts: 0,
        staked: 0,
        payout: 0,
        points_pnl: 0,
        log_score: 0,
        stated_probability: null,
        wins: 0,
        losses: 0,
      });
    }
    return bySeat.get(id);
  };

  const fillRecords = [];
  const pairRecords = [];
  const weighted = new Map(); // seat -> { sum(p * size), sum(size) }

  for (const c of clearings) {
    if (!c.cleared) continue;
    const byOrder = new Map(c.fills.map((f) => [f.order_id, f]));

    for (const f of c.fills) {
      const s = seat(f.seat);
      const p = statedProbability(f);
      const stake = f.filled * f.fill_price;
      s.contracts += f.filled;
      s.staked += stake;

      const w = weighted.get(f.seat) ?? { num: 0, den: 0 };
      w.num += p * f.filled;
      w.den += f.filled;
      weighted.set(f.seat, w);

      let payout = 0;
      if (outcome === null) {
        payout = stake; // void: stake returned
      } else {
        const won = (f.side === 'yes' && outcome === 1) || (f.side === 'no' && outcome === 0);
        payout = won ? f.filled : 0;
        if (won) s.wins += 1;
        else s.losses += 1;
      }
      s.payout += payout;
      s.points_pnl += payout - stake;

      fillRecords.push({
        round_id: c.round_id,
        order_id: f.order_id,
        seat: f.seat,
        side: f.side,
        stated_probability: Number(p.toFixed(6)),
        filled: f.filled,
        fill_price: f.fill_price,
        stake: Number(stake.toFixed(6)),
        payout: Number(payout.toFixed(6)),
        points_pnl: Number((payout - stake).toFixed(6)),
      });
    }

    if (outcome === null) continue;

    for (const pair of c.pairs) {
      const buy = byOrder.get(pair.buy_order_id);
      const sell = byOrder.get(pair.sell_order_id);
      if (!buy || !sell) continue;
      const pBuy = statedProbability(buy);
      const pSell = statedProbability(sell);
      const delta = (pair.size * (logScore(pBuy, outcome, clamp) - logScore(pSell, outcome, clamp))) / 2;
      seat(pair.buyer_seat).log_score += delta;
      seat(pair.seller_seat).log_score -= delta;
      pairRecords.push({
        round_id: c.round_id,
        size: pair.size,
        buyer_seat: pair.buyer_seat,
        seller_seat: pair.seller_seat,
        buyer_probability: Number(pBuy.toFixed(6)),
        seller_probability: Number(pSell.toFixed(6)),
        buyer_log_score: Number(delta.toFixed(6)),
      });
    }
  }

  for (const [id, w] of weighted) {
    if (w.den > 0) seat(id).stated_probability = Number((w.num / w.den).toFixed(6));
  }
  for (const s of bySeat.values()) {
    s.staked = Number(s.staked.toFixed(6));
    s.payout = Number(s.payout.toFixed(6));
    s.points_pnl = Number(s.points_pnl.toFixed(6));
    s.log_score = Number(s.log_score.toFixed(6));
  }

  const seats = [...bySeat.values()].sort((a, b) => a.seat.localeCompare(b.seat));

  // Two invariants worth asserting rather than assuming: contracts net out, and
  // the log score is zero-sum. If either drifts, the record is wrong.
  const logSum = seats.reduce((a, s) => a + s.log_score, 0);
  const pointsSum = seats.reduce((a, s) => a + s.points_pnl, 0);

  return {
    question_id: question.id,
    outcome,
    seats,
    fills: fillRecords,
    pairs: pairRecords,
    invariants: {
      log_score_sum: Number(logSum.toFixed(6)),
      points_pnl_sum: Number(pointsSum.toFixed(6)),
      zero_sum_ok: Math.abs(logSum) < 1e-6 && Math.abs(pointsSum) < 1e-6,
    },
  };
}
