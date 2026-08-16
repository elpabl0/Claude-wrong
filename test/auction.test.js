import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearRound, toYesSpace, findClearingPrice, allocate, AuctionError } from '../lib/auction.js';

let n = 0;
const order = (seat, side, limit_price, size) => ({ order_id: `o${String(++n).padStart(3, '0')}`, seat, side, limit_price, size });

test('a NO order at q is a YES sell at 1-q', () => {
  assert.deepEqual(toYesSpace({ side: 'no', limit_price: 0.3 }).direction, 'sell');
  assert.equal(toYesSpace({ side: 'no', limit_price: 0.3 }).yes_price, 0.7);
  assert.equal(toYesSpace({ side: 'yes', limit_price: 0.3 }).yes_price, 0.3);
  assert.throws(() => toYesSpace({ side: 'maybe', limit_price: 0.3 }), AuctionError);
});

test('two crossing orders clear between them and both stakes sum to one per contract', () => {
  const orders = [order('a', 'yes', 0.7, 10), order('b', 'no', 0.5, 10)]; // b sells YES at 0.5
  const r = clearRound(orders);
  assert.equal(r.cleared, true);
  assert.equal(r.volume, 10);
  assert.ok(r.clearing_price >= 0.5 && r.clearing_price <= 0.7);
  const [f1, f2] = r.fills;
  // A YES buyer pays P, a NO buyer pays 1-P; together exactly 1 per contract.
  assert.ok(Math.abs(f1.fill_price + f2.fill_price - 1) < 1e-9);
  assert.ok(Math.abs(f1.stake + f2.stake - 10) < 1e-9);
});

test('a book that does not cross does not clear, and says so', () => {
  // Buyer will pay at most 0.30; seller wants at least 0.70.
  const r = clearRound([order('a', 'yes', 0.3, 10), order('b', 'no', 0.3, 10)], { priorPrice: 0.42 });
  assert.equal(r.cleared, false);
  assert.match(r.reason, /highest bid is below the lowest offer/);
  assert.equal(r.carried_price, 0.42, 'the prior price carries forward rather than being invented');
});

test('a one-sided book does not clear', () => {
  const r = clearRound([order('a', 'yes', 0.6, 5), order('b', 'yes', 0.7, 5)]);
  assert.equal(r.cleared, false);
  assert.match(r.reason, /one-sided/);
});

test('a thin round does not clear below the minimum order count', () => {
  const r = clearRound([order('a', 'yes', 0.6, 5)], { minOrders: 2, priorPrice: 0.5 });
  assert.equal(r.cleared, false);
  assert.match(r.reason, /1 order/);
  assert.equal(r.carried_price, 0.5);
});

test('the clearing price maximises matched volume', () => {
  const orders = [
    order('a', 'yes', 0.80, 30),
    order('b', 'yes', 0.60, 20),
    order('c', 'no', 0.70, 40), // sells YES at 0.30
    order('d', 'no', 0.50, 10), // sells YES at 0.50
  ];
  const r = clearRound(orders);
  assert.equal(r.cleared, true);
  // Volume peaks at 50 across the whole band 0.50-0.60, with zero imbalance at
  // both ends, so the neutral choice is the midpoint rather than either edge.
  assert.equal(r.volume, 50);
  assert.ok(Math.abs(r.clearing_price - 0.55) < 1e-9, `cleared at ${r.clearing_price}`);
});

test('every contract bought is a contract sold', () => {
  const orders = [
    order('a', 'yes', 0.9, 17),
    order('b', 'yes', 0.75, 23),
    order('c', 'no', 0.6, 31), // sells YES at 0.40
    order('d', 'no', 0.35, 19), // sells YES at 0.65
  ];
  const r = clearRound(orders);
  assert.equal(r.cleared, true);
  const bought = r.fills.filter((f) => f.side === 'yes').reduce((a, f) => a + f.filled, 0);
  const sold = r.fills.filter((f) => f.side === 'no').reduce((a, f) => a + f.filled, 0);
  assert.equal(bought, sold);
  assert.equal(bought, r.volume);
  assert.equal(r.pairs.reduce((a, p) => a + p.size, 0), r.volume, 'pairing covers exactly the traded volume');
});

test('nobody is ever filled beyond the size they submitted, or worse than their limit', () => {
  const orders = [
    order('a', 'yes', 0.95, 5),
    order('b', 'yes', 0.55, 100),
    order('c', 'no', 0.9, 40), // sells YES at 0.10
    order('d', 'no', 0.8, 40), // sells YES at 0.20
  ];
  const r = clearRound(orders);
  for (const f of r.fills) {
    assert.ok(f.filled <= f.size, `${f.order_id} overfilled`);
    // The price paid must never exceed what the seat said it would pay.
    assert.ok(f.fill_price <= f.limit_price + 1e-9, `${f.order_id} paid ${f.fill_price} above its limit ${f.limit_price}`);
  }
});

test('pro-rata rationing at the margin allocates exactly the traded volume', () => {
  // Three identical marginal buyers competing for an odd number of contracts.
  const orders = [
    order('a', 'yes', 0.5, 10),
    order('b', 'yes', 0.5, 10),
    order('c', 'yes', 0.5, 10),
    order('d', 'no', 0.5, 7), // sells YES at 0.50
  ];
  const r = clearRound(orders);
  assert.equal(r.cleared, true);
  assert.equal(r.volume, 7);
  const filled = r.fills.filter((f) => f.side === 'yes').reduce((a, f) => a + f.filled, 0);
  assert.equal(filled, 7, 'largest-remainder rounding must not invent or lose a contract');
});

test('price priority fills the keener orders first', () => {
  const buys = [
    { order_id: 'hi', yes_price: 0.9, size: 5, seat: 'a' },
    { order_id: 'lo', yes_price: 0.5, size: 5, seat: 'b' },
  ];
  const fills = allocate(buys, 5, true, 0.5);
  assert.equal(fills.get('hi'), 5);
  assert.equal(fills.get('lo') ?? 0, 0);
});

test('clearing is deterministic — the same book always gives the same result', () => {
  const build = () => [
    order('a', 'yes', 0.72, 13),
    order('b', 'no', 0.44, 21),
    order('c', 'yes', 0.58, 8),
    order('d', 'no', 0.61, 15),
  ];
  n -= 8; // reuse the same order ids for both runs
  const first = clearRound(build());
  n -= 4;
  const second = clearRound(build());
  assert.deepEqual(first, second);
});

test('malformed orders are refused rather than silently coerced', () => {
  assert.throws(() => clearRound([{ order_id: 'x', seat: 'a', side: 'yes', limit_price: 0.5, size: 2.5 }]), AuctionError);
  assert.throws(() => clearRound([{ order_id: 'x', seat: 'a', side: 'yes', limit_price: 0, size: 5 }]), AuctionError);
  assert.throws(() => clearRound([{ order_id: 'x', seat: 'a', side: 'yes', limit_price: 1, size: 5 }]), AuctionError);
  assert.throws(() => clearRound('not an array'), AuctionError);
});

test('findClearingPrice returns null on an empty or non-crossing book', () => {
  assert.equal(findClearingPrice([], []), null);
  assert.equal(
    findClearingPrice([{ yes_price: 0.2, size: 5 }], [{ yes_price: 0.8, size: 5 }]),
    null,
  );
});
