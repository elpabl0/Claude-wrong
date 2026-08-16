/**
 * Sealed-bid uniform-price call auction.
 *
 * This is the central mechanic and the most likely thing to get subtly wrong,
 * so it is a pure function with no I/O: same orders in, same clearing out,
 * exhaustively tested in test/auction.test.js.
 *
 * Why a batch auction rather than a continuous order book: participants run on
 * schedules, not screens. In a continuous book an agent posting at 06:00 gets
 * filled at noon by something that has read six more hours of news - a latency
 * edge dressed up as a disagreement about probability. A sealed batch round
 * takes that away. Everyone submits blind, everyone clears at one price, and
 * the only thing that distinguishes participants is what they believed.
 *
 * Convention (Polymarket's): buying NO at 0.30 is the same order as selling YES
 * at 0.70. One book covers both sides. Internally everything is normalised to
 * YES space: a NO order at limit q becomes a YES sell with limit 1 - q.
 */

/** Orders are integer-sized; money is integer points. Probabilities are floats. */
const EPS = 1e-9;

export class AuctionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuctionError';
  }
}

/** Normalise a submitted order into YES space. */
export function toYesSpace(order) {
  if (order.side === 'yes') {
    return { ...order, direction: 'buy', yes_price: order.limit_price };
  }
  if (order.side === 'no') {
    // Buying NO at q == selling YES at 1 - q.
    return { ...order, direction: 'sell', yes_price: 1 - order.limit_price };
  }
  throw new AuctionError(`unknown side ${JSON.stringify(order.side)}`);
}

/** Total size of buys willing to pay at least `price`. */
function demandAt(buys, price) {
  return buys.reduce((a, o) => (o.yes_price >= price - EPS ? a + o.size : a), 0);
}

/** Total size of sells willing to accept at most `price`. */
function supplyAt(sells, price) {
  return sells.reduce((a, o) => (o.yes_price <= price + EPS ? a + o.size : a), 0);
}

/**
 * Find the uniform clearing price.
 *
 * Standard call-auction rule, in order:
 *   1. maximise matched volume;
 *   2. among ties, minimise the imbalance |demand - supply|;
 *   3. among ties still, take the midpoint of the tied price range, which is
 *      the neutral choice between the two sides.
 */
export function findClearingPrice(buys, sells) {
  const candidates = [...new Set([...buys, ...sells].map((o) => o.yes_price))].sort((a, b) => a - b);
  let best = null;
  const tied = [];

  for (const price of candidates) {
    const demand = demandAt(buys, price);
    const supply = supplyAt(sells, price);
    const volume = Math.min(demand, supply);
    if (volume <= 0) continue;
    const imbalance = Math.abs(demand - supply);
    const key = { price, demand, supply, volume, imbalance };
    if (
      best === null ||
      volume > best.volume ||
      (volume === best.volume && imbalance < best.imbalance)
    ) {
      best = key;
      tied.length = 0;
      tied.push(price);
    } else if (volume === best.volume && imbalance === best.imbalance) {
      tied.push(price);
    }
  }

  if (best === null) return null;
  const price = (Math.min(...tied) + Math.max(...tied)) / 2;
  return { price, volume: best.volume, demand: demandAt(buys, price), supply: supplyAt(sells, price) };
}

/**
 * Allocate `volume` across one side of the book: price priority first, then
 * pro-rata among orders at the margin, with largest-remainder rounding so the
 * allocated total is exactly `volume` and no contract is invented or lost.
 */
export function allocate(orders, volume, isBuy, clearingPrice) {
  const eligible = orders.filter((o) =>
    isBuy ? o.yes_price >= clearingPrice - EPS : o.yes_price <= clearingPrice + EPS,
  );
  // Strictly better than the clearing price fills first; orders exactly at it are rationed.
  const strict = eligible.filter((o) =>
    isBuy ? o.yes_price > clearingPrice + EPS : o.yes_price < clearingPrice - EPS,
  );
  const marginal = eligible.filter((o) => !strict.includes(o));

  const fills = new Map();
  let remaining = volume;

  for (const o of strict.sort((a, b) => (isBuy ? b.yes_price - a.yes_price : a.yes_price - b.yes_price))) {
    const q = Math.min(o.size, remaining);
    if (q > 0) fills.set(o.order_id, q);
    remaining -= q;
    if (remaining <= 0) break;
  }

  if (remaining > 0 && marginal.length) {
    const total = marginal.reduce((a, o) => a + o.size, 0);
    const exact = marginal.map((o) => {
      const want = (o.size * remaining) / total;
      const floor = Math.min(o.size, Math.floor(want));
      return { o, want, floor, rem: want - Math.floor(want) };
    });

    // Largest remainder distributes the rounding leftovers deterministically.
    // These must be the same objects that are read back below - handing out
    // increments to copies is how a contract goes quietly missing.
    let leftovers = remaining - exact.reduce((a, e) => a + e.floor, 0);
    const byRemainder = [...exact].sort(
      (a, b) => b.rem - a.rem || String(a.o.order_id).localeCompare(String(b.o.order_id)),
    );
    for (const e of byRemainder) {
      if (leftovers <= 0) break;
      if (e.floor >= e.o.size) continue; // never allocate past what was offered
      e.floor += 1;
      leftovers -= 1;
    }

    for (const e of exact) {
      const q = Math.min(e.o.size, e.floor);
      if (q > 0) fills.set(e.o.order_id, (fills.get(e.o.order_id) ?? 0) + q);
    }
  }

  return fills;
}

/**
 * Pair filled buyers against filled sellers so that every traded contract has a
 * named counterparty. The pairwise log score in lib/scoring.js needs this: a
 * score that is zero-sum "against the market" is not zero-sum against anyone in
 * particular, and cannot be attributed.
 *
 * Pairing is deterministic (sorted by order id) so the record is reproducible.
 */
export function pairFills(buyFills, sellFills, orders) {
  const byId = new Map(orders.map((o) => [o.order_id, o]));
  const buys = [...buyFills.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const sells = [...sellFills.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  const pairs = [];
  let bi = 0;
  let si = 0;
  let bLeft = buys.length ? buys[0][1] : 0;
  let sLeft = sells.length ? sells[0][1] : 0;

  while (bi < buys.length && si < sells.length) {
    const q = Math.min(bLeft, sLeft);
    if (q > 0) {
      pairs.push({
        size: q,
        buy_order_id: buys[bi][0],
        sell_order_id: sells[si][0],
        buyer_seat: byId.get(buys[bi][0]).seat,
        seller_seat: byId.get(sells[si][0]).seat,
      });
    }
    bLeft -= q;
    sLeft -= q;
    if (bLeft === 0) {
      bi += 1;
      bLeft = bi < buys.length ? buys[bi][1] : 0;
    }
    if (sLeft === 0) {
      si += 1;
      sLeft = si < sells.length ? sells[si][1] : 0;
    }
  }
  return pairs;
}

/**
 * Clear one round.
 *
 * Returns `{ cleared: false, reason }` when the round cannot produce a price -
 * too few orders, or no crossing. A round that does not clear carries the prior
 * price forward and says so. It never invents one: a fabricated price would
 * corrupt the price path, which is the primary scientific output here.
 */
export function clearRound(orders, { minOrders = 2, priorPrice = null } = {}) {
  if (!Array.isArray(orders)) throw new AuctionError('orders must be an array');

  for (const o of orders) {
    if (!Number.isInteger(o.size) || o.size <= 0) throw new AuctionError(`order ${o.order_id}: size must be a positive integer`);
    if (!(o.limit_price > 0 && o.limit_price < 1)) throw new AuctionError(`order ${o.order_id}: limit_price must be strictly inside (0, 1)`);
  }

  if (orders.length < minOrders) {
    return { cleared: false, reason: `only ${orders.length} order(s); ${minOrders} required to clear`, carried_price: priorPrice, orders: orders.length };
  }

  const normalised = orders.map(toYesSpace);
  const buys = normalised.filter((o) => o.direction === 'buy');
  const sells = normalised.filter((o) => o.direction === 'sell');

  if (!buys.length || !sells.length) {
    return { cleared: false, reason: `book is one-sided (${buys.length} buy, ${sells.length} sell)`, carried_price: priorPrice, orders: orders.length };
  }

  const found = findClearingPrice(buys, sells);
  if (!found) {
    return { cleared: false, reason: 'no crossing orders: the highest bid is below the lowest offer', carried_price: priorPrice, orders: orders.length };
  }

  const { price, volume } = found;
  const buyFills = allocate(buys, volume, true, price);
  const sellFills = allocate(sells, volume, false, price);
  const pairs = pairFills(buyFills, sellFills, normalised);

  const fills = normalised
    .map((o) => {
      const filled = (o.direction === 'buy' ? buyFills : sellFills).get(o.order_id) ?? 0;
      if (filled <= 0) return null;
      // Each side pays in its own space: a YES buyer pays the clearing price, a
      // NO buyer pays one minus it. Together they always stake exactly 1 per
      // contract, which is what makes settlement zero-sum.
      const paid = o.side === 'yes' ? price : 1 - price;
      return {
        order_id: o.order_id,
        seat: o.seat,
        side: o.side,
        limit_price: o.limit_price,
        size: o.size,
        filled,
        fill_price: Number(paid.toFixed(6)),
        stake: Number((filled * paid).toFixed(6)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.order_id).localeCompare(String(b.order_id)));

  return {
    cleared: true,
    clearing_price: Number(price.toFixed(6)),
    volume,
    demand: found.demand,
    supply: found.supply,
    orders: orders.length,
    fills,
    pairs,
  };
}
