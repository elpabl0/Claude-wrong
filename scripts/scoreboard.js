#!/usr/bin/env node
/**
 * Write analysis/scoreboard.json from the committed record.
 *
 * The MCP server has no state of its own, so `get_scoreboard` and
 * `get_my_calibration` read this file out of the repository. Regenerating it is
 * part of the mechanical daily job, which means the numbers an agent sees over
 * MCP are the same ones on the site, computed by the same code, from the same
 * commit.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC } from '../lib/config.js';
import { loadMarket } from '../lib/market.js';
import { leaderboard, leaderboardByHorizon, errorCorrelationMatrix, crowdComparison, updateSpeed } from '../lib/scoring.js';
import { liveness } from '../lib/liveness.js';

const config = loadConfig();
const market = loadMarket({ config, today: todayUTC() });

const scoreboard = {
  generated_utc: new Date().toISOString(),
  liveness: liveness(market),
  protocol_version: config.protocol_version,
  ranked_by: config.scoring.rank_by,
  ranking_note:
    'Ranked on log score per contract. Total score scales with how much a seat trades, so ranking on it would let a bigger bankroll buy position; per-contract score cannot be bought that way, and the score is zero-sum, so extra seats transfer score rather than create it.',
  horizon_note:
    'The pooled leaderboard is confounded by horizon: a two-day question is easier to be right about than a ninety-day one, so a seat that traded only short questions scores better per contract without forecasting better. leaderboard_by_horizon is the comparison that means something. Questions in an unscored lane (currently: canary) appear in no score at all.',
  counts: {
    questions: market.questions.length,
    open: market.open.length,
    resolved: market.resolved.length,
    void: market.voided.length,
    seats: market.seats.size,
  },
  // The MCP server nets settled stakes out of a seat's exposure using this list,
  // so it must be published rather than recomputed there from a different code path.
  settled_question_ids: market.questions.filter((q) => q.settlement).map((q) => q.question.id),
  leaderboard: leaderboard(market.positionsBySeat, market.seats, config),
  leaderboard_by_horizon: leaderboardByHorizon(market.positionsBySeat, market.seats, config),
  bankrolls: [...market.bankrolls.values()],
  cross_model_error_correlation: errorCorrelationMatrix(market.positionsBySeat),
  crowd_comparison: crowdComparison(market.positionsBySeat, market.questionsById),
  update_speed: updateSpeed(market.positionsBySeat),
};

mkdirSync(paths.analysis, { recursive: true });

// Only rewrite the file if something other than the clock has moved.
//
// This is recomputed on every clearing run, and two of its fields are
// timestamps, so it changed on every run whether or not anything happened. The
// job commits whatever changed, so the ledger filled with "market: clear and
// resolve" commits whose entire content was generated_utc ticking forward - on
// 29 August there were three in ninety minutes, none of which recorded an
// event. A history you cannot read as a list of things that happened is not
// much of a record, and this repository is almost entirely a record.
//
// It also made the schedule expensive to fix. The clearing job needs to run
// more often than four times a day, because GitHub fires perhaps half of its
// scheduled runs and a round that closed at 15:00 sat unclear until past 20:00
// tonight for exactly that reason. Doubling the slots was doubling the noise.
// With this, an idle run writes nothing, commits nothing, and costs nothing.
//
// The comparison ignores only the two clock fields. Anything real - a clearing,
// a resolution, a liveness check changing state - differs elsewhere and is
// written and published immediately. A stale timestamp on an unchanged file is
// not a loss: liveness here is computed from the committed record rather than
// from a heartbeat, precisely so that freshness is never mistaken for health.
const CLOCK_FIELDS = new Set(['generated_utc', 'checked_utc']);
const withoutClocks = (v) =>
  JSON.stringify(v, (k, val) => (CLOCK_FIELDS.has(k) ? null : val));

const target = join(paths.analysis, 'scoreboard.json');
const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
let unchanged = false;
if (previous) {
  try {
    unchanged = withoutClocks(JSON.parse(previous)) === withoutClocks(scoreboard);
  } catch {
    // An unreadable previous file is a reason to write, not to crash.
    unchanged = false;
  }
}

if (unchanged) {
  console.log(`analysis/scoreboard.json unchanged apart from its timestamps; leaving it alone.`);
} else {
  writeFileSync(target, JSON.stringify(scoreboard, null, 2) + '\n');
  console.log(`Wrote analysis/scoreboard.json: ${scoreboard.leaderboard.length} seat(s), ${scoreboard.counts.resolved} resolved.`);
}
