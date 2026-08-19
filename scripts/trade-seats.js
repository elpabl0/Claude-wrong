#!/usr/bin/env node
/**
 * Trade the house seats from a scheduled job.
 *
 * Seat trading used to be four agent routines on a timer. Across a week they
 * fired many times and produced not one order: `rounds/` held nothing but its
 * README while a canary round opened and closed with all four inside its window.
 * Trigger-fired sessions in this environment cannot write, and the market's own
 * end-to-end test cannot be built on something that has never once been observed
 * to work. So this runs where every reliable commit in this repository has come
 * from: a GitHub Action.
 *
 * CREDENTIALS. The original house seats are unusable. Their tokens were minted
 * once into sessions that have since ended, which is precisely the orphaning that
 * `seat_secret` was added to prevent - the fix simply came after those seats were
 * registered. Rather than store four secrets, each seat's credential is derived
 * from one:
 *
 *     token = 'seat_' + HMAC-SHA256(MARKET_SEAT_SECRET, seat_id)
 *
 * so a single secret yields a stable, high-entropy credential per seat that can
 * be recomputed on any runner and never has to be written down anywhere. Seats
 * are registered on first use and reused after.
 *
 * MODEL. With ANTHROPIC_API_KEY set, every open round is priced by a model, one
 * independent call per seat, and that is the real business of the market. Without
 * it, only CANARY rounds are traded, at a fixed near-even price. That degradation
 * is deliberate: the canary is unscored and exists solely to keep the daily
 * pipeline test able to clear, so it must not depend on a paid API being
 * configured. Scored questions are never priced by a fixed rule - a mechanical
 * number dressed up as a forecast would corrupt the one record this site exists
 * to produce.
 *
 *   node scripts/trade-seats.js            trade every open round
 *   node scripts/trade-seats.js --dry-run  decide and print, submit nothing
 */
import { createHmac } from 'node:crypto';

const ENDPOINT = process.env.MARKET_URL ?? 'https://wrong.aecs.io/mcp';
const BASE = process.env.MARKET_SEAT_SECRET;
const API_KEY = process.env.ANTHROPIC_API_KEY || null;
const DRY = process.argv.includes('--dry-run');

if (!BASE || BASE.length < 32) {
  console.error('MARKET_SEAT_SECRET is not set, or is shorter than 32 characters.');
  console.error('Generate one with: openssl rand -hex 32   then store it as a repository secret.');
  process.exit(2);
}

/** The house seats. Declared scaffolds are what these actually are, not what would flatter them. */
const SEATS = [
  { id: 'house-v2', display_name: 'House', model: 'claude-opus-5', division: 'open',
    scaffold: 'Scheduled GitHub Action. One independent model call per question with the claim, criterion and current price; no retrieval, no tools, no deliberation beyond a single response.' },
  { id: 'opus-bare-v2', display_name: 'Opus (bare)', model: 'claude-opus-5', division: 'bare',
    scaffold: 'Scheduled GitHub Action. A single forward pass with the claim and criterion only. No retrieval, no tools, no browsing, no chain of drafts.' },
  { id: 'sonnet-open-v2', display_name: 'Sonnet (open)', model: 'claude-sonnet-5', division: 'open',
    scaffold: 'Scheduled GitHub Action. One independent model call per question with the claim, criterion and current price; no retrieval, no tools.' },
  { id: 'haiku-bare-v2', display_name: 'Haiku (bare)', model: 'claude-haiku-4-5-20251001', division: 'bare',
    scaffold: 'Scheduled GitHub Action. A single forward pass with the claim and criterion only. No retrieval, no tools, no browsing.' },
];

const tokenFor = (seatId) => `seat_${createHmac('sha256', BASE).update(seatId).digest('hex')}`;

let rpcId = 1;
async function call(name, args = {}, token = null) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  // A failed tool reports inside the result, not as a transport error, so this
  // has to be checked explicitly or failures read as successes.
  if (body.result?.isError) throw new Error(`${name}: ${body.result.content?.[0]?.text ?? 'tool error'}`);
  return body.result?.structuredContent ?? JSON.parse(body.result?.content?.[0]?.text ?? '{}');
}

/** Register a seat if it does not exist yet; harmless and idempotent afterwards. */
async function ensureSeat(seat) {
  const token = tokenFor(seat.id);
  try {
    await call('get_my_positions', {}, token);
    return token;
  } catch (err) {
    if (!/does not match any registered seat/i.test(err.message)) throw err;
  }
  await call('register_seat', {
    seat_id: seat.id, seat_secret: token, display_name: seat.display_name,
    model_string: seat.model, operator: 'wrong.aecs.io (house)',
    division: seat.division, scaffold_declaration: seat.scaffold,
  });
  console.log(`  registered ${seat.id}`);
  return token;
}

/**
 * A fixed near-even price for a canary, used only when no model is configured.
 * Alternating sides so the book has two sides and can actually clear: a round
 * where every seat bids the same way fails to clear, and a canary that cannot
 * clear silently disables the daily check while looking like a quiet day.
 */
function canaryFallback(index, dayKey) {
  const jitter = (Number(dayKey.replaceAll('-', '')) % 5) / 100; // 0.00 - 0.04, stable per day
  return index % 2 === 0
    ? { side: 'yes', limit_price: Number((0.55 + jitter).toFixed(2)) }
    : { side: 'no', limit_price: Number((0.50 - jitter).toFixed(2)) };
}

async function priceWithModel(seat, q) {
  const prompt = `You are pricing a claim on a prediction market. Reply with JSON only.

Claim: ${q.claim}
Resolves: ${q.resolution_date}
How it will be decided: ${q.resolution_criterion}
Current market price: ${q.current_price}

Give the probability YOU believe the claim resolves YES. You are scored with a
proper scoring rule, so your honest number is optimal - do not shade toward 0.5
to look humble or away from it to look decisive. Size 0 means you are skipping,
which is a legitimate move when you have no edge.

{"probability": <0-1>, "size": <whole contracts, 0 to skip>, "rationale": "<one or two sentences>"}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: seat.model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
  const text = (await res.json()).content?.map((c) => c.text ?? '').join('') ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model reply');
  const out = JSON.parse(m[0]);
  if (!out.size || out.size < 1) return null;

  const p = Math.min(0.97, Math.max(0.03, Number(out.probability)));
  return {
    // One number in, side derived here, so the YES/NO conversion lives in one
    // place rather than being trusted to prose.
    side: p >= 0.5 ? 'yes' : 'no',
    limit_price: Number((p >= 0.5 ? p : 1 - p).toFixed(2)),
    size: Math.min(60, Math.floor(out.size)),
    rationale: String(out.rationale ?? '').slice(0, 400),
  };
}

/* ---------------------------------------------------------------------- run */

const { questions } = await call('list_open_questions', { only_open_rounds: true });
if (!questions.length) {
  console.log('No round is open. Rounds are windows, not a continuous book - this is normal.');
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const tradeable = API_KEY ? questions : questions.filter((q) => (q.lane ?? 'standard') === 'canary');

if (!API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set: trading canary rounds only, at a fixed near-even price.');
  console.log('Scored questions are deliberately left alone - a mechanical number presented as a forecast would corrupt the record.');
}
if (!tradeable.length) {
  console.log(`${questions.length} open round(s), none of them canaries, and no model configured. Nothing to do.`);
  process.exit(0);
}

let submitted = 0;
let failed = 0;

for (const [index, seat] of SEATS.entries()) {
  console.log(`\n${seat.id}`);
  let token;
  try {
    token = await ensureSeat(seat);
  } catch (err) {
    console.error(`  could not establish seat: ${err.message}`);
    failed += 1;
    continue;
  }

  for (const q of tradeable) {
    const isCanary = (q.lane ?? 'standard') === 'canary';
    let order = null;
    try {
      if (API_KEY) order = await priceWithModel(seat, q);
      if (!order && isCanary) {
        // The canary must clear, so it is never skipped: a day with no canary
        // clear is indistinguishable from a day nobody turned up.
        order = { ...canaryFallback(index, today), size: 10,
          rationale: API_KEY
            ? 'Canary: the model declined to take a side, so a fixed near-even price was submitted to keep the daily pipeline test able to clear. Unscored.'
            : 'Canary: fixed near-even price, no model configured for this run. This question is unscored and exists to keep the daily pipeline test able to clear.' };
      }
    } catch (err) {
      console.error(`  ${q.id}: could not price (${err.message})`);
      if (!isCanary) { failed += 1; continue; }
      order = { ...canaryFallback(index, today), size: 10, rationale: 'Canary: fixed near-even price after a pricing failure. Unscored; exists to keep the daily pipeline test able to clear.' };
    }

    if (!order) { console.log(`  ${q.id}: skipped`); continue; }

    const line = `${order.side} @ ${order.limit_price} x ${order.size}`;
    if (DRY) { console.log(`  ${q.id}: would submit ${line}`); continue; }
    try {
      await call('submit_order', {
        question_id: q.id, round_id: q.open_round.round_id,
        side: order.side, limit_price: order.limit_price, size: order.size, rationale: order.rationale,
      }, token);
      console.log(`  ${q.id}: ${line}`);
      submitted += 1;
    } catch (err) {
      console.error(`  ${q.id}: rejected - ${err.message}`);
      failed += 1;
    }
  }
}

console.log(`\n${DRY ? 'Dry run.' : `Submitted ${submitted} order(s), ${failed} failure(s).`}`);
// A run where every seat failed is a broken market, not a quiet one, and must
// turn the job red rather than reporting success with nothing to show.
if (!DRY && submitted === 0) {
  console.error('No order was submitted by any seat. Failing so this is visible rather than silent.');
  process.exit(1);
}
