#!/usr/bin/env node
/**
 * Scaffold a question with its round schedule already computed.
 *
 * The round schedule is fixed at creation and never edited afterwards, because a
 * schedule that could be adjusted later is a schedule that could be adjusted
 * once the news is in. This computes it from the resolution date so the
 * authoring instance does not do date arithmetic by hand and quietly get it
 * wrong.
 *
 *   node scripts/new-question.js --resolution-date=2026-12-15 --slug=some-claim
 *   node scripts/new-question.js --resolution-date=2026-12-15 --slug=x --schedule-only
 */
import { pathToFileURL } from 'node:url';
import { loadConfig, todayUTC } from '../lib/config.js';

const config = loadConfig();

/**
 * Which lane a question belongs to, from its horizon.
 *
 * Declared by horizon rather than chosen by the author, so the lane cannot be
 * picked to flatter a result: a two-day question is a short-lane question
 * whatever anyone would prefer it to be.
 */
export function laneFor(horizonDays, cfg = config) {
  for (const [id, lane] of Object.entries(cfg.lanes ?? {})) {
    if (id.startsWith('_')) continue; // config comments live alongside the data
    const [lo, hi] = lane.horizon_days;
    if (horizonDays >= lo && horizonDays <= hi) return id;
  }
  return 'standard';
}

/**
 * Rounds sit at fixed distances before resolution, tightening as the date
 * approaches. Anything that would open before the question exists is dropped, so
 * a short-horizon question simply gets fewer rounds rather than a squashed
 * schedule.
 *
 * The ladder comes from the question's lane. The standard ladder starts at
 * ninety days out, so applied to a three-day question every rung would be
 * filtered away and the question would exist with no rounds at all - written,
 * listed, and impossible to trade. Picking the ladder by lane is what stops that.
 */
export function buildSchedule(createdDate, resolution, cfg = config, lane = null) {
  const resolveAt = Date.parse(`${resolution}T00:00:00Z`);
  const createdAt = Date.parse(`${createdDate}T00:00:00Z`);
  const horizon = Math.round((resolveAt - createdAt) / 86400000);
  const laneId = lane ?? laneFor(horizon, cfg);
  const ladder = cfg.rounds.ladders?.[cfg.lanes?.[laneId]?.ladder ?? 'standard'] ?? {
    t_minus_days: cfg.rounds.schedule_t_minus_days,
    window_hours: cfg.rounds.window_hours,
  };
  const windowMs = (ladder.window_hours ?? cfg.rounds.window_hours) * 3600 * 1000;

  return ladder.t_minus_days
    .slice()
    .sort((a, b) => b - a)
    .map((t) => {
      const opens = new Date(resolveAt - t * 86400000);
      opens.setUTCHours(9, 0, 0, 0);
      return { t_minus_days: t, opensMs: opens.getTime() };
    })
    // A round must open strictly after the question is public, and close before
    // the resolution date - otherwise it would be trading on a known answer.
    .filter((r) => r.opensMs > createdAt && r.opensMs + windowMs < resolveAt)
    .map((r, i) => ({
      id: `r${i + 1}`,
      t_minus_days: r.t_minus_days,
      opens_utc: new Date(r.opensMs).toISOString().replace(/\.\d+Z$/, 'Z'),
      closes_utc: new Date(r.opensMs + windowMs).toISOString().replace(/\.\d+Z$/, 'Z'),
    }));
}

/* -------------------------------------------------------------------- CLI
 * Guarded so that importing buildSchedule - which the tests do - does not run
 * the command line. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) {
  // Imported as a library; nothing else to do.
} else {
const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const created = arg('created', todayUTC());
const resolutionDate = arg('resolution-date');
const slug = arg('slug', 'CHANGE-ME');

if (!resolutionDate || !/^\d{4}-\d{2}-\d{2}$/.test(resolutionDate)) {
  console.error('usage: node scripts/new-question.js --resolution-date=YYYY-MM-DD [--slug=some-claim] [--created=YYYY-MM-DD]');
  process.exit(2);
}

const horizonDays = Math.round((Date.parse(`${resolutionDate}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`)) / 86400000);
const lane = arg('lane', laneFor(horizonDays));
const rounds = buildSchedule(created, resolutionDate, config, lane);

if (process.argv.includes('--schedule-only')) {
  console.log(JSON.stringify(rounds, null, 2));
  process.exit(0);
}

if (!rounds.length) {
  console.error(
    `No round fits between ${created} and ${resolutionDate} on the ${lane} ladder ` +
      `(${config.rounds.ladders[config.lanes[lane].ladder].t_minus_days.join(', ')} days out).\n` +
      'A question nobody can trade is worse than no question: it appears on the site, looks live, and silently never clears.',
  );
  process.exit(1);
}

const skeleton = {
  id: `${created}-${slug}`,
  created_utc: `${created}T09:00:00Z`,
  author_model: '<the exact model string you are running as>',
  protocol_version: config.protocol_version,
  category: `<one of: ${Object.keys(config.questions.categories).join(', ')}>`,
  lane,
  origin: 'house',
  claim: '<a binary claim, stated so that YES or NO is the only possible answer>',
  resolution_date: resolutionDate,
  resolution_criterion:
    '<plain English: exactly what counts as YES, naming the source and the threshold. If it needs interpretation it is not a valid question.>',
  resolver: {
    type: '<metaculus | manifold | json | github_release | http_text | arxiv>',
    _comment: 'A named source, a field, and a threshold. Checkable by a script with no judgement at resolution time.',
  },
  rounds,
  external_reference: null,
};

console.log(JSON.stringify(skeleton, null, 2));
console.error(
  `\n${lane} lane, ${horizonDays}-day horizon, ${config.lanes[lane].scored ? 'scored' : 'UNSCORED'}.\n` +
    `${rounds.length} round(s) scheduled: ${rounds.map((r) => `${r.id} at T-${r.t_minus_days}`).join(', ')}.\n` +
    `Write this to questions/${skeleton.id}.json, fill in every angle-bracketed field, then run node scripts/validate.js.`,
);
}
