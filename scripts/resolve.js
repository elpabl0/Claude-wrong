#!/usr/bin/env node
/**
 * Resolve every question that has come due, mechanically.
 *
 * There is no judgement in this script. It reads the resolver that was committed
 * with the question - a named source, a field and a threshold, all fixed before
 * the answer was known - executes it, and writes down what it said. Nothing here
 * can decide that a question was "really" about something else.
 *
 *   node scripts/resolve.js              resolve everything due
 *   node scripts/resolve.js --probe      check open questions' sources still respond
 *   node scripts/resolve.js --dry-run    report, write nothing
 *   node scripts/resolve.js --id=<question-id>
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC, daysBetween } from '../lib/config.js';
import { loadMarket } from '../lib/market.js';
import { getResolver, CriterionError } from '../lib/resolvers/index.js';

const arg = (n, d = null) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const DRY = process.argv.includes('--dry-run');
const PROBE = process.argv.includes('--probe');
const ONLY = arg('id');
const CONCURRENCY = Number(arg('concurrency', '4'));

const config = loadConfig();
const today = arg('today', todayUTC());
const market = loadMarket({ config, today });

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function logAttempt(id, entry) {
  if (DRY) return;
  mkdirSync(paths.attempts, { recursive: true });
  appendFileSync(join(paths.attempts, `${id}.jsonl`), JSON.stringify(entry) + '\n');
}

function readAttempts(id) {
  const f = join(paths.attempts, `${id}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { utc: null, outcome: 'unparseable', detail: l.slice(0, 200) };
    }
  });
}

function finalise(q, { status, observed, detail, voidReason = null }) {
  const nowISO = new Date().toISOString();
  logAttempt(q.id, { utc: nowISO, outcome: status, detail });
  const record = {
    question_id: q.id,
    resolved_utc: nowISO,
    status,
    observed: observed ?? null,
    detail,
    resolver_type: q.resolver.type,
    protocol_version: q.protocol_version,
    attempts: readAttempts(q.id),
  };
  if (status === 'void') record.void_reason = voidReason ?? detail;
  if (DRY) {
    console.log(`  would write resolutions/${q.id}.json → ${status.toUpperCase()}`);
  } else {
    mkdirSync(paths.resolutions, { recursive: true });
    writeFileSync(join(paths.resolutions, `${q.id}.json`), JSON.stringify(record, null, 2) + '\n');
  }
  return record;
}

async function resolveOne(entry) {
  const q = entry.question;
  const impl = getResolver(q.resolver.type);
  if (!impl) {
    return finalise(q, { status: 'void', observed: null, detail: `no implementation for resolver type \`${q.resolver.type}\``, voidReason: 'resolver type is no longer implemented' });
  }

  const daysLate = daysBetween(q.resolution_date, today);
  const graceExpired = daysLate > config.resolution.grace_period_days;

  let result;
  try {
    result = await impl.resolve(q.resolver, { env: process.env });
  } catch (err) {
    const detail = `${err.name}: ${err.message}`;
    logAttempt(q.id, { utc: new Date().toISOString(), outcome: 'error', detail });
    if (err instanceof CriterionError || graceExpired) {
      return finalise(q, {
        status: 'void',
        observed: null,
        detail,
        voidReason:
          err instanceof CriterionError
            ? `the criterion itself was unusable: ${err.message}`
            : `the source could not be read for ${daysLate} days after the resolution date (grace period ${config.resolution.grace_period_days}): ${err.message}`,
      });
    }
    console.log(`  ${q.id}: source unreadable, ${config.resolution.grace_period_days - daysLate} day(s) of grace left — ${err.message}`);
    return null;
  }

  if (result.status === 'pending') {
    logAttempt(q.id, { utc: new Date().toISOString(), outcome: 'pending', detail: result.detail });
    if (graceExpired) {
      return finalise(q, { status: 'void', observed: result.observed ?? null, detail: result.detail, voidReason: `the source had still not resolved ${daysLate} days after the resolution date` });
    }
    console.log(`  ${q.id}: still pending, ${config.resolution.grace_period_days - daysLate} day(s) of grace left`);
    return null;
  }

  return finalise(q, result);
}

async function probeOne(entry) {
  const q = entry.question;
  const impl = getResolver(q.resolver.type);
  const base = { question_id: q.id, type: q.resolver.type, resolution_date: q.resolution_date };
  if (!impl?.probe) return { ...base, ok: false, detail: 'resolver has no probe' };
  try {
    return { ...base, ok: true, detail: await impl.probe(q.resolver, { env: process.env }) };
  } catch (err) {
    return { ...base, ok: false, detail: `${err.name}: ${err.message}` };
  }
}

const select = (list) => (ONLY ? list.filter((e) => e.question.id === ONLY) : list);

if (PROBE) {
  const targets = select(market.open);
  console.log(`Probing ${targets.length} open question source(s)…`);
  const results = await pool(targets, CONCURRENCY, probeOne);
  const failures = results.filter((r) => !r.ok);
  if (!DRY) {
    mkdirSync(paths.analysis, { recursive: true });
    writeFileSync(
      join(paths.analysis, 'source-health.json'),
      JSON.stringify({ checked_utc: new Date().toISOString(), checked: results.length, failing: failures.length, results: results.sort((a, b) => Number(a.ok) - Number(b.ok)) }, null, 2) + '\n',
    );
  }
  for (const f of failures) console.warn(`  UNREACHABLE ${f.question_id} (${f.type}): ${f.detail}`);
  console.log(`${results.length - failures.length}/${results.length} sources reachable.`);
  // A failing probe is a warning, not a build failure: the source may simply be
  // down today, which is exactly what the grace period is for.
  process.exit(0);
}

const due = select(market.awaitingResolution);
if (!due.length) {
  console.log(`Nothing due as of ${today}. ${market.open.length} open, ${market.resolved.length} resolved, ${market.voided.length} void.`);
  process.exit(0);
}

console.log(`${due.length} question(s) due as of ${today}${DRY ? ' (dry run)' : ''}:`);
const finals = (await pool(due, CONCURRENCY, resolveOne)).filter(Boolean);
for (const r of finals) console.log(`  ${r.question_id}: ${r.status.toUpperCase()} — ${r.detail}`);
console.log(`Resolved ${finals.length} of ${due.length} due; ${due.length - finals.length} still within the grace period.`);
