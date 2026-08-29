#!/usr/bin/env node
/**
 * Close a round and clear the book at a single uniform price.
 *
 * No model is involved at any point. This reads the commitments published
 * during the window, opens the order bodies, verifies each one against the hash
 * that was committed before the close, and runs the auction. An order that does
 * not match its commitment is rejected and recorded as rejected - never quietly
 * accepted, and never quietly dropped.
 *
 *   node scripts/clear-round.js                      clear every round past its close
 *   node scripts/clear-round.js --question=<id> --round=r2
 *   node scripts/clear-round.js --dry-run
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { paths, loadConfig } from '../lib/config.js';
import { loadMarket, readJsonl, commitmentsFile, revealsFile, clearingFile, roundDir } from '../lib/market.js';
import { verifyRound, unsealOrder } from '../lib/seal.js';
import { clearRound } from '../lib/auction.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const DRY = process.argv.includes('--dry-run');
const onlyQuestion = arg('question');
const onlyRound = arg('round');

const config = loadConfig();
const now = arg('now', new Date().toISOString());
const market = loadMarket({ config, now });

const privateKey = process.env.MARKET_SEAL_PRIVATE_KEY
  ? process.env.MARKET_SEAL_PRIVATE_KEY.includes('BEGIN')
    ? process.env.MARKET_SEAL_PRIVATE_KEY
    : Buffer.from(process.env.MARKET_SEAL_PRIVATE_KEY, 'base64').toString('utf8')
  : null;

let due = market.roundsAwaitingClear;
if (onlyQuestion) due = due.filter((d) => d.question.id === onlyQuestion);
if (onlyRound) due = due.filter((d) => d.round.id === onlyRound);

if (!due.length) {
  console.log(`No rounds awaiting a clear as of ${now}. ${market.openRounds.length} round(s) currently open.`);
  process.exit(0);
}

let wrote = 0;
// Rounds this runner refused to clear because it could not open their orders.
// Tracked separately from `wrote` because the two need opposite exit codes: a
// round with nothing in it is a quiet day, a round whose orders exist and
// cannot be read is a broken market that will stay broken until someone acts.
const blocked = [];
for (const { question, round } of due) {
  const commitments = readJsonl(commitmentsFile(question.id, round.id));
  const revealLines = readJsonl(revealsFile(question.id, round.id));

  // Open each order body. A sealed body needs the private key; an open-book
  // round carries the body in the clear and is labelled as such everywhere.
  const reveals = [];
  const unopened = [];
  for (const line of revealLines) {
    if (line.open_book) {
      reveals.push(line.open_book);
    } else if (line.sealed) {
      if (!privateKey) {
        unopened.push({ order_id: line.order_id, seat: line.seat, reason: 'sealed, and MARKET_SEAL_PRIVATE_KEY is not configured on this runner' });
        continue;
      }
      try {
        reveals.push(unsealOrder(line.sealed, privateKey));
      } catch (err) {
        unopened.push({ order_id: line.order_id, seat: line.seat, reason: `could not be unsealed: ${err.message}` });
      }
    }
  }

  // If orders are sealed and this runner has no key, clearing anyway would drop
  // real orders from the book and publish a price that never existed. Leave the
  // round unclear instead: it stays in the queue and clears correctly once the
  // key is configured. Failing to produce a price is recoverable; publishing a
  // wrong one is not.
  const missingKey = unopened.filter((u) => /MARKET_SEAL_PRIVATE_KEY/.test(u.reason));
  if (missingKey.length) {
    console.error(
      `${question.id} ${round.id}: ${missingKey.length} sealed order(s) and no MARKET_SEAL_PRIVATE_KEY on this runner.\n` +
        '    Refusing to clear - clearing without them would publish a price that never existed.\n' +
        '    Set the secret and re-run; the round is still queued.',
    );
    blocked.push(`${question.id}/${round.id}`);
    continue;
  }

  const { verified, rejected } = verifyRound(commitments, reveals);
  const allRejected = [...rejected, ...unopened];

  // A round must be a market, not a monologue: two orders from one seat is one
  // opinion talking to itself.
  const distinctSeats = new Set(verified.map((o) => o.seat)).size;
  const priorPrice = (() => {
    const entry = market.questions.find((q) => q.question.id === question.id);
    const earlier = entry.pricePath.filter((p) => p.closes_utc < round.closes_utc);
    return earlier.length ? earlier[earlier.length - 1].price : config.rounds.opening_price;
  })();

  let result;
  if (distinctSeats < config.rounds.min_distinct_seats_to_clear) {
    result = {
      cleared: false,
      reason: `${distinctSeats} distinct seat(s) submitted; ${config.rounds.min_distinct_seats_to_clear} required to clear`,
      carried_price: priorPrice,
      orders: verified.length,
    };
  } else {
    result = clearRound(
      verified.map((o) => ({ order_id: o.order_id, seat: o.seat, side: o.side, limit_price: o.limit_price, size: o.size })),
      { minOrders: config.rounds.min_orders_to_clear, priorPrice },
    );
  }

  const record = {
    question_id: question.id,
    round_id: round.id,
    closed_utc: round.closes_utc,
    cleared_utc: new Date().toISOString(),
    seal_mode: commitments.every((c) => c.seal_mode === 'sealed') && commitments.length ? 'sealed' : 'open-book',
    prior_price: priorPrice,
    commitments: commitments.length,
    verified: verified.length,
    rejected: allRejected,
    protocol_version: config.protocol_version,
    ...result,
    // The full book is published the moment the round closes, and stays public.
    book: verified
      .map((o) => ({ order_id: o.order_id, seat: o.seat, side: o.side, limit_price: o.limit_price, size: o.size, submitted_utc: o.submitted_utc, rationale: o.rationale ?? null }))
      .sort((a, b) => a.order_id.localeCompare(b.order_id)),
  };

  const label = result.cleared
    ? `cleared at ${result.clearing_price} on ${result.volume} contracts`
    : `no clear (${result.reason}); price carried at ${priorPrice}`;
  console.log(`${question.id} ${round.id}: ${label}${allRejected.length ? ` — ${allRejected.length} order(s) rejected` : ''}`);
  for (const r of allRejected) console.log(`    rejected ${r.order_id} (${r.seat}): ${r.reason}`);

  if (!DRY) {
    mkdirSync(roundDir(question.id, round.id), { recursive: true });
    writeFileSync(clearingFile(question.id, round.id), JSON.stringify(record, null, 2) + '\n');
    wrote += 1;
  }
}

console.log(`\n${DRY ? 'Would clear' : 'Cleared'} ${DRY ? due.length : wrote} round(s).`);

// Exit 3, not 0 and not 1.
//
// Refusing to clear is the right call - publishing a price computed from only
// the orders you happen to be able to read is worse than publishing none. But
// this script exited 0 while refusing, so the workflow went green, the watchdog
// saw a healthy run, and the first round this market ever had orders in sat
// unclear with nothing anywhere saying so. A correct refusal that reports
// success is indistinguishable from a quiet day, and a quiet day is exactly
// what this market has had for six weeks.
//
// A distinct code rather than 1 so the caller can tell "this runner is missing
// a secret" from "this script crashed", and can still run the resolution and
// publishing steps - which need no key - before failing the job at the end.
if (blocked.length && !DRY) {
  console.error(
    `\n${blocked.length} round(s) could not be cleared for want of MARKET_SEAL_PRIVATE_KEY: ${blocked.join(', ')}.\n` +
      'They stay queued and will clear correctly once the secret is set on the runner.',
  );
  process.exit(3);
}
