# Authoring protocol

These are the standing instructions for the scheduled instance that writes a
batch. They are in the repository, not in the schedule, so that what a batch has
to contain is decided once and in public rather than every Monday in private.

If you are that instance: follow this exactly. Where it constrains you, the
constraint is the point.

## 0. Orient

```bash
node scripts/status.js          # what the protocol requires of this batch
node scripts/status.js --json   # the same, machine-readable
```

`status.js` tells you the batch date, how many predictions are still needed in
each category, which minimums are outstanding, which post-mortems are owed, and
which sources have stopped responding. Read the `recent_questions` list before
writing anything: a batch that quietly re-asks a question already on the books is
padding the sample, not adding to it.

## 1. Fetch the Metaculus slate first

```bash
node scripts/mirror-candidates.js --batch=<YYYY-MM-DD>
```

Do this **before** writing any mirrored question. It writes
`ledger/mirror-slates/<batch>.json` containing the open binary questions and the
community probability as fetched today. Every mirrored prediction must cite a
`post_id` from that file and reproduce its `community_probability` and the
slate's `fetched_utc` exactly. Validation rejects anything else, so do not type a
crowd number from memory — you will only fail the build.

Choose the questions you mirror on interest, not on where you happen to agree
with the crowd. Mirroring only the ones you would have answered the same way
destroys the entire point of having an outside reference.

## 2. Write the batch

Ten predictions, one JSON file each, at
`ledger/predictions/<batch>-<slug>.json`. The slug is lowercase, hyphenated, and
describes the question rather than the answer.

```json
{
  "id": "2026-08-24-eu-ai-act-gpai-guidance",
  "batch": "2026-08-24",
  "created_utc": "2026-08-24T09:14:03Z",
  "model": "<the exact model string you are running as>",
  "protocol_version": 1,
  "category": "geopolitics",
  "claim_type": "change",
  "origin": "self",
  "question": "Will …?",
  "probability": 0.35,
  "resolution_date": "2026-11-24",
  "resolution_criterion": "Plain-English statement of exactly what counts as YES, naming the source.",
  "resolver": { "type": "json", "url": "https://…", "pointer": "/…", "op": ">=", "value": 100 },
  "reasoning": "What you actually think and why, in the present tense.",
  "evidence_that_would_move_me": ["…", "…"],
  "external_reference": null
}
```

Every batch must satisfy, exactly:

| Requirement | Value |
|---|---|
| Predictions per batch | exactly 10 |
| Per-category quota | exactly as set in `config/ledger.json` |
| Continuity claims | at least 3 |
| Mirrored from Metaculus | at least 3 |
| Horizon ≤ 30 days | at least 2 |
| Horizon 121–400 days | at least 2 |
| Probabilities outside 10–90% | at most 3 |
| Any probability | strictly inside [0.02, 0.98] |

Run `node scripts/validate.js` until it passes. It enforces all of the above.

## 3. Rules that matter more than the quotas

**The resolver is the prediction.** Write the resolver before you write the
probability. If you cannot express the criterion as a source, a field and a
threshold that a script can check with no judgement, the question is not
admissible — rewrite it until it is, or replace it. "Meaningful progress toward"
is not a criterion. "The `stargazers_count` field of this API response is at
least 40000 on 2026-11-24" is.

**Check the criterion is not already satisfied.** A question whose answer is
already YES on the day it is written scores nothing and inflates the record. For
`http_text` this is a required field; for everything else, check it yourself by
running the resolver:

```bash
node scripts/resolve.js --dry-run --id=<id> --today=<resolution_date>
```

**Continuity claims are not filler.** They are the control arm for H2, and the
temptation will be to write three trivially-true ones at 97% and move on. Do not.
A continuity claim should name something that a reasonable person might expect to
change in the window and assert that it will not. If you would not be at all
surprised to be wrong, the probability should not be 0.95.

**State the probability you believe, then leave it.** Do not round toward 50% to
look humble, and do not round away from it to look decisive. The whole artefact
is worthless if the numbers are chosen for how they will read.

**Reasoning is a trace, not an argument.** Say what you actually think, including
the part you are unsure about. It will be compared against a post-mortem written
by an instance that cannot see it.

## 4. Post-mortems

```bash
node scripts/postmortem-brief.js            # what is owed
node scripts/postmortem-brief.js <id>       # the brief for one
```

Anything that scored worse than 0.25 gets one. **A post-mortem must be written by
a different session from the one that made the forecast**, working only from the
brief — which deliberately omits the original reasoning. If you are the authoring
instance and you can see the reasoning of the prediction you are about to analyse,
you are the wrong instance for that job; leave it for the post-mortem run.

Write to `ledger/postmortems/<id>.md`.

## 5. Commit

One commit per batch, and nothing else in it.

```
predictions: batch <YYYY-MM-DD>

10 predictions, protocol v1, model <exact model string>.
Categories: …
Mirrored: <n> from slate <fetched_utc>.
```

The model string in the commit message must match the `model` field in every
record. If the model has changed since the last batch, say so in the message: the
analysis segments on it, and a silent change is the single most damaging thing
that can happen to this series.

Then push. CI runs `validate`, `verify-integrity` and the unit tests, and
publishes the site. If `verify-integrity` fails, **do not amend or force-push** —
the failure is the artefact working as designed. Add a new file that says what
went wrong.

## 6. Things you must never do

- Edit or delete a prediction or resolution file after it is committed. If a
  question turns out to be ambiguous, let it resolve or void as written and say
  so in a post-mortem. The ledger records what was actually predicted, including
  the badly-written ones.
- Write a prediction whose resolution date has already passed.
- Type a Metaculus community probability that did not come out of a committed
  slate.
- Resolve a prediction by hand. Resolution is `scripts/resolve.js` and nothing
  else. If a resolver is broken, the prediction voids and the void rate rises.
  That is the honest outcome.
- Change `config/ledger.json` in the same commit as a batch. Amendments are
  separate, reasoned commits, and they never apply retroactively.
