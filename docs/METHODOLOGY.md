# Methodology

This is a forecasting ledger. A language model publishes dated predictions with
explicit probabilities on a fixed schedule, and a script resolves them later
against sources and thresholds that were committed before the answer was known.
The score goes wherever it goes.

## Why bother

Benchmarks measure what a model knows. Almost all of them are, or eventually
become, contaminated: the answers exist somewhere in the training data. A
prediction about a date that has not happened yet cannot be contaminated, because
there is nothing to contaminate it with. That makes calibration on future events
one of the very few properties of a language model that can be measured cleanly,
and it will stay clean for as long as the questions keep pointing forward.

It also separates two things that get conflated. **Knowledge** is what a search
tool supplies. **Judgement** is the difference between saying 65% and saying 85%
once you already have the facts. Only the second is being measured here.

## What one prediction contains

Each record in `ledger/predictions/` is a JSON file that never changes after it
is committed. It carries:

- the **question**, stated so that a yes or no is possible;
- a **probability** of yes, strictly between 0.02 and 0.98 — a 0 or a 1 is not a
  forecast, and one bad extreme would dominate a year of scoring;
- a **resolution date**;
- a **resolution criterion** in plain English, and next to it a machine-readable
  **resolver** — a named source, a field, an operator and a threshold;
- the **reasoning** at the time;
- **what evidence would change my mind**, written before the evidence arrives;
- the exact **model string** that wrote it, and the **protocol version** in force.

The resolver is the part that matters. A criterion that needs someone to
interpret it is a criterion that can be interpreted favourably later. Six
resolver types are permitted, all of them mechanical: the resolution of a
Metaculus question or a Manifold market, a value at a JSON pointer compared to a
threshold, the existence of a matching release tag on GitHub, a pattern in the
visible text of a page, and a count of arXiv submissions matching a fixed query.

## How resolution works

A scheduled job runs every day, finds the predictions that have come due, and
executes their resolvers. It has no discretion. It reads what was written down,
fetches the source, applies the comparison, records the answer and the evidence,
and computes the Brier score.

If a source cannot be read, the job records the failure and retries the next day.
After 14 days of failure the prediction goes **void**: excluded from the score,
but kept, displayed, and counted. The void rate is on the front page, because a
forecaster who could quietly void its losses would have no score worth reading.
Voiding is never a decision — it is what happens when a URL dies.

## How it is scored

The **Brier score** is `(probability − outcome)²`, averaged. Lower is better;
0.25 is what you get by always saying 50%.

That single number hides too much, so the site also publishes:

- a **reliability diagram** — forecasts binned by probability, plotted against
  how often those things actually happened, with Wilson intervals so that a bin
  holding four questions does not look like evidence;
- **Murphy's decomposition** of the Brier score into reliability (calibration),
  resolution (discrimination) and uncertainty (question difficulty), which is
  what separates *well calibrated but uninformative* from *informative but
  overconfident*;
- **skill against a base-rate forecaster** — one that always predicts the
  observed frequency of the group. Beating a coin is easy. Beating the base rate
  is the test;
- breakdowns by category, claim type, time horizon, question origin, model
  string and protocol version.

## The three controls

**Git history is the tamper-evidence.** Records are append-only. On every push,
`scripts/verify-integrity.js` walks the entire history of `ledger/` and fails the
build if any prediction or resolution file was modified, deleted, added twice, or
committed on or after its own resolution date. A prediction cannot be softened,
back-dated or withdrawn, and this is enforced by a check rather than promised in
a paragraph.

**Post-mortems are written by a different instance.** When a forecast scores
worse than a coin flip, `scripts/postmortem-brief.js` produces a brief containing
the question, the probability, the outcome and the machine evidence — and
deliberately *not* the original reasoning. A fresh instance writes the analysis
from that. It cannot reconstruct and then defend the original argument, because
it has never seen it.

**A fixed share of questions is mirrored from a human crowd.** At least three of
every ten come from open Metaculus questions or Manifold markets, with the
community's probability recorded on the same day. Both forecasts are then scored
on the same outcome. This is the only comparison here that is not
self-referential. The crowd's number is fetched by a script into a committed
slate, and validation rejects any mirrored prediction whose recorded community
probability does not match that slate exactly — so the questions can be chosen,
but the benchmark cannot.

Two platforms are supported because one of them is not reliably reachable.
Metaculus is the better benchmark — real forecasters, real reputations — but its
API returns 403 or 429 to datacenter traffic unless an API token is configured,
and a ledger that resolves itself on a schedule cannot depend on a source that
refuses its own runner. Manifold's API is open and its markets carry enough
traders to be a real opponent. The slate takes whichever answers, records which
platform each question came from, and the scoring reports the two separately as
well as together.

## Guarding against a flattering question set

The obvious way to make a ledger like this look good is to choose easy questions.
The rules that prevent it are in `config/ledger.json`, were fixed before the first
batch, and are enforced by `scripts/validate.js` on every push. Each batch of ten
must contain an exact quota per category, at least three continuity claims, at
least three mirrored questions, at least two short-horizon and two long-horizon
questions, and no more than three predictions outside the 10–90% range.

Changing any of that is a protocol amendment: it is committed on its own, with a
rationale, it does not apply retroactively, and the scoring segments on the
protocol version so an amendment splits the series instead of quietly rewriting
it.

## The pre-registered hypotheses

Three claims about this model's behaviour were written down before the first
batch, in a form that can come out against it.

**H1 — overconfident on technology timelines.** On AI-capability questions that
assert a change, mean predicted probability should exceed observed frequency.

**H2 — underconfident about continuity.** On questions asserting that the world
stays as it is, observed frequency should exceed mean predicted probability. This
is why every batch is required to contain continuity claims: they are the control
arm, and without a quota they would simply never get written.

**H3 — worse than the crowd.** On mirrored questions, paired against the human
forecasting community on the same day, the model's Brier score should be higher.

Each is reported with a 95% interval and marked *supported*, *contradicted*,
*undecided* or *not enough data yet*. Twenty resolutions are needed before any of
them is worth reading, and the intervals assume independent questions, which
questions written in the same batch about related subjects are not. They are a
guide to whether an effect is worth talking about, not a p-value.

## Known limitations

- **Small samples for a long time.** Ten questions a week means the first
  meaningful breakdowns are months away. The site says so on its face rather than
  presenting a mean over nine resolutions as a result.
- **Question selection is still a choice.** Quotas constrain the shape of a
  batch, not the difficulty of the questions inside it. The mirrored slice exists
  precisely because it is the part the forecaster cannot make easier.
- **Model versioning is a real confound.** If the underlying model changes
  mid-experiment, the series is measuring two different things. Every record logs
  its exact model string and every breakdown segments on it, but a change still
  costs statistical power.
- **Resolver brittleness.** A JSON endpoint can change shape and a page can be
  rewritten. A live self-test exercises every resolver type against a known-good
  source on each push, precisely because that failure is otherwise silent. A live self-test exercises every resolver type against a known-good
  source on each push, precisely because that failure is otherwise silent. Open predictions have their sources probed on a schedule so that a
  dead source surfaces early rather than at resolution time, but the risk is real
  and the void rate is where it will show up.
- **Correlated questions.** Ten questions written in one sitting by one model are
  not ten independent draws. Confidence intervals are optimistic in the same way
  a poll's margin of error is.
