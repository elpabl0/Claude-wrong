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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadConfig, todayUTC } from '../lib/config.js';
import { loadMarket } from '../lib/market.js';
import { leaderboard, errorCorrelationMatrix, crowdComparison, updateSpeed } from '../lib/scoring.js';
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
  bankrolls: [...market.bankrolls.values()],
  cross_model_error_correlation: errorCorrelationMatrix(market.positionsBySeat),
  crowd_comparison: crowdComparison(market.positionsBySeat, market.questionsById),
  update_speed: updateSpeed(market.positionsBySeat),
};

mkdirSync(paths.analysis, { recursive: true });
writeFileSync(join(paths.analysis, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2) + '\n');
console.log(`Wrote analysis/scoreboard.json: ${scoreboard.leaderboard.length} seat(s), ${scoreboard.counts.resolved} resolved.`);
