#!/usr/bin/env node
/**
 * Produce the redacted brief for a post-mortem.
 *
 * The point of this script is what it withholds. A separate instance writes the
 * analysis of a bad call, and it is given the question, the probability, the
 * outcome and the resolution evidence - but never the original `reasoning` or
 * `evidence_that_would_move_me`. It therefore cannot reconstruct and defend the
 * original argument; it has to explain the miss from the outside, the way a
 * reader would. Any reasoning it produces is a fresh reconstruction, and where
 * that reconstruction differs from what was actually written is itself a finding.
 *
 *   node scripts/postmortem-brief.js            list everything owing a post-mortem
 *   node scripts/postmortem-brief.js <id>       print the brief for one prediction
 */
import { loadConfig, todayUTC } from '../lib/config.js';
import { loadLedger } from '../lib/ledger.js';

const REDACTED_FIELDS = ['reasoning', 'evidence_that_would_move_me'];

const config = loadConfig();
const ledger = loadLedger({ config, today: todayUTC() });
const id = process.argv.slice(2).find((a) => !a.startsWith('--'));

const owing = ledger.scored
  .filter((e) => e.brier !== null && e.brier > config.postmortem.trigger_brier_above && !e.postmortem)
  .sort((a, b) => b.brier - a.brier);

if (!id) {
  if (!owing.length) {
    console.log('No post-mortems owed.');
    process.exit(0);
  }
  console.log(`${owing.length} post-mortem(s) owed, worst first:\n`);
  for (const e of owing) {
    console.log(`  ${e.prediction.id}  p=${e.prediction.probability}  outcome=${e.resolution.status.toUpperCase()}  Brier=${e.brier.toFixed(4)}`);
    console.log(`      ${e.prediction.question}`);
  }
  process.exit(0);
}

const entry = ledger.byId.get(id);
if (!entry) {
  console.error(`No prediction with id ${id}.`);
  process.exit(1);
}
if (!entry.resolution || entry.resolution.status === 'void') {
  console.error(`${id} has not been resolved to a YES or NO, so there is nothing to explain.`);
  process.exit(1);
}

const p = entry.prediction;
const r = entry.resolution;
const redacted = Object.fromEntries(Object.entries(p).filter(([k]) => !REDACTED_FIELDS.includes(k)));

console.log(`# Post-mortem brief: ${p.id}

You are analysing a forecast that another instance made and got wrong. You have
NOT been shown its reasoning, and you should not ask for it — the point of this
exercise is that the account of a bad call is not written by the thing that made
it. Work from the question, the number, and what actually happened.

## The forecast

Question:            ${p.question}
Probability of YES:  ${p.probability}
Category:            ${p.category} (${p.claim_type}, ${entry.horizonBucket} horizon, ${entry.horizonDays} days)
Written:             ${p.created_utc} by ${p.model}
Resolution date:     ${p.resolution_date}
Criterion, fixed in advance:
    ${p.resolution_criterion.replace(/\n/g, '\n    ')}

## What happened

Outcome:             ${r.status.toUpperCase()}
Brier score:         ${entry.brier.toFixed(4)} ${entry.brier > 0.25 ? '(worse than a coin flip)' : ''}
Resolver:            ${r.resolver_type}
Machine evidence:    ${r.detail}
Resolved at:         ${r.resolved_utc}

## What to write

Write \`ledger/postmortems/${p.id}.md\`, 200–400 words, covering:

1. **What a well-informed forecaster knew on ${p.batch}.** Reconstruct the
   evidence that was actually available on the day, not what is obvious now.
2. **The most likely failure mode.** Name one, specifically. Candidates worth
   testing rather than reciting: anchoring on a salient recent event; treating a
   plan or an announcement as an outcome; underweighting how long institutional
   processes take; assuming a trend continues through a step change; or simply
   pricing the base rate wrong.
3. **What the number should have been**, and why — a specific alternative
   probability, with the reason it is better.
4. **Whether this is a one-off or a pattern.** Check the other resolved
   predictions in the same category before answering (\`node scripts/status.js --json\`).

Do not soften the verdict, and do not write that the forecast was "reasonable
given the information available" unless you can say concretely what information
was missing and why it was not obtainable on the day. Sign off with the model
string you are running as.

## Machine-readable record (reasoning fields removed)

${JSON.stringify(redacted, null, 2)}
`);
