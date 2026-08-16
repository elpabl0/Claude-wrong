import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, daysBetween, horizonBucket, todayUTC } from './config.js';

function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const full = join(dir, f);
      try {
        return { file: f, path: full, record: JSON.parse(readFileSync(full, 'utf8')) };
      } catch (err) {
        throw new Error(`${full} is not valid JSON: ${err.message}`);
      }
    });
}

export function loadPredictionFiles() {
  return readJsonDir(paths.predictions);
}

export function loadResolutionFiles() {
  return readJsonDir(paths.resolutions);
}

export function loadPostmortems() {
  const out = new Map();
  if (!existsSync(paths.postmortems)) return out;
  for (const f of readdirSync(paths.postmortems).filter((f) => f.endsWith('.md')).sort()) {
    out.set(f.replace(/\.md$/, ''), readFileSync(join(paths.postmortems, f), 'utf8'));
  }
  return out;
}

/**
 * Load the whole ledger and join predictions to their resolutions.
 * `entry.state` is one of open | resolved | void | overdue.
 */
export function loadLedger({ config = loadConfig(), today = todayUTC() } = {}) {
  const resolutions = new Map(loadResolutionFiles().map(({ record }) => [record.id, record]));
  const postmortems = loadPostmortems();

  const entries = loadPredictionFiles().map(({ file, record }) => {
    const resolution = resolutions.get(record.id) ?? null;
    const horizonDays = daysBetween(record.batch, record.resolution_date);
    let state;
    if (resolution) state = resolution.status === 'void' ? 'void' : 'resolved';
    else state = record.resolution_date <= today ? 'overdue' : 'open';
    return {
      file,
      prediction: record,
      resolution,
      postmortem: postmortems.get(record.id) ?? null,
      state,
      outcome: resolution && resolution.status !== 'void' ? (resolution.status === 'yes' ? 1 : 0) : null,
      brier: resolution && typeof resolution.brier === 'number' ? resolution.brier : null,
      horizonDays,
      horizonBucket: horizonBucket(horizonDays, config),
      daysUntilResolution: daysBetween(today, record.resolution_date),
    };
  });

  entries.sort((a, b) => (a.prediction.batch < b.prediction.batch ? 1 : a.prediction.batch > b.prediction.batch ? -1 : a.prediction.id < b.prediction.id ? -1 : 1));

  const orphanResolutions = [...resolutions.keys()].filter(
    (id) => !entries.some((e) => e.prediction.id === id),
  );

  return {
    config,
    today,
    entries,
    byId: new Map(entries.map((e) => [e.prediction.id, e])),
    orphanResolutions,
    scored: entries.filter((e) => e.state === 'resolved'),
    open: entries.filter((e) => e.state === 'open'),
    overdue: entries.filter((e) => e.state === 'overdue'),
    voided: entries.filter((e) => e.state === 'void'),
  };
}

/** Group a batch of entries by their batch date, newest first. */
export function groupByBatch(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.prediction.batch)) map.set(e.prediction.batch, []);
    map.get(e.prediction.batch).push(e);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}
