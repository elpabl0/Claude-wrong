#!/usr/bin/env node
/**
 * Submit sealed orders into an open round.
 *
 * This is the only way an order enters the market, and it is the code path the
 * MCP server will call in Phase 2 - the transport changes, this does not.
 *
 * Reads a JSON array of orders on stdin:
 *   [{ "question_id": "...", "round_id": "r2", "side": "yes", "limit_price": 0.62, "size": 40 }]
 *
 *   node scripts/submit-order.js --seat=house < orders.json
 *   node scripts/submit-order.js --seat=house --dry-run < orders.json
 *
 * Two artefacts are written per order. The commitment - a hash of the order plus
 * a random salt - goes into the public log immediately, which fixes the order
 * beyond alteration while revealing nothing about it. The order body goes into
 * the reveal log, encrypted to the market key if one is configured. After the
 * window closes, scripts/clear-round.js opens the bodies and checks every one
 * against the commitment that was published before the close.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig } from '../lib/config.js';
import { loadMarket, commitmentsFile, revealsFile, roundDir } from '../lib/market.js';
import { validateOrder } from '../lib/schema.js';
import { commitmentHash, newSalt, sealOrder } from '../lib/seal.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const DRY = process.argv.includes('--dry-run');
const seatId = arg('seat');
if (!seatId) {
  console.error('usage: node scripts/submit-order.js --seat=<seat-id> < orders.json');
  process.exit(2);
}

const config = loadConfig();
const now = arg('now', new Date().toISOString());
const market = loadMarket({ config, now });

const seat = market.seats.get(seatId);
if (!seat) {
  console.error(`No registered seat "${seatId}". Seats live in seats/ and are registered before they can trade.`);
  process.exit(2);
}

const SEAL_KEY_FILE = join(paths.root, 'config', 'seal-public-key.pem');
const sealPublicKey = existsSync(SEAL_KEY_FILE) ? readFileSync(SEAL_KEY_FILE, 'utf8') : null;
const mode = sealPublicKey ? 'sealed' : 'open-book';

const input = readFileSync(0, 'utf8').trim();
if (!input) {
  console.error('No orders on stdin.');
  process.exit(2);
}
let submitted;
try {
  submitted = JSON.parse(input);
} catch (err) {
  console.error(`stdin is not valid JSON: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(submitted)) submitted = [submitted];

// Bankroll is checked against everything already at stake plus everything in
// this batch, so a seat cannot slip past the cap by splitting one bet in two.
const bankroll = { ...(market.bankrolls.get(seatId) ?? { granted: config.bankroll.initial_points, available: config.bankroll.initial_points }) };
const errors = [];
const accepted = [];

for (const [i, raw] of submitted.entries()) {
  const entry = market.questions.find((q) => q.question.id === raw.question_id);
  if (!entry) {
    errors.push(`order ${i}: no question ${JSON.stringify(raw.question_id)}`);
    continue;
  }
  const round = entry.rounds.find((r) => r.id === raw.round_id);
  if (!round) {
    errors.push(`order ${i}: question ${raw.question_id} has no round ${JSON.stringify(raw.round_id)}`);
    continue;
  }
  if (round.state !== 'open') {
    errors.push(`order ${i}: round ${raw.round_id} is ${round.state}, not open (window ${round.opens_utc} → ${round.closes_utc})`);
    continue;
  }

  const existing = new Set(
    (existsSync(commitmentsFile(entry.question.id, round.id))
      ? readFileSync(commitmentsFile(entry.question.id, round.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []
    ).filter((c) => c.seat === seatId).map((c) => c.order_id),
  );

  const order = {
    order_id: `${entry.question.id}-${round.id}-${seatId}-${String(existing.size + accepted.filter((a) => a.order.question_id === entry.question.id && a.order.round_id === round.id).length + 1).padStart(2, '0')}`,
    question_id: entry.question.id,
    round_id: round.id,
    seat: seatId,
    side: raw.side,
    limit_price: raw.limit_price,
    size: raw.size,
  };

  const { ok, errors: errs } = validateOrder(order, { question: entry.question, round, config, bankroll, nowISO: now });
  if (!ok) {
    errors.push(...errs.map((e) => `order ${i}: ${e}`));
    continue;
  }

  bankroll.available -= order.size * order.limit_price;
  accepted.push({ order, entry, round, rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 2000) : null });
}

for (const e of errors) console.error(`rejected  ${e}`);
if (!accepted.length) {
  console.error(`\nNothing accepted. ${errors.length} order(s) rejected.`);
  process.exit(errors.length ? 1 : 0);
}

for (const { order, entry, round, rationale } of accepted) {
  const salt = newSalt();
  const commitment = commitmentHash(order, salt);
  // The same clock the window check uses. This is a convenience field: the
  // authoritative timestamp is the git commit that publishes the commitment,
  // which is what scripts/verify-integrity.js checks and nobody can forge.
  const submitted_utc = now;

  const commitmentLine = { order_id: order.order_id, seat: seatId, commitment, submitted_utc, seal_mode: mode };
  // The rationale is committed alongside the order and revealed with it. It is
  // hashed into nothing - only the order itself is binding - but it is written
  // before the outcome is known, which is the part that matters.
  const revealBody = { ...order, salt, rationale, round_closes_utc: round.closes_utc };
  const revealLine = sealPublicKey
    ? { order_id: order.order_id, seat: seatId, sealed: sealOrder(revealBody, sealPublicKey) }
    : { order_id: order.order_id, seat: seatId, open_book: revealBody };

  if (DRY) {
    console.log(`would submit ${order.order_id}: ${order.side} ${order.size} @ ${order.limit_price} (${mode})`);
    continue;
  }
  mkdirSync(roundDir(entry.question.id, round.id), { recursive: true });
  appendFileSync(commitmentsFile(entry.question.id, round.id), JSON.stringify(commitmentLine) + '\n');
  appendFileSync(revealsFile(entry.question.id, round.id), JSON.stringify(revealLine) + '\n');
  console.log(`submitted ${order.order_id}: ${order.side} ${order.size} @ ${order.limit_price} — commitment ${commitment.slice(0, 12)}… (${mode})`);
}

if (mode === 'open-book') {
  console.warn(
    '\nNote: no config/seal-public-key.pem, so this round is open-book — order bodies are readable in the repository before the window closes.\n' +
      'The commitment hashes are published either way, so nothing can be altered after the fact. Run scripts/seal-keys.js to turn sealing on.',
  );
}
console.log(`\n${accepted.length} order(s) submitted by ${seatId}; ${bankroll.available.toFixed(2)} points left available.`);
