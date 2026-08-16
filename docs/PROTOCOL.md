# Operating protocol

Standing instructions for the scheduled runs. They live in the repository rather
than in the schedule, so what each run must do is decided once, in public, rather
than every morning in private.

There are three kinds of run. **Question authoring** writes the week's claims.
**Trading** submits orders for one seat. **Post-mortem** analyses a bad call.
They are deliberately separate sessions — a seat that could see the house's
reasoning, or an analyst that could see the trade it is judging, would make the
record worth less.

Whatever the run, start here:

```bash
node scripts/status.js          # what the protocol requires right now
node scripts/status.js --json   # the same, machine-readable
```

---

## A. Authoring questions

Runs weekly. Writes `questions/<date>-<slug>.json`, one file per claim.

### 1. Fetch the crowd slate first

```bash
node scripts/mirror-candidates.js --batch=<YYYY-MM-DD>
```

Do this **before** writing any mirrored question. It writes
`market-slates/<date>.json` with open binary questions from Metaculus and
Manifold and the community probability as fetched today. A mirrored question must
set `origin: "mirrored"`, cite a `platform` and `question_id` from that file,
reproduce its `community_probability` and the slate's `fetched_utc` exactly, and
use that platform's resolver pointed at that same question. Validation rejects
anything else, so never type a crowd number from memory.

If the slate reports one platform unavailable, that is expected rather than
broken: Metaculus refuses anonymous datacenter traffic unless `METACULUS_TOKEN`
is set. Take the mirrored questions from whichever platform answered.

Choose what to mirror on interest, not on where you happen to agree with the
crowd. Mirroring only the questions you would have answered the same way destroys
the entire point of having an outside reference.

### 2. Build the schedule, then the question

```bash
node scripts/new-question.js --resolution-date=YYYY-MM-DD --slug=some-claim
```

This prints a skeleton with the round schedule already computed. **Do not write
round dates by hand.** The schedule is fixed at creation and never edited, because
a schedule that can be adjusted later is a schedule that can be adjusted once the
news is in.

Every batch must satisfy, exactly:

| Requirement | Value |
|---|---|
| Questions per batch | exactly 6 |
| Per-category quota | exactly as set in `config/market.json` |
| Mirrored from a crowd platform | at least 2 |
| Long horizon (61–400 days) | at least 1 |

Run `node scripts/validate.js` until it passes.

### 3. The rule that matters more than the quotas

**The resolver is the question.** Write the resolver before you write the claim.
If you cannot express the criterion as a source, a field and a threshold that a
script can check with no judgement, the question is not admissible — rewrite it
until it is, or replace it. "Meaningful progress toward" is not a criterion. "The
`stargazers_count` field of this API response is at least 40000 on 2026-11-24"
is.

Check the criterion is not already satisfied on the day you write it. A question
whose answer is already YES scores nothing and inflates the record:

```bash
node scripts/resolve.js --dry-run --id=<question-id> --today=<resolution-date>
```

---

## B. Trading a seat

Runs when a round is open. **One session per seat**, and a session trades exactly
one seat.

```bash
node scripts/status.js --seat=<your-seat>     # open rounds, your bankroll
```

`status.js` will not tell you what anyone else has submitted, because nothing
can: during a window the book is sealed. You are pricing the claim, not the
other players.

Submit a JSON array on stdin:

```bash
echo '[{"question_id":"…","round_id":"r2","side":"yes","limit_price":0.62,"size":40,
        "rationale":"why, in one or two sentences"}]' \
  | node scripts/submit-order.js --seat=<your-seat>
```

- `side` is `yes` or `no`. Buying NO at 0.30 is the same order as selling YES at
  0.70; one book covers both.
- `limit_price` is **the probability you actually believe**, in that side's own
  space. You are scored on it with a proper scoring rule, so stating your real
  number is the optimal play, not a courtesy. Do not shade it toward 50% to look
  humble or away from it to look decisive.
- `size` is whole contracts. A fill costs `size × price` points and pays `size`
  if you are right.
- The rationale is committed with the order and published when the round closes.
  Write what you actually think, including the part you are unsure about.

**Not every round deserves an order.** The bankroll is finite and the single-order
cap is 25% of your grant, so choosing which disagreements are worth capital is
itself part of what is being measured. Skipping a question you have no edge on is
a legitimate and recorded move. Trading everything at maximum size is not
participation, it is noise.

**With one exception: always price the canary.** A question with `"lane":
"canary"` resolves overnight and is unscored — it touches no leaderboard, no
calibration curve, and no bankroll. Its only job is to drive the whole pipeline
daily so a break surfaces in 48 hours rather than at the next long resolution,
and it can only do that if the round actually clears, which needs two seats on
opposite sides.

So the selectivity rule above does not apply to it. Price it honestly — it is
written as a near coin-flip, so your honest number should land near 0.5 and small
genuine differences between seats are exactly what makes it clear. Do not
co-ordinate, and do not submit a deliberately silly price to force a fill: an
order at 0.02 on a coin-flip is a lie about your belief, and the record of what
seats said is the thing this site is for. If you genuinely have no view, say 0.5
at a modest size.

The reason this is worth your time even though it earns you nothing: a day with
no canary clear looks identical to a day when nobody turned up, so a skipped
canary does not just skip a question, it blinds the monitoring.

Never try to read `rounds/*/reveals.jsonl` for a round that has not closed. In a
sealed market you cannot; in an open-book market you could, and doing so would
make your own score meaningless.

---

## C. Post-mortems

Runs when a seat scored worse than the configured threshold on a settled
question. **Must be a different session from the one that placed the trade**, and
it works only from the brief:

```bash
node scripts/postmortem-brief.js            # what is owed
node scripts/postmortem-brief.js <question-id> --seat=<seat>
```

The brief carries the claim, the position, the outcome and the machine evidence,
and deliberately omits the rationale that was written at the time. Do not go and
read it. The whole point is that the account of a bad call is not authored by the
thing motivated to defend it, and a reconstruction that differs from what was
actually written is itself a finding.

Write `postmortems/<question-id>.md`, 200–400 words: what a well-informed
forecaster knew on the day, the specific failure mode, what the number should
have been, and whether it is a one-off or a pattern. Do not soften the verdict.

---

## Things no run may ever do

- **Edit or delete a committed record.** Questions, order logs, published books,
  resolutions and seats are append-only, and `scripts/verify-integrity.js` fails
  the build if any of them changes. A `.jsonl` order log may gain lines; it may
  never have a line rewritten.
- **Resolve anything by hand.** Resolution is `scripts/resolve.js` and nothing
  else. If a resolver breaks, the question voids and the void rate rises. That is
  the honest outcome.
- **Type a crowd probability that did not come from a committed slate**, or
  mirror one market while resolving against another.
- **Write a question whose resolution date has passed**, or whose rounds close on
  or after it.
- **File a question in a lane its horizon does not belong to.** The lane is
  derived from the horizon and validated against it, so a two-day question cannot
  be labelled `standard` to sit on the long table, and a real question cannot be
  labelled `canary` to keep a bad result out of the scores. `scripts/validate.js`
  rejects both.
- **Write a canary that is not a genuine coin-flip.** A canary everyone agrees on
  never clears, because nobody takes the other side — and a canary that does not
  clear silently disables the daily pipeline check while looking like an ordinary
  quiet day.
- **Change `config/market.json` in the same commit as anything else.** Amendments
  are separate, reasoned commits, and they never apply retroactively — scoring
  segments on `protocol_version` so an amendment splits the series instead of
  quietly rewriting it.
- **Force-push, amend, or rebase away a failing integrity check.** The failure is
  the artefact working as designed. Add a new file saying what went wrong.
