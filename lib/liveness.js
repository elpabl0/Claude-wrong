import { loadConfig, daysBetween } from './config.js';

/**
 * Is the machinery still running?
 *
 * Every scheduled job here can fail silently. A routine stops firing because a
 * subscription lapsed, a workflow breaks on a dependency, a token expires - and
 * the site carries on serving yesterday's numbers looking perfectly healthy.
 * The failure mode of an unattended system is not a crash, it is a quiet stall
 * that nobody notices for three weeks.
 *
 * So liveness is computed from the record itself and published on the front
 * page, where it is visible to anyone rather than only to whoever reads the
 * logs. If the market has stopped, the market says so.
 *
 * Deliberately derived from committed artefacts, not from a heartbeat the
 * monitoring writes itself: a heartbeat proves the heartbeat is running.
 */

const HOUR = 3600 * 1000;

export function liveness(market, { now = new Date() } = {}) {
  const config = market.config ?? loadConfig();
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const checks = [];

  const add = (id, label, ok, detail, severity = 'stalled') =>
    checks.push({ id, label, ok, detail, severity: ok ? 'ok' : severity });

  // Questions are written weekly. More than eight days without a batch means the
  // authoring run has stopped.
  const newest = market.questions.length
    ? market.questions.map((q) => q.question.created_utc).sort().at(-1)
    : null;
  if (!newest) {
    add('authoring', 'Questions written', false, 'No question has ever been written.', 'never-run');
  } else {
    const age = daysBetween(newest.slice(0, 10), today);
    add('authoring', 'Questions written', age <= 8, age <= 8
      ? `Last batch ${age} day(s) ago.`
      : `Last batch was ${age} days ago; questions are written weekly, so the authoring run has stopped.`);
  }

  // Rounds are cleared by a job running every six hours. A round more than twelve
  // hours past its close has not been picked up.
  const overdueRounds = market.roundsAwaitingClear.filter(
    ({ round }) => nowMs - Date.parse(round.closes_utc) > 12 * HOUR,
  );
  add('clearing', 'Rounds cleared', overdueRounds.length === 0,
    overdueRounds.length === 0
      ? `${market.roundsAwaitingClear.length} round(s) waiting, all within the six-hour cycle.`
      : `${overdueRounds.length} round(s) closed more than twelve hours ago and still not cleared: ${overdueRounds.map((r) => `${r.question.id}/${r.round.id}`).join(', ')}.`);

  // A question past its resolution date plus the grace period should have
  // resolved or voided. Still open means the resolver is not running.
  const stuck = market.awaitingResolution.filter(
    (q) => daysBetween(q.question.resolution_date, today) > config.resolution.grace_period_days,
  );
  add('resolution', 'Questions resolved', stuck.length === 0,
    stuck.length === 0
      ? 'Nothing is past its grace period.'
      : `${stuck.length} question(s) are past their resolution date plus the ${config.resolution.grace_period_days}-day grace period and have neither resolved nor voided: ${stuck.map((q) => q.question.id).join(', ')}.`);

  // Seats trade daily when a round is open. An open round with no commitments
  // and less than half its window left means nobody is showing up.
  const quiet = market.openRounds.filter(({ round }) => {
    const opened = Date.parse(round.opens_utc);
    const closes = Date.parse(round.closes_utc);
    return round.commitment_count === 0 && nowMs > opened + (closes - opened) / 2;
  });
  add('participation', 'Seats trading', quiet.length === 0,
    quiet.length === 0
      ? 'Open rounds have orders, or are early in their window.'
      : `${quiet.length} open round(s) are past halfway with no orders at all.`,
    'quiet');

  const stalled = checks.filter((c) => !c.ok);
  return {
    checked_utc: now.toISOString(),
    ok: stalled.length === 0,
    // "never-run" is a market that has not started; "stalled" is one that has stopped.
    state: stalled.length === 0 ? 'running' : stalled.some((c) => c.severity === 'never-run') ? 'not-started' : 'stalled',
    checks,
    stalled,
  };
}
