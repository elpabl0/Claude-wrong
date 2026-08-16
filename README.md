# wrong.aecs.io

A public forecasting ledger, kept by a language model.

Every week a scheduled instance publishes ten dated predictions, each with an
explicit probability, a resolution date, and a resolution criterion that a script
can check without asking it anything. A second scheduled job resolves them
mechanically against the source named in advance and recomputes the score. The
site shows open predictions, resolved ones, and a calibration curve that gets
less flattering or more flattering entirely on its own.

**Read the [methodology](docs/METHODOLOGY.md) for why, and the
[authoring protocol](docs/PROTOCOL.md) for the rules the writing instance works
under.**

## The idea in one paragraph

Benchmarks measure what a model knows, and contamination eventually eats all of
them. A prediction about a date that has not arrived yet cannot be contaminated,
because there is nothing to contaminate it with — nothing here about next year is
in anyone's training data. It also separates knowledge, which search supplies,
from judgement, which is the difference between saying 65% and saying 85%. Three
hypotheses about this model's judgement were pre-registered in
`config/ledger.json` before the first batch, each stated so that it can come out
against the model.

## What keeps it honest

| Risk | Control |
|---|---|
| Quietly softening a prediction after the fact | Records are append-only. `scripts/verify-integrity.js` walks the whole git history on every push and fails if any record was modified, deleted, added twice, or committed on or after its own resolution date. |
| Resolving ambiguously in your own favour | Resolution is a script with no discretion. Five mechanical resolver types only; a criterion that needs interpretation is not admissible. |
| Voiding the ones you got wrong | Void happens only when a source cannot be read for 14 days. It is recorded automatically with the failure log, and the void rate is on the front page. |
| Marking your own homework on a miss | Post-mortems are written by a separate instance from a brief that deliberately omits the original reasoning. |
| Grading on a curve of your own making | At least three questions per batch are mirrored from open Metaculus markets, scored against the community's probability from the same day. |
| Choosing easy questions | Category quotas, continuity-claim minimums, horizon minimums and a cap on near-certainties, all fixed in the repo before the first batch and enforced in CI. |
| Typing a flattering crowd number | The community probability must match a slate fetched by a script and committed before the batch was written. |
| The model changing mid-experiment | Every record logs its exact model string; every breakdown segments on it. |

## Layout

```
config/ledger.json         the fixed rules: quotas, hypotheses, grace periods
ledger/predictions/        one immutable JSON record per prediction
ledger/resolutions/        one record per resolved prediction, written by the resolver
ledger/attempts/           append-only log of every resolution attempt
ledger/mirror-slates/      Metaculus questions and crowd probabilities, as fetched
ledger/postmortems/        written by a different instance from the one that missed
lib/                       schema, resolvers, scoring, rendering. No dependencies.
scripts/                   validate · resolve · build · status · verify-integrity
docs/                      methodology and authoring protocol
```

There are no third-party dependencies anywhere, and no build toolchain. This is
meant to still work in a year without anyone tending it, so it uses nothing that
can rot.

## Running it

Node 20+, nothing to install.

```bash
npm test                    # unit tests
npm run validate            # schemas + batch quotas
npm run integrity           # append-only history check
npm run build               # generate ./site
npm run status              # what the next batch has to contain
npm run resolve             # resolve anything due (needs network)
npm run probe               # check open predictions' sources still respond
npm run check               # all of the above except resolve
```

To see what a resolver would do without writing anything:

```bash
node scripts/resolve.js --dry-run --id=<prediction-id> --today=<YYYY-MM-DD>
```

## The moving parts

Two automated jobs and one scheduled model run:

1. **`.github/workflows/slate.yml`** — Mondays 07:05 UTC. Fetches open Metaculus
   binary questions with their community probabilities and commits the slate. No
   model involved.
2. **A Claude routine, Mondays ~08:00 UTC** — reads `docs/PROTOCOL.md`, runs
   `scripts/status.js`, writes ten predictions against the quotas, and commits
   them. This is the only step with a model in it.
3. **`.github/workflows/daily.yml`** — 06:17 UTC daily. Resolves whatever is due,
   probes open sources, commits, and republishes the site. No model involved.

A fourth routine handles post-mortems, deliberately in a separate session from
the one that wrote the prediction.

## Deployment

The site is static, built by `scripts/build.js` into `site/` and published to
GitHub Pages by `.github/workflows/pages.yml`. `build.js` emits the `CNAME` file,
so the only manual steps are:

- **Settings → Pages → Source: GitHub Actions.**
- **DNS:** a `CNAME` record for `wrong` pointing at `elpabl0.github.io.`
- **Settings → Pages → Custom domain:** `wrong.aecs.io`, then enable *Enforce
  HTTPS* once the certificate is issued.

## A note on the score

At the time of writing there is no score, because nothing has resolved. The first
predictions have to come due before any of the numbers on the site mean anything,
and the front page says so rather than presenting an average over nine
resolutions as a finding. That is the honest state of a ledger that has not been
tested yet, and it is the reason this is worth running for a year rather than a
weekend.
