#!/usr/bin/env node
/**
 * Resolve every prediction that has come due, mechanically.
 *
 * This script contains no judgement. It reads the resolver configuration that
 * was committed with the prediction - a named source and a threshold, both fixed
 * before the outcome was known - executes it, and writes the answer down.
 * Nothing here can decide that a question was "really" about something else.
 *
 *   node scripts/resolve.js              resolve everything due
 *   node scripts/resolve.js --probe      check that open predictions' sources still respond
 *   node scripts/resolve.js --dry-run    report what would happen, write nothing
 *   node scripts/resolve.js --id=<id>    operate on a single prediction
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC, daysBetween } from '../lib/config.js';
import { loadLedger } from '../lib/ledger.js';
import { getResolver, SourceError, CriterionError } from '../lib/resolvers/index.js';
import { brier } from '../lib/scoring.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const DRY = flag('dry-run');
const PROBE = flag('probe');
const ONLY = opt('id');
const CONCURRENCY = Number(opt('concurrency') ?? 4);

const config = loadConfig();
const today = opt('today') ?? todayUTC();
const attemptsDir = join(paths.root, 'ledger', 'attempts');

/** Run tasks with a small concurrency cap - these are other people's servers. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function logAttempt(id, entry) {
  if (DRY) return;
  mkdirSync(attemptsDir, { recursive: true });
  appendFileSync(join(attemptsDir, `${id}.jsonl`), JSON.stringify(entry) + '\n');
}

function readAttempts(id) {
  const f = join(attemptsDir, `${id}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { utc: null, outcome: 'unparseable', detail: line.slice(0, 200) };
      }
    });
}

function writeResolution(record) {
  const file = join(paths.resolutions, `${record.id}.json`);
  if (DRY) {
    console.log(`  would write ${file}`);
    return;
  }
  mkdirSync(paths.resolutions, { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}

function finalise(entry, { status, observed, detail, voidReason = null }) {
  const p = entry.prediction;
  const nowISO = new Date().toISOString();
  logAttempt(p.id, { utc: nowISO, outcome: status, detail });
  const record = {
    id: p.id,
    resolved_utc: nowISO,
    status,
    observed: observed ?? null,
    detail,
    resolver_type: p.resolver.type,
    model_at_prediction: p.model,
    probability: p.probability,
    brier: status === 'void' ? null : brier(p.probability, status === 'yes' ? 1 : 0),
    attempts: readAttempts(p.id),
  };
  if (status === 'void') record.void_reason = voidReason ?? detail;
  writeResolution(record);
  return record;
}

// ------------------------------------------------------------------ resolving
async function resolveOne(entry) {
  const p = entry.prediction;
  const impl = getResolver(p.resolver.type);
  if (!impl) {
    return finalise(entry, {
      status: 'void',
      observed: null,
      detail: `no implementation for resolver type \`${p.resolver.type}\``,
      voidReason: 'resolver type is no longer implemented',
    });
  }

  const daysLate = daysBetween(p.resolution_date, today);
  const graceExpired = daysLate > config.resolution.grace_period_days;

  let result;
  try {
    result = await impl.resolve(p.resolver, { env: process.env });
  } catch (err) {
    const detail = `${err.name}: ${err.message}`;
    logAttempt(p.id, { utc: new Date().toISOString(), outcome: 'error', detail });
    if (err instanceof CriterionError || graceExpired) {
      return finalise(entry, {
        status: 'void',
        observed: null,
        detail,
        voidReason:
          err instanceof CriterionError
            ? `the criterion itself was unusable: ${err.message}`
            : `the source could not be read for ${daysLate} days after the resolution date (grace period ${config.resolution.grace_period_days} days): ${err.message}`,
      });
    }
    console.log(`  ${p.id}: source unreadable, ${config.resolution.grace_period_days - daysLate} day(s) of grace left — ${err.message}`);
    return null;
  }

  if (result.status === 'pending') {
    logAttempt(p.id, { utc: new Date().toISOString(), outcome: 'pending', detail: result.detail });
    if (graceExpired) {
      return finalise(entry, {
        status: 'void',
        observed: result.observed ?? null,
        detail: result.detail,
        voidReason: `the source had still not resolved ${daysLate} days after the resolution date`,
      });
    }
    console.log(`  ${p.id}: still pending, ${config.resolution.grace_period_days - daysLate} day(s) of grace left`);
    return null;
  }

  return finalise(entry, result);
}

// -------------------------------------------------------------------- probing
async function probeOne(entry) {
  const p = entry.prediction;
  const impl = getResolver(p.resolver.type);
  const base = { id: p.id, type: p.resolver.type, resolution_date: p.resolution_date };
  if (!impl?.probe) return { ...base, ok: false, detail: 'resolver has no probe' };
  try {
    return { ...base, ok: true, detail: await impl.probe(p.resolver, { env: process.env }) };
  } catch (err) {
    return { ...base, ok: false, detail: `${err.name}: ${err.message}` };
  }
}

// ----------------------------------------------------------------------- main
const ledger = loadLedger({ config, today });
const select = (list) => (ONLY ? list.filter((e) => e.prediction.id === ONLY) : list);

if (PROBE) {
  const targets = select(ledger.open);
  console.log(`Probing ${targets.length} open prediction source(s)…`);
  const results = await pool(targets, CONCURRENCY, probeOne);
  const failures = results.filter((r) => !r.ok);
  const snapshot = {
    checked_utc: new Date().toISOString(),
    checked: results.length,
    failing: failures.length,
    results: results.sort((a, b) => Number(a.ok) - Number(b.ok) || a.resolution_date.localeCompare(b.resolution_date)),
  };
  if (!DRY) {
    mkdirSync(join(paths.root, 'ledger'), { recursive: true });
    writeFileSync(join(paths.root, 'ledger', 'probe-status.json'), JSON.stringify(snapshot, null, 2) + '\n');
  }
  for (const f of failures) console.warn(`  UNREACHABLE ${f.id} (${f.type}): ${f.detail}`);
  console.log(`${results.length - failures.length}/${results.length} sources reachable.`);
  // A failing probe is a warning, not a build failure: the source may simply be
  // down today, and the grace period exists precisely for that.
  process.exit(0);
}

const due = select(ledger.overdue);
if (due.length === 0) {
  console.log(`Nothing due as of ${today}. ${ledger.open.length} open, ${ledger.scored.length} resolved, ${ledger.voided.length} void.`);
  process.exit(0);
}

console.log(`${due.length} prediction(s) due as of ${today}${DRY ? ' (dry run)' : ''}:`);
const finals = (await pool(due, CONCURRENCY, resolveOne)).filter(Boolean);

for (const r of finals) {
  const mark = r.status === 'void' ? 'VOID' : r.status.toUpperCase();
  console.log(`  ${r.id}: ${mark}${r.brier === null ? '' : ` (p=${r.probability}, Brier ${r.brier.toFixed(4)})`} — ${r.detail}`);
}
console.log(`Resolved ${finals.length} of ${due.length} due; ${due.length - finals.length} still within the grace period.`);
