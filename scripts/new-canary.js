#!/usr/bin/env node
/**
 * Write today's canary. No model involved at any point.
 *
 * The canary exists to prove the whole pipeline still works - authored, opened,
 * sealed, cleared, resolved, settled - inside a single day. It was originally
 * written by a scheduled agent session, which was a mistake: it put the market's
 * most critical daily component on its least reliable and least observable
 * mechanism. On the first day the session fired, produced nothing, and left no
 * artefact to inspect, while the mechanical jobs beside it committed three times
 * without complaint.
 *
 * A canary needs no judgement. Rotate a city, read the forecast, set the
 * threshold to the forecast. That is a script, and a script belongs in the same
 * infrastructure as everything else here that has to be dependable.
 *
 * The threshold is set AT the forecast deliberately. The forecast is the
 * median estimate, so the honest probability of exceeding it is near a half -
 * which is exactly what a canary needs. A claim that is certainly true never
 * clears, because every seat bids the same side and nobody takes the other, and
 * a canary that does not clear silently disables the daily check while looking
 * like an ordinary quiet day.
 *
 *   node scripts/new-canary.js              write today's canary
 *   node scripts/new-canary.js --dry-run    print it and write nothing
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC } from '../lib/config.js';
import { buildSchedule } from './new-question.js';
import { validateQuestion } from '../lib/schema.js';

const config = loadConfig();
const DRY = process.argv.includes('--dry-run');
const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;

/**
 * Cities spread across enough longitudes that the 09:00-15:00 UTC round always
 * sits before the local afternoon peak somewhere plausible, and varied enough
 * that the canary is not the same question every morning. Rotated by day number
 * rather than at random, so a given date always produces the same city and the
 * run is reproducible.
 */
const CITIES = [
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Berlin', lat: 52.52, lon: 13.41 },
  { name: 'Madrid', lat: 40.42, lon: -3.7 },
  { name: 'Warsaw', lat: 52.23, lon: 21.01 },
  { name: 'Rome', lat: 41.9, lon: 12.5 },
  { name: 'Dublin', lat: 53.35, lon: -6.26 },
  { name: 'Helsinki', lat: 60.17, lon: 24.94 },
];

const today = arg('date', todayUTC());
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const dayNumber = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400000);
const city = CITIES[dayNumber % CITIES.length];

const url =
  `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
  `&daily=temperature_2m_max&start_date=${today}&end_date=${today}&timezone=UTC`;

/**
 * Fetch with a few backoffs. A shared-IP runner can pick up a 429 from a free
 * endpoint through no fault of its own, and a single transient failure must not
 * be able to skip a day of the market's only end-to-end check - that would be a
 * gap in the monitoring caused by the monitoring's own fragility.
 */
async function fetchWithRetry(target, { attempts = 4, waitMs = 2000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(target, { headers: { accept: 'application/json' } });
      if (r.ok) return r;
      last = `HTTP ${r.status}`;
      // 4xx other than rate limiting will not fix itself by waiting.
      if (r.status !== 429 && r.status < 500) break;
    } catch (err) {
      last = err.message;
    }
    if (i < attempts - 1) {
      const pause = waitMs * 2 ** i;
      console.error(`  ${last}; retrying in ${pause / 1000}s (${i + 1}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, pause));
    }
  }
  throw new Error(last ?? 'unreachable');
}

let doc;
try {
  doc = await (await fetchWithRetry(url)).json();
} catch (err) {
  // Deliberately no fallback to a claim that is certainly true. A canary that
  // cannot clear is worse than a missing canary, because a round that fails to
  // clear reads as "nobody turned up" rather than "the source was down".
  console.error(`Open-Meteo unreachable (${err.message}). Writing no canary today rather than writing one that cannot clear.`);
  process.exit(1);
}
const forecast = doc?.daily?.temperature_2m_max?.[0];
if (typeof forecast !== 'number') {
  console.error(`No forecast value at /daily/temperature_2m_max/0 for ${city.name} on ${today}. Writing no canary.`);
  process.exit(1);
}

const threshold = Math.round(forecast * 10) / 10;
const id = `${today}-canary-${city.name.toLowerCase()}-max-temp`;
const rounds = buildSchedule(today, tomorrow, config, 'canary');

if (!rounds.length) {
  console.error(`No canary round fits between ${today} and ${tomorrow}.`);
  process.exit(1);
}

// A canary written after its own window has shut can never be traded, so it
// would sit on the site looking live and quietly fail to clear - the exact
// appearance the canary exists to distinguish from. Refuse instead.
const closes = Date.parse(rounds[rounds.length - 1].closes_utc);
if (!DRY && Date.now() >= closes) {
  console.error(
    `The canary window for ${today} closed at ${rounds[rounds.length - 1].closes_utc} and it is now ${new Date().toISOString()}.\n` +
      '    Writing it now would publish a question nobody can trade, which fails to clear and looks identical to a day nobody turned up.\n' +
      '    Run this before the window opens; the schedule expects 07:10 UTC.',
  );
  process.exit(1);
}

const question = {
  id,
  created_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  author_model: 'none - written mechanically by scripts/new-canary.js',
  protocol_version: config.protocol_version,
  category: 'status-quo',
  lane: 'canary',
  origin: 'house',
  claim: `The maximum air temperature in ${city.name} on ${today} (UTC day) will be above ${threshold}°C.`,
  resolution_date: tomorrow,
  resolution_criterion:
    `YES if the value at JSON pointer /daily/temperature_2m_max/0 in the Open-Meteo response for ` +
    `latitude ${city.lat}, longitude ${city.lon}, start_date=${today}, end_date=${today}, timezone=UTC ` +
    `is strictly greater than ${threshold}. NO otherwise. The threshold was set to the forecast value ` +
    `published for ${today} at the time of writing, so the honest probability is close to a half. ` +
    `This is a canary: it is unscored and exists to exercise the pipeline daily.`,
  resolver: { type: 'json', url, pointer: '/daily/temperature_2m_max/0', op: '>', value: threshold },
  rounds,
  external_reference: null,
};

const { ok, errors } = validateQuestion(question, { filename: `questions/${id}.json` });
if (!ok) {
  console.error(`The generated canary does not validate:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

const file = join(paths.questions ?? join(paths.root, 'questions'), `${id}.json`);
if (existsSync(file)) {
  console.log(`${id} already exists. One canary a day; a second is not better than one.`);
  process.exit(0);
}

if (DRY) {
  console.log(JSON.stringify(question, null, 2));
  console.error(`\nDry run. ${city.name}, forecast ${forecast}°C, threshold ${threshold}°C, round ${rounds[0].opens_utc} → ${rounds[0].closes_utc}.`);
  process.exit(0);
}

mkdirSync(join(paths.root, 'questions'), { recursive: true });
writeFileSync(file, JSON.stringify(question, null, 2) + '\n');
console.log(`Wrote ${file}`);
console.log(`${city.name}: forecast ${forecast}°C, threshold ${threshold}°C — a coin flip by construction.`);
console.log(`Round ${rounds[0].id}: ${rounds[0].opens_utc} → ${rounds[0].closes_utc}, resolves ${tomorrow}.`);
