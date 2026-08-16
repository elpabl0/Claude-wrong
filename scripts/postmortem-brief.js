#!/usr/bin/env node
/**
 * Produce the redacted brief for a post-mortem.
 *
 * The point of this script is what it withholds. A separate instance writes up a
 * bad call, and it is given the claim, the position, the outcome and the machine
 * evidence - but never the rationale the seat wrote when it placed the trade. It
 * therefore cannot reconstruct and defend the original argument; it has to
 * explain the loss from the outside, the way a reader would. Where its
 * reconstruction differs from what was actually written is itself a finding.
 *
 *   node scripts/postmortem-brief.js                       list what is owed
 *   node scripts/postmortem-brief.js <question-id> --seat=<seat>
 */
import { loadConfig, todayUTC } from '../lib/config.js';
import { loadMarket } from '../lib/market.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const config = loadConfig();
const market = loadMarket({ config, today: todayUTC() });
const questionId = process.argv.slice(2).find((a) => !a.startsWith('--'));
const seatId = arg('seat');

const owed = market.questions
  .filter((q) => q.settlement && !q.postmortem)
  .flatMap((q) => q.settlement.seats.filter((s) => s.log_score < config.postmortem.trigger_log_score_below).map((s) => ({ q, s })))
  .sort((a, b) => a.s.log_score - b.s.log_score);

if (!questionId) {
  if (!owed.length) {
    console.log('No post-mortems owed.');
    process.exit(0);
  }
  console.log(`${owed.length} post-mortem(s) owed, worst first:\n`);
  for (const { q, s } of owed) {
    console.log(`  ${q.question.id}  seat ${s.seat}  log score ${s.log_score.toFixed(3)}  (stated ${s.stated_probability}, outcome ${q.resolution.status})`);
    console.log(`      ${q.question.claim}`);
  }
  process.exit(0);
}

const entry = market.questions.find((q) => q.question.id === questionId);
if (!entry) {
  console.error(`No question with id ${questionId}.`);
  process.exit(1);
}
if (!entry.settlement || entry.outcome === null) {
  console.error(`${questionId} has not resolved to a YES or NO, so there is nothing to explain.`);
  process.exit(1);
}

const candidates = entry.settlement.seats.filter((s) => s.log_score < config.postmortem.trigger_log_score_below);
const seat = seatId ? entry.settlement.seats.find((s) => s.seat === seatId) : candidates[0];
if (!seat) {
  console.error(`No seat on ${questionId} owes a post-mortem. Pass --seat=<id> to force one.`);
  process.exit(1);
}

const Q = entry.question;
const R = entry.resolution;

console.log(`# Post-mortem brief: ${Q.id} / ${seat.seat}

You are analysing a position that another instance took and lost. You have NOT
been shown the rationale it wrote at the time, and you should not go looking for
it — the point of this exercise is that the account of a bad call is not written
by the thing that made it. Work from the claim, the number, and what happened.

## The claim

${Q.claim}

Category:            ${Q.category} (${Q.origin}, ${entry.horizonBucket} horizon, ${entry.horizonDays} days)
Written:             ${Q.created_utc} by ${Q.author_model}
Criterion, fixed in advance:
    ${Q.resolution_criterion.replace(/\n/g, '\n    ')}

## The position

Seat:                ${seat.seat}
Stated probability:  ${seat.stated_probability}
Contracts:           ${seat.contracts} (${seat.staked} points staked)
Log score:           ${seat.log_score}
Points:              ${seat.points_pnl}

## The market around it

Price path:          ${entry.pricePath.map((p) => `T-${p.t_minus_days}: ${p.price}${p.cleared ? '' : ' (no clear)'}`).join('  →  ') || 'no round cleared'}
Final price:         ${entry.currentPrice}
${Q.origin === 'mirrored' ? `Human crowd (${Q.external_reference.platform}) on the day the question was written: ${Q.external_reference.community_probability}` : 'This was a house question, so there is no human crowd reference.'}

Other seats on this question:
${entry.settlement.seats.map((s) => `    ${s.seat.padEnd(14)} stated ${String(s.stated_probability).padEnd(8)} log ${String(s.log_score).padStart(8)}`).join('\n')}

## What happened

Outcome:             ${R.status.toUpperCase()}
Machine evidence:    ${R.detail}
Resolved:            ${R.resolved_utc}

## What to write

Write \`postmortems/${Q.id}.md\`, 200–400 words, covering:

1. **What a well-informed forecaster knew on ${Q.created_utc.slice(0, 10)}.**
   Reconstruct the evidence actually available then, not what is obvious now.
2. **The most likely failure mode.** Name one, specifically. Candidates worth
   testing rather than reciting: anchoring on a salient recent event; treating a
   plan or an announcement as an outcome; underweighting how long institutional
   processes take; assuming a trend continues through a step change; or simply
   pricing the base rate wrong.
3. **What the number should have been**, and why — a specific alternative, with
   the reason it is better.
4. **Whether this is a one-off or a pattern.** Check this seat's other settled
   positions in the same category before answering
   (\`node scripts/status.js --json\`). If the other seats priced it better, say
   what they might have seen that this one did not.

Do not soften the verdict, and do not write that the position was "reasonable
given the information available" unless you can say concretely what information
was missing and why it was not obtainable on the day. Sign off with the model
string you are running as.
`);
