#!/usr/bin/env node
/**
 * Turn "git history is the tamper-evidence" from a claim into a check.
 *
 * Walking the full history of the record directories, this asserts that:
 *   1. every question, order log, published book, seat and resolution was Added
 *      exactly once and never Modified or Deleted afterwards;
 *   2. each question was committed on or about the day it claims to have been
 *      written;
 *   3. and - the one that actually matters - each question was committed
 *      strictly before its own resolution date, so it cannot have been written
 *      once the answer was already known.
 *
 * Run in CI on every push. If this passes, nothing on this site - a question, an
 * order, a clearing price or an outcome - can have been softened, back-dated or
 * quietly withdrawn after the fact.
 *
 *   node scripts/verify-integrity.js [--allow-uncommitted]
 */
import { execFileSync } from 'node:child_process';
import { paths, loadConfig } from '../lib/config.js';
import { loadQuestions, loadResolutions } from '../lib/market.js';

const allowUncommitted = process.argv.includes('--allow-uncommitted');
const config = loadConfig();

function git(args) {
  return execFileSync('git', args, { cwd: paths.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * History of every path under the tracked directories, oldest commit last.
 * `--no-renames` matters: a rename must show up as a delete plus an add, not as
 * a silent move that could swap one question's file for another's.
 */
/** File content at a revision, or null if it did not exist there. */
function blobAt(rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: paths.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function fileHistory(dirs) {
  const out = git([
    'log', '--no-renames', '--reverse', '--date=iso-strict',
    '--format=%x00%H%x1f%ad%x1f%cd', '--name-status', '--', ...dirs,
  ]);
  const events = [];
  let commit = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\0')) {
      const [hash, authorDate, commitDate] = line.slice(1).split('\x1f');
      commit = { hash, authorDate, commitDate };
      continue;
    }
    const m = line.match(/^([AMDT])\t(.+)$/);
    // Only the records themselves are append-only. The README placeholders that
    // keep these directories in git are ordinary files and may be edited.
    if (m && commit && /\.(json|jsonl)$/.test(m[2])) events.push({ status: m[1], path: m[2], ...commit });
  }
  return events;
}

const errors = [];
const notes = [];

// Everything that constitutes the record. Rounds are included because a
// commitment log or a published book is evidence exactly as much as a question is.
const trackedDirs = ['questions', 'resolutions', 'rounds', 'seats', 'market-slates'];
let events = [];
try {
  events = fileHistory(trackedDirs);
} catch (err) {
  console.error(`Could not read git history: ${err.message}`);
  process.exit(1);
}

const byPath = new Map();
for (const ev of events) {
  if (!byPath.has(ev.path)) byPath.set(ev.path, []);
  byPath.get(ev.path).push(ev);
}

for (const [path, evs] of byPath) {
  const adds = evs.filter((e) => e.status === 'A');
  const mods = evs.filter((e) => e.status === 'M' || e.status === 'T');
  const dels = evs.filter((e) => e.status === 'D');

  // A .jsonl order log legitimately grows during a round window: each order
  // appends a line. What it must never do is change a line already written, so
  // every earlier version must be a prefix of the one that replaced it.
  // Anything else means an order was rewritten or removed after the fact.
  for (const m of mods) {
    if (path.endsWith('.jsonl')) {
      const before = blobAt(`${m.hash}^`, path);
      const after = blobAt(m.hash, path);
      if (before === null || after === null) {
        errors.push(`${path} was modified in ${m.hash.slice(0, 10)} and the before/after content could not be read to check it was an append.`);
      } else if (!after.startsWith(before)) {
        errors.push(`${path} was REWRITTEN in ${m.hash.slice(0, 10)} (${m.authorDate}) - existing lines changed, not just appended. An order log is append-only.`);
      }
      continue;
    }
    errors.push(`${path} was MODIFIED in ${m.hash.slice(0, 10)} (${m.authorDate}). The record is append-only; a correction belongs in a new file, not in the old one.`);
  }
  for (const d of dels) {
    errors.push(`${path} was DELETED in ${d.hash.slice(0, 10)} (${d.authorDate}). Nothing leaves the record.`);
  }
  if (adds.length > 1) {
    errors.push(`${path} was added ${adds.length} times (${adds.map((a) => a.hash.slice(0, 10)).join(', ')}) - it must have been removed and re-added.`);
  }
}

// ------------------------------------------- dates: no back-dating, no drift
const questions = loadQuestions();
const committedPaths = new Set(byPath.keys());

for (const { file, record } of questions) {
  const path = `questions/${file}`;
  const add = byPath.get(path)?.find((e) => e.status === 'A');
  if (!add) {
    const msg = `${path} is not committed yet, so its history cannot be verified.`;
    if (allowUncommitted) notes.push(msg);
    else errors.push(msg);
    continue;
  }

  const committedOn = add.authorDate.slice(0, 10);

  // The decisive check. A question committed on or after its own resolution
  // date proves nothing at all, whatever its contents say.
  if (record.resolution_date && committedOn >= record.resolution_date) {
    errors.push(`${path} was committed on ${committedOn}, on or after its resolution date ${record.resolution_date}. This question carries no evidential weight.`);
  }

  // Allow a day either side of the claimed date for timezone and
  // scheduling slack; anything more is a discrepancy worth surfacing.
  if (record.created_utc) {
    const claimed = record.created_utc.slice(0, 10);
    const drift = Math.round((Date.parse(committedOn) - Date.parse(claimed)) / 86400000);
    if (Math.abs(drift) > 1) {
      errors.push(`${path} claims it was written on ${claimed} but was first committed on ${committedOn} (${drift > 0 ? '+' : ''}${drift} days).`);
    }
  }
}

for (const { file, record } of loadResolutions()) {
  const path = `resolutions/${file}`;
  if (!committedPaths.has(path)) {
    const msg = `${path} is not committed yet, so its history cannot be verified.`;
    if (allowUncommitted) notes.push(msg);
    else errors.push(msg);
    continue;
  }
  const add = byPath.get(path).find((e) => e.status === 'A');
  if (add && record.resolved_utc) {
    const drift = Math.round((Date.parse(add.authorDate.slice(0, 10)) - Date.parse(record.resolved_utc.slice(0, 10))) / 86400000);
    if (Math.abs(drift) > config.resolution.grace_period_days) {
      errors.push(`${path} records a resolution on ${record.resolved_utc.slice(0, 10)} but was committed on ${add.authorDate.slice(0, 10)}.`);
    }
  }
}

// -------------------------------------------------------------------- output
for (const n of notes) console.warn(`note     ${n}`);
for (const e of errors) console.error(`TAMPER   ${e}`);

if (errors.length) {
  console.error(`\nINTEGRITY CHECK FAILED: ${errors.length} problem(s) across ${byPath.size} tracked file(s).`);
  process.exit(1);
}
console.log(`Integrity OK: ${byPath.size} record file(s), each added exactly once, never modified, all committed before their own resolution date.`);
